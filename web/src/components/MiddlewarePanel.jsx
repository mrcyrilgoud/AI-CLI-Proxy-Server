import { useEffect, useState } from 'react';

/**
 * Middleware status panel — shows live status of each middleware.
 */
export default function MiddlewarePanel({ session, events = [] }) {
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 5000);
        return () => clearInterval(timer);
    }, []);

    // Compute statuses from events
    const getMiddlewareStatus = (name) => {
        const relevant = events.filter(e => e.middleware === name);
        const last = relevant[relevant.length - 1];
        return last || null;
    };

    const loopEvent = getMiddlewareStatus('loopDetection');
    const preCompEvent = getMiddlewareStatus('preCompletion');
    const contextEvent = getMiddlewareStatus('contextInjection');

    // Compute time budget percentage
    let timePercent = 0;
    let timeLabel = 'No budget';
    if (session?.timeBudgetMs && session?.startedAt) {
        const elapsed = nowMs - new Date(session.startedAt).getTime();
        timePercent = Math.min(100, Math.round((elapsed / session.timeBudgetMs) * 100));
        const remaining = Math.max(0, Math.round((session.timeBudgetMs - elapsed) / 60000));
        timeLabel = `${timePercent}% · ${remaining}m left`;
    }

    const getDotClass = (percent) => {
        if (percent >= 80) return 'middleware-card__dot--alert';
        if (percent >= 50) return 'middleware-card__dot--warn';
        return 'middleware-card__dot--active';
    };

    return (
        <div className="middleware-panel">
            <div className="middleware-card">
                <div className={`middleware-card__dot ${contextEvent ? 'middleware-card__dot--active' : 'middleware-card__dot--idle'}`} />
                <span className="middleware-card__name">Context</span>
                <span className="middleware-card__value">
                    {contextEvent ? `${contextEvent.contextLength || '?'} chars` : 'Waiting'}
                </span>
            </div>

            <div className="middleware-card">
                <div className={`middleware-card__dot ${loopEvent?.action === 'nudge_injected' ? 'middleware-card__dot--alert' : 'middleware-card__dot--idle'}`} />
                <span className="middleware-card__name">Loop</span>
                <span className="middleware-card__value">
                    {loopEvent ? `${loopEvent.repetitions || 0} repetitions` : 'Monitoring'}
                </span>
            </div>

            <div className="middleware-card">
                <div className={`middleware-card__dot ${session?.timeBudgetMs ? getDotClass(timePercent) : 'middleware-card__dot--idle'}`} />
                <span className="middleware-card__name">Time</span>
                <span className="middleware-card__value">{timeLabel}</span>
            </div>

            <div className="middleware-card">
                <div className={`middleware-card__dot ${preCompEvent?.action === 'nudge_injected' ? 'middleware-card__dot--warn' : preCompEvent?.action === 'completion_allowed' ? 'middleware-card__dot--active' : 'middleware-card__dot--idle'}`} />
                <span className="middleware-card__name">Verify</span>
                <span className="middleware-card__value">
                    {preCompEvent?.action === 'nudge_injected' ? 'Nudged' : preCompEvent?.action === 'completion_allowed' ? 'Passed' : 'Watching'}
                </span>
            </div>
        </div>
    );
}
