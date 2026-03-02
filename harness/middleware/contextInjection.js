/**
 * Context Injection Middleware
 *
 * Fires on session:start. Uses ContextEngine to assemble environment context
 * and injects it into the CLI tool's PTY stdin as an orientation block.
 *
 * Inspired by LangChain's LocalContextMiddleware.
 */
const ContextEngine = require('../ContextEngine');

function createContextInjectionMiddleware() {
    return {
        name: 'contextInjection',
        events: ['session:start'],

        handler: async ({ session, inject, trace }) => {
            try {
                const engine = new ContextEngine(session.contextDir);
                const context = await engine.assemble(session);
                const text = engine.formatForInjection(context);

                // Inject the context block into the CLI tool's stdin
                if (inject) {
                    inject(text);
                }

                if (trace) {
                    trace.contextInjected(text);
                    trace.middlewareTriggered('contextInjection', {
                        contextLength: text.length,
                    });
                }

                return { data: context };
            } catch (err) {
                console.error('[ContextInjection] Error:', err.message);
                if (trace) {
                    trace.error('Context injection failed', err);
                }
                return {};
            }
        },
    };
}

module.exports = createContextInjectionMiddleware;
