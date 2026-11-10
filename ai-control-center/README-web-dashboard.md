# OCode AI CLI Web Dashboard

A local-first dark terminal dashboard for the existing `ai-control-center` project.

## Run
```bash
python -m pip install -r ai-control-center/requirements.txt
python ai-control-center/server.py
```
Open http://127.0.0.1:8765.

## Enable real AI chat (optional)
Set `AI_API_KEY`, `AI_API_BASE` and `AI_MODEL` in the server environment. Keep provider credentials server-side, never in browser code. The server-side `AI_MODEL` is authoritative.

## GitHub telemetry
The read-only `/api/github` endpoint reads open pull requests and recent Actions runs using the existing `GitHubClient`. For private repositories, set `GITHUB_TOKEN`. Optionally set `GITHUB_REPOSITORY`; default is `zskbot/ocodejs-cli`.

## Host metrics
The read-only `/api/metrics` endpoint reports actual host CPU, memory, disk utilization, and this dashboard process's resident memory via `psutil`. Values refresh from the running host. Token usage is not fabricated or shown as a host metric.

## Security boundaries
- Binds to `127.0.0.1` by default. Do not expose publicly without authentication, TLS, and a deployment security review.
- Provider credentials stay server-side.
- No shell execution, arbitrary command endpoint, filesystem browser, or deployment trigger is exposed.
- Request body and chat input sizes are bounded.
- AI chat is disabled until `AI_API_KEY` is configured.
