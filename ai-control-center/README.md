# OCode.js AI Live Control Center

A local Windows desktop companion for `zskbot/ocodejs-cli`. It provides a staged AI orchestrator, human-approved agent execution, live terminal output, a task queue, and GitHub Pull Request monitoring.

## Requirements

- Windows 10/11
- Python 3.10+
- An AI coding CLI installed locally (Codex CLI, Claude Code, or another compatible CLI)
- Optional GitHub Personal Access Token for higher API limits/private repository access

## Setup (PowerShell)

From the repository root:

```powershell
cd ai-control-center
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item config.example.json config.json
notepad config.json
py app.py
```

If PowerShell blocks activation, run the app using `.venv\Scripts\python.exe app.py` instead.

## Configure agents

Edit `config.json` and set each role's `command` to the CLI installed on your PC. Commands are argv arrays, not shell strings. The `{task}` placeholder is replaced with the task prompt and `{repo}` with the repository name.

Example for Codex CLI:

```json
"coder": {
  "label": "Coder",
  "command": ["codex", "exec", "--sandbox", "workspace-write", "{task}"]
}
```

Use the exact flags supported by your installed CLI version. Keep `allowed_executables` limited to the agent tools and developer commands you intentionally permit. Shell interpreters are blocked. Agent execution always requires clicking **Approve & run** and confirming the exact argv preview.

## GitHub

Set a token in the process environment if you need authenticated API access:

```powershell
$env:GITHUB_TOKEN = "github_pat_..."
py app.py
```

Never commit `config.json`, tokens, or local logs. Add `config.json` to your local global Git ignore if needed. The dashboard only reads open PR metadata; it does not push branches, approve PRs, merge, or deploy.

## Orchestrator workflow

1. Enter a delivery brief.
2. Build workflow to create Planner, Coder, Tester, and Reviewer tasks.
3. Select one task and inspect the command preview.
4. Approve each stage explicitly. Only one agent process runs at a time.
5. Review live terminal output and task status.
6. Refresh GitHub PRs to view open PR metadata.

Agent CLIs may have their own permission prompts and sandbox controls. Keep those enabled. This dashboard approval is an additional execution gate, not a replacement for the agent's own security controls.

## Tests

```powershell
py -m unittest discover -s tests -v
```

## Security model and limitations

- Uses `subprocess.Popen(..., shell=False)` with an argv list; no shell command concatenation.
- Enforces an executable allowlist and blocks shell interpreters.
- Requires explicit human approval before every agent stage.
- Captures terminal output on a background thread and updates Tkinter through a thread-safe queue.
- Stops the active process on request and applies a timeout.
- GitHub integration is read-only.
- This is a local desktop companion, not a cloud agent host. Agents execute with the permissions of the Windows user who launched the app. Review the configured CLI flags and working directory before approving.
- Pause is intentionally not emulated as stop; portable pause/resume is not reliable across arbitrary Windows CLI processes.
