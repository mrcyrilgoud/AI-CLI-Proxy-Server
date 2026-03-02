const pty = require('node-pty'); // Keep this require for consistency, though not directly used for spawning
try {
    const { execSync, spawn } = require('child_process');
    const npxPath = execSync('which npx').toString().trim();
    console.log('npxPath:', npxPath);

    const commandLine = `"${process.execPath}" "${npxPath}" --version`;

    const cp = spawn('bash', ['-c', commandLine], {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: '1' },
    });

    const p = {
        onData: (cb) => {
            cp.stdout.on('data', d => cb(d.toString()));
            cp.stderr.on('data', d => cb(d.toString()));
        },
        onExit: (cb) => {
            cp.on('exit', (code, signal) => cb({ exitCode: code, signal }));
        },
        kill: () => cp.kill(),
        write: (data) => cp.stdin.write(data) // Added for completeness, though not strictly needed for this test
    };

    p.onData(d => console.log('DATA:', d.trim()));
    p.onExit(({ exitCode }) => {
        console.log('EXIT:', exitCode);
        process.exit(0);
    });
} catch (e) {
    console.error('ERR:', e.message);
}
