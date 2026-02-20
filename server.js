const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());

app.post('/api/generate', (req, res) => {
    const { command } = req.body;

    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }

    console.log(`Executing: ${command}`);

    // Adjust maxBuffer if AI outputs are extremely large
    exec(command, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing command: ${error.message}`);
            return res.status(500).json({
                error: 'Command Execution Failed',
                details: error.message,
                stderr: stderr
            });
        }

        if (stderr && !stdout) {
            console.warn(`Command stderr: ${stderr}`);
            // Some CLIs output valid info to stderr. If stdout is empty but stderr isn't, return stderr.
            return res.json({ response: stderr.trim() });
        }

        res.json({ response: stdout.trim() });
    });
});

app.listen(PORT, () => {
    console.log(`AI CLI Proxy Server running at http://localhost:${PORT}`);
    console.log(`Ready to execute commands for the frontend.`);
});
