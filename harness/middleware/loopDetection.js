/**
 * Loop Detection Middleware
 *
 * Fires on pty:output. Tracks repetitive patterns in PTY output to detect
 * when the agent is stuck in a "doom loop" — repeatedly trying the same
 * broken approach.
 *
 * Inspired by LangChain's LoopDetectionMiddleware.
 *
 * Detection strategy:
 *   - Maintain a sliding window of recent output chunk hashes
 *   - Track per-pattern repetition counts
 *   - After N repetitions, inject a "step back" nudge into stdin
 *   - Uses a cooldown to avoid spamming the agent
 */
const crypto = require('crypto');

function createLoopDetectionMiddleware(options = {}) {
    const threshold = options.threshold || 5;
    const windowSize = options.windowSize || 20;
    const cooldownMs = options.cooldownMs || 60000; // 1 minute between nudges
    const nudgeMessage = options.nudgeMessage ||
        '\n[HARNESS] You appear to be repeating a similar approach. Consider stepping back and reconsidering your strategy. Try a fundamentally different approach rather than small variations of the same fix.\n';

    // State (per-middleware-instance, shared across the session)
    const recentHashes = [];
    const patternCounts = new Map();
    let lastNudgeAt = 0;

    return {
        name: 'loopDetection',
        events: ['pty:output'],

        handler: async ({ data, inject, trace }) => {
            if (!data || typeof data !== 'string') return {};

            // Normalize: trim whitespace, collapse multiple spaces
            const normalized = data.trim().replace(/\s+/g, ' ');
            if (normalized.length < 20) return {}; // Too short to be meaningful

            // Hash the normalized output chunk
            const hash = crypto
                .createHash('md5')
                .update(normalized.substring(0, 500)) // Hash only first 500 chars
                .digest('hex')
                .substring(0, 12);

            // Add to sliding window
            recentHashes.push(hash);
            if (recentHashes.length > windowSize) {
                const removed = recentHashes.shift();
                // Decrement count for the removed hash
                const count = patternCounts.get(removed) || 0;
                if (count <= 1) {
                    patternCounts.delete(removed);
                } else {
                    patternCounts.set(removed, count - 1);
                }
            }

            // Increment count for current hash
            const currentCount = (patternCounts.get(hash) || 0) + 1;
            patternCounts.set(hash, currentCount);

            // Check if we've hit the threshold
            if (currentCount >= threshold) {
                const now = Date.now();
                if (now - lastNudgeAt > cooldownMs) {
                    lastNudgeAt = now;

                    if (trace) {
                        trace.loopDetected({
                            hash,
                            repetitions: currentCount,
                            windowSize: recentHashes.length,
                        });
                        trace.middlewareTriggered('loopDetection', {
                            action: 'nudge_injected',
                            repetitions: currentCount,
                        });
                    }

                    // Inject the nudge
                    if (inject) {
                        inject(nudgeMessage);
                    }

                    // Reset counts to avoid continuous nudging
                    patternCounts.clear();
                    recentHashes.length = 0;
                }
            }

            return {};
        },
    };
}

module.exports = createLoopDetectionMiddleware;
