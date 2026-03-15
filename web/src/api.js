const API_BASE = '/api';

export async function fetchSessions(filter = {}) {
    const params = new URLSearchParams();
    if (filter.state) params.set('state', filter.state);
    if (filter.contextDir) params.set('contextDir', filter.contextDir);

    const res = await fetch(`${API_BASE}/harness/sessions?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
    const data = await res.json();
    return data.sessions;
}

export async function fetchSession(id) {
    const res = await fetch(`${API_BASE}/harness/sessions/${id}`);
    if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`);
    return res.json();
}

export async function createSession({ tool, task, contextDir, mode, timeBudgetMs }) {
    const res = await fetch(`${API_BASE}/harness/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, task, contextDir, mode, timeBudgetMs }),
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Failed to create session: ${res.status}`);
    }
    return (await res.json()).session;
}

export async function fetchTools() {
    const res = await fetch(`${API_BASE}/tools`);
    if (!res.ok) throw new Error(`Failed to fetch tools: ${res.status}`);
    return res.json();
}

/**
 * Create a WebSocket connection to the harness stream.
 * @returns {WebSocket}
 */
export function createHarnessSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return new WebSocket(`${protocol}//${host}/api/harness/stream`);
}
