const pty = require('node-pty');
try {
    const { execSync } = require('child_process');
    const npxPath = execSync('which npx').toString().trim();
    console.log('npxPath:', npxPath);
    const p = pty.spawn(npxPath, ['--version'], {cwd: process.cwd(), env: process.env});
    p.onData(d=>console.log(d.trim()));
    p.onExit(({ exitCode, signal }) => {
        console.log('PTY exited with code', exitCode, 'and signal', signal);
    });
    setTimeout(()=>p.kill(), 1000);
} catch (e) {
    console.error('ERR:', e.message);
}
