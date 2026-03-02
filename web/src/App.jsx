import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import TerminalView from './components/TerminalView';
import MiddlewarePanel from './components/MiddlewarePanel';
import NewSessionModal from './components/NewSessionModal';
import { fetchSessions } from './api';

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [middlewareEvents, setMiddlewareEvents] = useState([]);
  const [liveSessionInfo, setLiveSessionInfo] = useState(null);
  const [error, setError] = useState(null);
  const terminalRef = useRef(null);

  // Load sessions on mount and periodically
  const loadSessions = useCallback(async () => {
    try {
      const data = await fetchSessions();
      setSessions(data);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  // Handle session selection (connect terminal)
  const handleSelect = (session) => {
    setActiveSession(session);
    setMiddlewareEvents([]);
    setLiveSessionInfo(null);
  };

  // Handle new session created
  const handleCreated = (session) => {
    setShowNewModal(false);
    setSessions(prev => [session, ...prev]);
    setActiveSession(session);
    setMiddlewareEvents([]);
    setLiveSessionInfo(null);
  };

  // Handle middleware events from terminal — stable ref to avoid re-render loops
  const handleMiddlewareEvent = useCallback((event) => {
    setMiddlewareEvents(prev => [...prev, event]);
  }, []);

  // Handle session status updates from WebSocket — stable ref
  const handleSessionUpdate = useCallback((update) => {
    setLiveSessionInfo(prev => ({ ...prev, ...update }));
  }, []);

  // Stop the active session
  const handleStop = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.stop();
    }
    setLiveSessionInfo(prev => ({ ...prev, state: 'completed' }));
    // Refresh session list after a short delay
    setTimeout(loadSessions, 500);
  }, [loadSessions]);

  // Merged session info (REST data + live WebSocket updates)
  const displaySession = activeSession
    ? { ...activeSession, ...(liveSessionInfo || {}) }
    : null;

  return (
    <div className="app-layout">
      {/* Header */}
      <header className="app-header">
        <div className="app-header__title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="url(#grad)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <defs>
              <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span>AI Harness</span>
          <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '13px' }}>Control Panel</span>
        </div>
        <div className="app-header__actions">
          <button className="btn btn--primary" onClick={() => setShowNewModal(true)}>
            + New Session
          </button>
        </div>
      </header>

      {/* Sidebar */}
      <Sidebar
        sessions={sessions}
        activeId={activeSession?.id}
        onSelect={handleSelect}
        onNewSession={() => setShowNewModal(true)}
      />

      {/* Main Content */}
      <div className="main-content">
        {displaySession ? (
          <>
            {/* Session Header */}
            <div className="main-content__header">
              <div className="main-content__header-info">
                <h2>{displaySession.tool}</h2>
                <span className={`status-badge status-badge--${displaySession.state}`}>
                  {displaySession.state}
                </span>
                <span className="main-content__header-detail">
                  {displaySession.mode} mode
                </span>
                <span className="main-content__header-detail">
                  {displaySession.id?.substring(0, 8)}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {displaySession.timeBudgetMs > 0 && (
                  <TimeBudgetBadge session={displaySession} />
                )}
                {(displaySession.state === 'running' || displaySession.state === 'created') && (
                  <button
                    className="btn btn--sm"
                    style={{
                      background: 'rgba(239, 68, 68, 0.12)',
                      color: 'var(--status-failed)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                    }}
                    onClick={handleStop}
                  >
                    ■ Stop
                  </button>
                )}
              </div>
            </div>

            {/* Terminal */}
            <div className="main-content__terminal">
              <TerminalView
                key={activeSession.id}
                ref={terminalRef}
                session={activeSession}
                onMiddlewareEvent={handleMiddlewareEvent}
                onSessionUpdate={handleSessionUpdate}
              />
            </div>

            {/* Middleware Panel */}
            <MiddlewarePanel
              session={displaySession}
              events={middlewareEvents}
            />
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state__icon">⚡</div>
            <div className="empty-state__text">
              Select a session or create a new one to get started
            </div>
            <button className="btn btn--ghost" onClick={() => setShowNewModal(true)}>
              + New Session
            </button>
          </div>
        )}
      </div>

      {/* New Session Modal */}
      {showNewModal && (
        <NewSessionModal
          onClose={() => setShowNewModal(false)}
          onCreated={handleCreated}
        />
      )}

      {/* Error toast */}
      {error && (
        <div
          style={{
            position: 'fixed',
            bottom: '16px',
            right: '16px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--status-failed)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            color: 'var(--status-failed)',
            fontSize: '13px',
            zIndex: 200,
            cursor: 'pointer',
          }}
          onClick={() => setError(null)}
        >
          {error}
        </div>
      )}
    </div>
  );
}

/** Small inline component for the time budget display */
function TimeBudgetBadge({ session }) {
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    if (!session.startedAt || !session.timeBudgetMs) return;

    const update = () => {
      const elapsed = Date.now() - new Date(session.startedAt).getTime();
      setPercent(Math.min(100, Math.round((elapsed / session.timeBudgetMs) * 100)));
    };
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [session.startedAt, session.timeBudgetMs]);

  const colorClass = percent >= 80 ? 'time-bar__fill--danger' : percent >= 50 ? 'time-bar__fill--warn' : 'time-bar__fill--ok';
  const remaining = session.timeBudgetMs && session.startedAt
    ? Math.max(0, Math.round((session.timeBudgetMs - (Date.now() - new Date(session.startedAt).getTime())) / 60000))
    : 0;

  return (
    <div style={{ minWidth: '120px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
        {percent}% · {remaining}m left
      </div>
      <div className="time-bar">
        <div className={`time-bar__fill ${colorClass}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
