/**
 * MiddlewareRunner — Composable middleware pipeline for the harness.
 *
 * Middleware hooks into the PTY data stream at various lifecycle points.
 * 
 * Events:
 *   - session:start   — Session initialized, PTY spawned
 *   - pty:output      — Data received from PTY stdout
 *   - pty:input       — Data about to be written to PTY stdin
 *   - session:idle    — No PTY output for a configurable duration
 *   - session:exit    — PTY process exiting
 *
 * Each middleware is an object with:
 *   - name: string
 *   - events: string[] — which events to listen to
 *   - handler: async function({ event, data, session, context, inject, trace })
 *       - inject(text): write text to PTY stdin
 *       - trace: TraceLogger instance
 *       - returns: { data } to modify/pass through, or { suppress: true } to block
 */
class MiddlewareRunner {
    constructor() {
        /** @type {Array<{name: string, events: string[], handler: Function}>} */
        this.middlewares = [];
    }

    /**
     * Register a middleware.
     * @param {object} middleware
     * @param {string} middleware.name
     * @param {string[]} middleware.events
     * @param {Function} middleware.handler
     */
    use(middleware) {
        if (!middleware.name || !middleware.events || !middleware.handler) {
            throw new Error('Middleware must have name, events, and handler');
        }
        this.middlewares.push(middleware);
    }

    /**
     * Execute the middleware pipeline for a given event.
     * @param {string} event - The event type
     * @param {object} ctx - Context object
     * @param {*} ctx.data - Event data (e.g., PTY output chunk)
     * @param {object} ctx.session - Current session object
     * @param {object} ctx.context - Assembled context from ContextEngine
     * @param {Function} ctx.inject - Function to write to PTY stdin
     * @param {object} ctx.trace - TraceLogger instance
     * @returns {Promise<{data: *, suppress: boolean}>}
     */
    async run(event, ctx) {
        let currentData = ctx.data;
        let suppress = false;

        const relevantMiddlewares = this.middlewares.filter(
            m => m.events.includes(event)
        );

        for (const mw of relevantMiddlewares) {
            try {
                const result = await mw.handler({
                    event,
                    data: currentData,
                    session: ctx.session,
                    context: ctx.context,
                    inject: ctx.inject,
                    trace: ctx.trace,
                });

                if (result) {
                    if (result.suppress) {
                        suppress = true;
                        break;
                    }
                    if (result.data !== undefined) {
                        currentData = result.data;
                    }
                }
            } catch (err) {
                console.error(`[MiddlewareRunner] Error in ${mw.name}:`, err.message);
                if (ctx.trace) {
                    ctx.trace.error(`Middleware error: ${mw.name}`, err);
                }
            }
        }

        return { data: currentData, suppress };
    }

    /**
     * Get list of registered middleware names.
     * @returns {string[]}
     */
    list() {
        return this.middlewares.map(m => m.name);
    }
}

module.exports = MiddlewareRunner;
