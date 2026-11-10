# OCode AI CLI Web Dashboard

A local-first, dark terminal dashboard for the existing `ai-control-center` project.

## Run

From the repository root:

```bash
python -m pip install -r ai-control-center/requirements.txt
python ai-control-center/server.py
```

Open http://127.0.0.1:8765.

## Enable real AI chat (optional)

The dashboard calls an OpenAI-compatible Chat Completions endpoint from the Python server. Keep provider credentials on the server; never paste API keys into browser code.

Linux/macOS:

```bash
export AI_API_KEY="your-provider-key"
export AI_API_BASE="https://api.openai.com/v1"
export AI_MODEL="gpt-4o"
python ai-control-center/server.py
```

PowerShell:

```powershell
$env:AI_API_KEY = "your-provider-key"
$env:AI_API_BASE = "https://api.openai.com/v1"
$env:AI_MODEL = "gpt-4o"
python ai-control-center/server.py
```

For a compatible gateway, set `AI_API_BASE` and `AI_MODEL` to the provider's supported values. The UI model selector is currently a display preference; the server-side `AI_MODEL` is authoritative.

## GitHub telemetry

The read-only `/api/github` endpoint reads open pull requests and recent Actions runs using the existing `GitHubClient`. For private repositories, set `GITHUB_TOKEN` in the server environment. Optionally set `GITHUB_REPOSITORY`; default is `zskbot/ocodejs-cli`.

## Security boundaries

- Binds to `127.0.0.1` by default. Do not expose it publicly without authentication, TLS, and a deployment security review.
- No browser-to-provider API key exposure.
- No shell execution, arbitrary command endpoint, filesystem browser, or deployment trigger is exposed by this dashboard.
- Request body and chat input sizes are bounded.
- AI chat is disabled until `AI_API_KEY` is configured.
- Telemetry resource/token figures are illustrative UI values; they are not measured host metrics.
