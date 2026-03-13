import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

/**
 * XTerm terminal component that connects to the harness WebSocket.
 */
const TerminalView = forwardRef(function TerminalView({ session, onMiddlewareEvent, onSessionUpdate }, ref) {
    const termRef = useRef(null);
    const termInstance = useRef(null);
    const fitAddon = useRef(null);
    const wsRef = useRef(null);
    const codexInputNoticeShown = useRef(false);

    // Stable refs for callbacks — avoids re-render reconnection loops
    const onMiddlewareEventRef = useRef(onMiddlewareEvent);
    const onSessionUpdateRef = useRef(onSessionUpdate);
    onMiddlewareEventRef.current = onMiddlewareEvent;
    onSessionUpdateRef.current = onSessionUpdate;

    // Expose stop method to parent
    useImperativeHandle(ref, () => ({
        stop: () => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ action: 'stop', sessionId: session?.id }));
            }
        },
    }));

    // Connect when session changes (stable dep: session.id only)
    useEffect(() => {
        if (!session) return;

        // Create terminal
        const term = new Terminal({
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 13,
            lineHeight: 1.4,
            theme: {
                background: '#0c0c0c',
                foreground: '#e2e8f0',
                cursor: '#60a5fa',
                cursorAccent: '#0c0c0c',
                selectionBackground: 'rgba(59, 130, 246, 0.3)',
                black: '#1e293b',
                red: '#ef4444',
                green: '#22c55e',
                yellow: '#facc15',
                blue: '#3b82f6',
                magenta: '#a855f7',
                cyan: '#06b6d4',
                white: '#e2e8f0',
                brightBlack: '#64748b',
                brightRed: '#f87171',
                brightGreen: '#4ade80',
                brightYellow: '#fde047',
                brightBlue: '#60a5fa',
                brightMagenta: '#c084fc',
                brightCyan: '#22d3ee',
                brightWhite: '#f8fafc',
            },
            cursorBlink: true,
            cursorStyle: 'bar',
            scrollback: 5000,
            convertEol: true,
        });

        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());

        term.open(termRef.current);
        fit.fit();

        termInstance.current = term;
        fitAddon.current = fit;

        const isLiveSession = session.state === 'created' || session.state === 'running';
        if (!isLiveSession) {
            term.writeln(`\x1b[90m[harness] Session is ${session.state}. Live stream is unavailable.\x1b[0m`);

            const handleResize = () => {
                if (fitAddon.current) fitAddon.current.fit();
            };
            window.addEventListener('resize', handleResize);
            const fitTimer = setTimeout(() => fit.fit(), 150);

            return () => {
                clearTimeout(fitTimer);
                window.removeEventListener('resize', handleResize);
                term.dispose();
            };
        }

        // Connect WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const ws = new WebSocket(`${protocol}//${host}/api/harness/stream`);
        wsRef.current = ws;

        ws.onopen = () => {
            term.writeln('\x1b[90m[harness] Connecting to session...\x1b[0m');
            if (session.tool === 'codex') {
                term.writeln('\x1b[90m[harness] Codex runs in non-interactive exec mode for this session.\x1b[0m');
            }
            ws.send(JSON.stringify({
                action: 'init',
                tool: session.tool,
                task: session.task,
                contextDir: session.contextDir,
                sessionId: session.id,
                mode: session.mode,
                timeBudgetMs: session.timeBudgetMs,
            }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                switch (msg.type) {
                    case 'output':
                        term.write(msg.data);
                        break;
                    case 'session':
                        term.writeln(`\x1b[90m[harness] Session ${msg.session.id} (${msg.session.mode} mode)\x1b[0m`);
                        term.writeln(`\x1b[90m[harness] Middleware: ${msg.session.middleware.join(', ')}\x1b[0m`);
                        term.writeln('');
                        onSessionUpdateRef.current?.(msg.session);
                        break;
                    case 'exit':
                        term.writeln('');
                        term.writeln(`\x1b[90m[harness] Session ended (exit code: ${msg.code})\x1b[0m`);
                        onSessionUpdateRef.current?.({ state: (msg.code === 0 || msg.code === null) ? 'completed' : 'failed' });
                        break;
                    case 'error':
                        term.writeln(`\x1b[31m[harness] Error: ${msg.error}\x1b[0m`);
                        if (typeof msg.error === 'string' && msg.error.startsWith('Session is in state:')) {
                            const state = msg.error.split(':').pop()?.trim();
                            if (state) {
                                onSessionUpdateRef.current?.({ state });
                                break;
                            }
                        }
                        onSessionUpdateRef.current?.({ state: 'failed' });
                        break;
                    case 'input_disabled':
                        term.writeln('\x1b[90m[harness] Input disabled for this session.\x1b[0m');
                        break;
                    default:
                        if (msg.middleware) {
                            onMiddlewareEventRef.current?.(msg);
                        }
                }
            } catch {
                term.write(event.data);
            }
        };

        ws.onclose = () => {
            term.writeln('\x1b[90m[harness] Connection closed\x1b[0m');
        };

        ws.onerror = () => {
            term.writeln('\x1b[31m[harness] WebSocket error\x1b[0m');
        };

        // Forward terminal input to WebSocket
        term.onData((data) => {
            if (session.tool === 'codex') {
                if (!codexInputNoticeShown.current) {
                    term.writeln('\r\n\x1b[90m[harness] This Codex run is non-interactive; input is ignored.\x1b[0m');
                    codexInputNoticeShown.current = true;
                }
                return;
            }
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'input',
                    sessionId: session.id,
                    data,
                }));
            }
        });

        // Handle window resize
        const handleResize = () => {
            if (fitAddon.current) fitAddon.current.fit();
        };
        window.addEventListener('resize', handleResize);

        // Delayed fit to account for layout settling
        const fitTimer = setTimeout(() => fit.fit(), 150);

        return () => {
            clearTimeout(fitTimer);
            window.removeEventListener('resize', handleResize);
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
            term.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session?.id]);

    return <div ref={termRef} style={{ width: '100%', height: '100%' }} />;
});

export default TerminalView;
