const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ProgressTracker = require('./ProgressTracker');

/**
 * ContextEngine — Auto-discovers and assembles environment context.
 *
 * Scans the project directory to build a comprehensive context object
 * that middleware can inject into the agent's stdin at session start.
 *
 * Inspired by LangChain's LocalContextMiddleware and
 * OpenAI's AGENTS.md / agent legibility patterns.
 */
class ContextEngine {
    /**
     * @param {string} contextDir - The project working directory
     */
    constructor(contextDir) {
        this.contextDir = contextDir;
        this.progressTracker = new ProgressTracker(contextDir);
    }

    /**
     * Assemble full context for a session.
     * @param {object} [session] - Optional session info to include
     * @returns {object} Structured context object
     */
    async assemble(session = null) {
        const [directoryTree, projectType, agentGuidance] = await Promise.all([
            this._scanDirectory(),
            this._detectProjectType(),
            this._readAgentGuidance(),
        ]);

        const gitSummary = this.progressTracker.getGitSummary();
        const progressSummary = this.progressTracker.getProgressSummary();
        const featureSummary = this.progressTracker.getFeatureSummary();

        return {
            workingDirectory: this.contextDir,
            directoryTree,
            projectType,
            agentGuidance,
            gitSummary,
            progressSummary,
            featureSummary,
            session: session ? {
                id: session.id,
                mode: session.mode,
                task: session.task,
                tool: session.tool,
            } : null,
        };
    }

    /**
     * Format the context object as a human-readable text block
     * suitable for injecting into a CLI tool's stdin.
     * @param {object} context - Output of assemble()
     * @returns {string}
     */
    formatForInjection(context) {
        const sections = [];

        sections.push('=== HARNESS CONTEXT ===');
        sections.push(`Working Directory: ${context.workingDirectory}`);

        if (context.projectType) {
            sections.push(`Project Type: ${context.projectType.type} (detected from ${context.projectType.indicator})`);
        }

        if (context.session) {
            sections.push(`\nSession: ${context.session.id}`);
            sections.push(`Mode: ${context.session.mode}`);
            sections.push(`Task: ${context.session.task}`);
        }

        if (context.directoryTree) {
            sections.push(`\n--- Directory Structure ---\n${context.directoryTree}`);
        }

        if (context.gitSummary && context.gitSummary !== 'Not a git repository or git not available.') {
            sections.push(`\n--- Recent Git History ---\n${context.gitSummary}`);
        }

        if (context.progressSummary && context.progressSummary !== 'No prior progress recorded.') {
            sections.push(`\n--- Progress ---\n${context.progressSummary}`);
        }

        if (context.featureSummary && context.featureSummary !== 'No feature list defined.') {
            sections.push(`\n--- Features ---\n${context.featureSummary}`);
        }

        if (context.agentGuidance) {
            sections.push(`\n--- Agent Guidance ---\n${context.agentGuidance}`);
        }

        sections.push('\n=== END HARNESS CONTEXT ===\n');

        return sections.join('\n');
    }

    // ---- Internal Discovery Methods ----

    /**
     * Scan directory structure (depth-limited).
     * @param {number} [maxDepth=3]
     * @returns {Promise<string>}
     */
    async _scanDirectory(maxDepth = 3) {
        try {
            // Try using 'find' for a tree-like output
            const result = execSync(
                `find . -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.harness/*' | head -100 | sort`,
                { cwd: this.contextDir, encoding: 'utf8', timeout: 5000 }
            ).trim();

            return result || 'Empty directory.';
        } catch {
            return 'Unable to scan directory.';
        }
    }

    /**
     * Detect project type from indicator files.
     * @returns {Promise<object|null>}
     */
    async _detectProjectType() {
        const indicators = [
            { file: 'package.json', type: 'Node.js / JavaScript' },
            { file: 'Cargo.toml', type: 'Rust' },
            { file: 'go.mod', type: 'Go' },
            { file: 'pyproject.toml', type: 'Python (pyproject)' },
            { file: 'requirements.txt', type: 'Python (pip)' },
            { file: 'Pipfile', type: 'Python (pipenv)' },
            { file: 'pom.xml', type: 'Java (Maven)' },
            { file: 'build.gradle', type: 'Java/Kotlin (Gradle)' },
            { file: 'Gemfile', type: 'Ruby' },
            { file: 'mix.exs', type: 'Elixir' },
            { file: 'CMakeLists.txt', type: 'C/C++ (CMake)' },
            { file: 'Makefile', type: 'Make-based project' },
            { file: 'docker-compose.yml', type: 'Docker Compose' },
            { file: 'Dockerfile', type: 'Docker' },
        ];

        for (const { file, type } of indicators) {
            if (fs.existsSync(path.join(this.contextDir, file))) {
                return { type, indicator: file };
            }
        }
        return null;
    }

    /**
     * Read agent guidance files (AGENTS.md, .cursorrules, etc.)
     * @returns {Promise<string|null>}
     */
    async _readAgentGuidance() {
        const guidanceFiles = [
            'AGENTS.md',
            'CLAUDE.md',
            '.cursorrules',
            '.github/copilot-instructions.md',
            'CONTRIBUTING.md',
        ];

        for (const file of guidanceFiles) {
            const filePath = path.join(this.contextDir, file);
            if (fs.existsSync(filePath)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    // Truncate large files to avoid overwhelming the context
                    const maxLen = 2000;
                    if (content.length > maxLen) {
                        return `[From ${file} — truncated to ${maxLen} chars]\n${content.substring(0, maxLen)}...`;
                    }
                    return `[From ${file}]\n${content}`;
                } catch {
                    continue;
                }
            }
        }
        return null;
    }
}

module.exports = ContextEngine;
