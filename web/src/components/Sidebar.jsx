import { useEffect, useState } from 'react';

/**
 * Sidebar — Session list with filtering and selection.
 */
export default function Sidebar({ sessions, activeId, onSelect, onNewSession }) {
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 60000);
        return () => clearInterval(timer);
    }, []);

    const formatTime = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        const diff = nowMs - d.getTime();
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return d.toLocaleDateString();
    };

    const formatDuration = (session) => {
        if (!session.startedAt) return '';
        const start = new Date(session.startedAt).getTime();
        const end = session.completedAt ? new Date(session.completedAt).getTime() : nowMs;
        const mins = Math.floor((end - start) / 60000);
        if (mins < 1) return '<1min';
        return `${mins}min`;
    };

    return (
        <div className="sidebar">
            <div className="sidebar__header">
                <span className="sidebar__label">Sessions ({sessions.length})</span>
                <button className="btn btn--primary btn--sm" onClick={onNewSession}>
                    + New
                </button>
            </div>
            <div className="sidebar__list">
                {sessions.length === 0 && (
                    <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                        No sessions yet.<br />Create one to get started.
                    </div>
                )}
                {sessions.map(s => (
                    <div
                        key={s.id}
                        className={`session-card ${s.id === activeId ? 'session-card--active' : ''}`}
                        onClick={() => onSelect(s)}
                    >
                        <div className="session-card__header">
                            <span className="session-card__tool">{s.tool}</span>
                            <span className={`status-badge status-badge--${s.state}`}>
                                {s.state}
                            </span>
                        </div>
                        <div className="session-card__task">{s.task}</div>
                        <div className="session-card__meta">
                            <span>{s.mode}</span>
                            <span>·</span>
                            <span>{formatDuration(s) || formatTime(s.createdAt)}</span>
                            {s.timeBudgetMs > 0 && (
                                <>
                                    <span>·</span>
                                    <span>{Math.round(s.timeBudgetMs / 60000)}m budget</span>
                                </>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
