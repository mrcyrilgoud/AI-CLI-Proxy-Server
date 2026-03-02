/**
 * Pre-Completion Middleware
 *
 * Fires on pty:output. Detects when the CLI tool is about to finish
 * by pattern-matching on common exit/completion phrases. When detected,
 * checks whether the agent has run any verification, and if not, injects
 * a prompt to verify before finishing.
 *
 * Inspired by LangChain's PreCompletionChecklistMiddleware
 * (a.k.a. the "Ralph Wiggum Loop").
 *
 * Note: This is heuristic-based. We can't truly intercept PTY exit,
 * so we detect exit-like *output* patterns and inject before the process
 * actually closes.
 */
function createPreCompletionMiddleware(options = {}) {
    const completionPatterns = options.completionPatterns || [
        /task\s+(is\s+)?complete/i,
        /i('ve| have)\s+finished/i,
        /all\s+done/i,
        /changes?\s+(are\s+)?complete/i,
        /implementation\s+(is\s+)?complete/i,
        /successfully\s+(completed|finished|done)/i,
        /that\s+should\s+do\s+it/i,
        /let\s+me\s+know\s+if/i,
    ];

    const verificationPatterns = options.verificationPatterns || [
        /npm\s+test/i,
        /jest/i,
        /pytest/i,
        /cargo\s+test/i,
        /go\s+test/i,
        /make\s+test/i,
        /test\s+(passed|succeeded|ok)/i,
        /\d+\s+(tests?\s+)?passed/i,
        /running\s+tests?/i,
        /verification/i,
    ];

    const nudgeMessage = options.nudgeMessage ||
        '\n[HARNESS] Before finishing, please verify your changes:\n' +
        '1. Run the test suite to confirm nothing is broken\n' +
        '2. Re-read the original task spec and confirm all requirements are met\n' +
        '3. Check for any edge cases you may have missed\n' +
        '4. Commit your changes with a descriptive message\n';

    // State
    let verificationSeen = false;
    let completionNudgeSent = false;

    return {
        name: 'preCompletion',
        events: ['pty:output'],

        handler: async ({ data, inject, trace }) => {
            if (!data || typeof data !== 'string') return {};

            // Track if any verification has been run
            for (const pattern of verificationPatterns) {
                if (pattern.test(data)) {
                    verificationSeen = true;
                    break;
                }
            }

            // Check for completion signals
            if (!completionNudgeSent) {
                for (const pattern of completionPatterns) {
                    if (pattern.test(data)) {
                        // Completion detected — has agent verified?
                        if (!verificationSeen) {
                            completionNudgeSent = true;

                            if (trace) {
                                trace.verificationRequested('Completion detected without prior verification');
                                trace.middlewareTriggered('preCompletion', {
                                    action: 'nudge_injected',
                                    triggerPattern: pattern.source,
                                    verificationSeen: false,
                                });
                            }

                            if (inject) {
                                inject(nudgeMessage);
                            }
                        } else {
                            if (trace) {
                                trace.middlewareTriggered('preCompletion', {
                                    action: 'completion_allowed',
                                    verificationSeen: true,
                                });
                            }
                        }
                        break;
                    }
                }
            }

            return {};
        },

        /**
         * Reset state for a new session (useful in tests).
         */
        reset() {
            verificationSeen = false;
            completionNudgeSent = false;
        },
    };
}

module.exports = createPreCompletionMiddleware;
