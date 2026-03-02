/**
 * Time Budget Middleware
 *
 * Fires on pty:output (used as a periodic trigger via output events).
 * Injects time-awareness warnings at configurable thresholds.
 *
 * Inspired by LangChain's time budget injection for Terminal Bench.
 *
 * Default thresholds:
 *   - 50% elapsed: "You have used half your time budget..."
 *   - 80% elapsed: "Only 20% of your time remains..."
 */
function createTimeBudgetMiddleware(options = {}) {
    const thresholds = options.thresholds || [
        {
            percent: 50,
            message: '[HARNESS] Time check: You have used approximately half of your time budget. Consider prioritizing the most important remaining work and beginning to verify what you have so far.',
        },
        {
            percent: 80,
            message: '[HARNESS] Time warning: Only about 20% of your time budget remains. Focus on verifying and committing your current work. Ensure the codebase is in a clean, working state.',
        },
    ];

    // Track which thresholds have been fired
    const firedThresholds = new Set();
    // Debounce: only check time every N output events
    let outputEventCount = 0;
    const checkInterval = options.checkInterval || 10; // Check every 10 output events

    return {
        name: 'timeBudget',
        events: ['pty:output'],

        handler: async ({ session, inject, trace }) => {
            outputEventCount++;
            if (outputEventCount % checkInterval !== 0) return {};

            // Need a time budget and a start time to function
            if (!session || !session.timeBudgetMs || !session.startedAt) return {};

            const elapsed = Date.now() - new Date(session.startedAt).getTime();
            const percentElapsed = (elapsed / session.timeBudgetMs) * 100;

            for (const threshold of thresholds) {
                if (percentElapsed >= threshold.percent && !firedThresholds.has(threshold.percent)) {
                    firedThresholds.add(threshold.percent);

                    const remainingMinutes = Math.max(0,
                        Math.round((session.timeBudgetMs - elapsed) / 60000)
                    );

                    const message = `\n${threshold.message} (${remainingMinutes} minutes remaining)\n`;

                    if (trace) {
                        trace.timeWarning(elapsed, session.timeBudgetMs, message);
                        trace.middlewareTriggered('timeBudget', {
                            action: 'warning_injected',
                            threshold: threshold.percent,
                            elapsedMs: elapsed,
                            remainingMinutes,
                        });
                    }

                    if (inject) {
                        inject(message);
                    }
                }
            }

            return {};
        },

        /**
         * Reset state for a new session (useful in tests).
         */
        reset() {
            firedThresholds.clear();
            outputEventCount = 0;
        },
    };
}

module.exports = createTimeBudgetMiddleware;
