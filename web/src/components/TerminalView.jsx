import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

/**
 * XTerm terminal component that connects to the harness WebSocket.
 */
const TerminalView = forwardRef(function TerminalView({ session, onMiddlewareEvent, onSessionUpdate }, ref) {
    const MAX_BUFFERED_OUTPUT_CHARS = 64 * 1024;
    const HIDDEN_TAB_FLUSH_DELAY_MS = 100;
    const termRef = useRef(null);
    const termInstance = useRef(null);
    const fitAddon = useRef(null);
    const wsRef = useRef(null);
    const codexInputNoticeShown = useRef(false);
    const outputQueueRef = useRef([]);
    const outputQueueSizeRef = useRef(0);
    const flushFrameRef = useRef(null);
    const flushTimerRef = useRef(null);

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

        let ws = null;
        let fitTimer = null;
        let connectTimer = null;
        let handleResize = null;

        const flushTerminalOutput = () => {
            flushFrameRef.current = null;
            flushTimerRef.current = null;
            if (!termInstance.current || outputQueueRef.current.length === 0) {
                return;
            }

            termInstance.current.write(outputQueueRef.current.join(''));
            outputQueueRef.current = [];
            outputQueueSizeRef.current = 0;
        };

        const flushPendingOutput = () => {
            if (flushFrameRef.current !== null) {
                window.cancelAnimationFrame(flushFrameRef.current);
                flushFrameRef.current = null;
            }
            if (flushTimerRef.current !== null) {
                window.clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }

            flushTerminalOutput();
        };

        const scheduleOutputWrite = (chunk) => {
            outputQueueRef.current.push(chunk);
            outputQueueSizeRef.current += chunk.length;

            if (outputQueueSizeRef.current >= MAX_BUFFERED_OUTPUT_CHARS) {
                flushPendingOutput();
                return;
            }

            if (flushFrameRef.current !== null || flushTimerRef.current !== null) {
                return;
            }

            if (document.hidden) {
                flushTimerRef.current = window.setTimeout(flushTerminalOutput, HIDDEN_TAB_FLUSH_DELAY_MS);
                return;
            }

            flushFrameRef.current = window.requestAnimationFrame(flushTerminalOutput);
        };

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

            handleResize = () => {
                if (fitAddon.current) fitAddon.current.fit();
            };
            window.addEventListener('resize', handleResize);
            fitTimer = window.setTimeout(() => fit.fit(), 150);

            return () => {
                window.clearTimeout(fitTimer);
                window.removeEventListener('resize', handleResize);
                term.dispose();
            };
        }

        // Defer connect so React Strict Mode's throwaway mount is cleaned up
        // before any socket side effects are started.
        connectTimer = window.setTimeout(() => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.host;
            ws = new WebSocket(`${protocol}//${host}/api/harness/stream`);
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
                            scheduleOutputWrite(msg.data);
                            break;
                        case 'session':
                            flushPendingOutput();
                            term.writeln(`\x1b[90m[harness] Session ${msg.session.id} (${msg.session.mode} mode)\x1b[0m`);
                            term.writeln(`\x1b[90m[harness] Middleware: ${msg.session.middleware.join(', ')}\x1b[0m`);
                            term.writeln('');
                            onSessionUpdateRef.current?.(msg.session);
                            break;
                        case 'exit':
                            flushPendingOutput();
                            term.writeln('');
                            term.writeln(`\x1b[90m[harness] Session ended (exit code: ${msg.code})\x1b[0m`);
                            onSessionUpdateRef.current?.({ state: (msg.code === 0 || msg.code === null) ? 'completed' : 'failed' });
                            break;
                        case 'error':
                            flushPendingOutput();
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
                            flushPendingOutput();
                            term.writeln('\x1b[90m[harness] Input disabled for this session.\x1b[0m');
                            break;
                        default:
                            flushPendingOutput();
                            if (msg.middleware) {
                                onMiddlewareEventRef.current?.(msg);
                            }
                    }
                } catch {
                    flushPendingOutput();
                    term.write(event.data);
                }
            };

            ws.onclose = () => {
                flushPendingOutput();
                term.writeln('\x1b[90m[harness] Connection closed\x1b[0m');
            };

            ws.onerror = () => {
                flushPendingOutput();
                term.writeln('\x1b[31m[harness] WebSocket error\x1b[0m');
            };
        }, 0);

        // Forward terminal input to WebSocket
        term.onData((data) => {
            if (session.tool === 'codex') {
                if (!codexInputNoticeShown.current) {
                    term.writeln('\r\n\x1b[90m[harness] This Codex run is non-interactive; input is ignored.\x1b[0m');
                    codexInputNoticeShown.current = true;
                }
                return;
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'input',
                    sessionId: session.id,
                    data,
                }));
            }
        });

        // Handle window resize
        handleResize = () => {
            if (fitAddon.current) fitAddon.current.fit();
        };
        window.addEventListener('resize', handleResize);

        // Delayed fit to account for layout settling
        fitTimer = window.setTimeout(() => fit.fit(), 150);

        return () => {
            window.clearTimeout(connectTimer);
            window.clearTimeout(fitTimer);
            window.removeEventListener('resize', handleResize);
            flushPendingOutput();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
            term.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session?.id]);

    return <div ref={termRef} style={{ width: '100%', height: '100%' }} />;
});

export default TerminalView;
