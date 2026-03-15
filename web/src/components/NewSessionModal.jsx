import { useState, useEffect } from 'react';
import { createSession, fetchTools } from '../api';

export default function NewSessionModal({ onClose, onCreated }) {
    const [tools, setTools] = useState([]);
    const [form, setForm] = useState({
        tool: '',
        task: '',
        contextDir: '',
        mode: 'coding',
        timeBudgetMinutes: 30,
    });
    const [error, setError] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        fetchTools()
            .then(({ tools: nextTools = [], defaultTool = '' }) => {
                setTools(nextTools);
                const initialTool = nextTools.includes(defaultTool) ? defaultTool : nextTools[0] || '';
                if (initialTool) {
                    setForm(prev => ({ ...prev, tool: initialTool }));
                }
            })
            .catch(err => setError(err.message));
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setSubmitting(true);

        try {
            const session = await createSession({
                tool: form.tool,
                task: form.task,
                contextDir: form.contextDir || undefined,
                mode: form.mode,
                timeBudgetMs: form.timeBudgetMinutes ? form.timeBudgetMinutes * 60000 : null,
            });
            onCreated(session);
        } catch (err) {
            setError(err.message);
        } finally {
            setSubmitting(false);
        }
    };

    const update = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()}>
                <h2>New Session</h2>
                <form onSubmit={handleSubmit}>
                    <div className="modal__field">
                        <label htmlFor="ns-tool">CLI Tool</label>
                        <select
                            id="ns-tool"
                            value={form.tool}
                            onChange={e => update('tool', e.target.value)}
                            required
                        >
                            {tools.map(t => (
                                <option key={t} value={t}>{t}</option>
                            ))}
                        </select>
                    </div>

                    <div className="modal__field">
                        <label htmlFor="ns-task">Task Description</label>
                        <textarea
                            id="ns-task"
                            value={form.task}
                            onChange={e => update('task', e.target.value)}
                            placeholder="Build a responsive login page with email/password..."
                            required
                        />
                    </div>

                    <div className="modal__field">
                        <label htmlFor="ns-dir">Working Directory</label>
                        <input
                            id="ns-dir"
                            type="text"
                            value={form.contextDir}
                            onChange={e => update('contextDir', e.target.value)}
                            placeholder="/path/to/project (optional)"
                        />
                    </div>

                    <div className="modal__field" style={{ display: 'flex', gap: '12px' }}>
                        <div style={{ flex: 1 }}>
                            <label htmlFor="ns-mode">Mode</label>
                            <select
                                id="ns-mode"
                                value={form.mode}
                                onChange={e => update('mode', e.target.value)}
                            >
                                <option value="coding">Coding</option>
                                <option value="initializer">Initializer</option>
                            </select>
                        </div>
                        <div style={{ flex: 1 }}>
                            <label htmlFor="ns-time">Time Budget (min)</label>
                            <input
                                id="ns-time"
                                type="number"
                                min="0"
                                value={form.timeBudgetMinutes}
                                onChange={e => update('timeBudgetMinutes', parseInt(e.target.value, 10) || 0)}
                            />
                        </div>
                    </div>

                    {error && (
                        <div style={{ color: 'var(--status-failed)', fontSize: '13px', marginTop: '8px' }}>
                            {error}
                        </div>
                    )}

                    <div className="modal__actions">
                        <button type="button" className="btn btn--ghost" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn--primary" disabled={submitting || !form.task}>
                            {submitting ? 'Creating...' : 'Create & Connect'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
