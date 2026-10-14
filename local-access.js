function isLoopbackOrigin(origin) {
    if (!origin) return true; // Non-browser local clients have no Origin.
    try {
        const url = new URL(origin);
        return ['http:', 'https:'].includes(url.protocol) &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
            !url.username && !url.password && url.origin === origin;
    } catch { return false; }
}

function localAccess(req, res, next) {
    if (!isLoopbackOrigin(req.headers.origin)) return res.status(403).json({ error: 'Loopback browser origin required' });
    // Defend loopback services from DNS rebinding as well as hostile browser origins.
    const host = req.headers.host;
    try {
        if (!host || !isLoopbackOrigin(`http://${host}`)) return res.status(403).json({ error: 'Loopback host required' });
    } catch { return res.status(403).json({ error: 'Loopback host required' }); }
    next();
}

module.exports = { isLoopbackOrigin, localAccess };
