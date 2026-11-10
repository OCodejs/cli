"""Local-first HTTP API for the OCode AI CLI web dashboard.

The server binds to loopback by default. It never executes terminal commands.
Configure an OpenAI-compatible endpoint with AI_API_KEY, AI_API_BASE and AI_MODEL.
"""
from __future__ import annotations

import json
import os
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
HOST = os.getenv("OCODE_WEB_HOST", "127.0.0.1")
PORT = int(os.getenv("OCODE_WEB_PORT", "8765"))
MAX_BODY = 64 * 1024


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "OCodeDashboard/1.0"

    def log_message(self, fmt, *args):
        print("[dashboard] " + (fmt % args))

    def send_json(self, status: int, payload: dict):
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            return self.send_json(200, {
                "ok": True, "service": "ocode-ai-dashboard",
                "chat_configured": bool(os.getenv("AI_API_KEY")),
                "model": os.getenv("AI_MODEL", "gpt-4o"),
                "timestamp": int(time.time()),
            })
        if self.path == "/api/github":
            return self.github_snapshot()
        if self.path in ("/", "/index.html"):
            return self.serve_index()
        return self.send_json(404, {"error": "Not found"})

    def serve_index(self):
        target = WEB_DIR / "index.html"
        if not target.is_file():
            return self.send_json(404, {"error": "Dashboard UI is missing"})
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                         "font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; "
                         "connect-src 'self'; img-src 'self' data:")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid Content-Length")
        if size < 1 or size > MAX_BODY:
            raise ValueError("Request body must be between 1 byte and 64 KB")
        raw = self.rfile.read(size)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Request body must be valid UTF-8 JSON")

    def do_POST(self):
        if self.path != "/api/chat":
            return self.send_json(404, {"error": "Not found"})
        try:
            data = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})
        message = data.get("message") if isinstance(data, dict) else None
        if not isinstance(message, str) or not message.strip():
            return self.send_json(400, {"error": "message is required"})
        if len(message) > 12000:
            return self.send_json(413, {"error": "message exceeds 12,000 characters"})
        api_key = os.getenv("AI_API_KEY")
        if not api_key:
            return self.send_json(503, {
                "error": "AI_API_KEY chưa được cấu hình. Hãy thiết lập biến môi trường để bật AI chat thật.",
                "code": "AI_NOT_CONFIGURED",
            })
        base = os.getenv("AI_API_BASE", "https://api.openai.com/v1").rstrip("/")
        model = os.getenv("AI_MODEL", "gpt-4o")
        payload = json_bytes({
            "model": model,
            "messages": [
                {"role": "system", "content": "You are OCode CLI assistant. Be concise, technical, and never claim to execute commands. This dashboard does not provide shell execution."},
                {"role": "user", "content": message.strip()},
            ],
            "temperature": 0.2,
        })
        request = Request(
            base + "/chat/completions", data=payload, method="POST",
            headers={"Authorization": "Bearer " + api_key,
                     "Content-Type": "application/json",
                     "Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=45) as response:
                result = json.loads(response.read(1024 * 1024).decode("utf-8"))
            answer = result["choices"][0]["message"]["content"]
            if not isinstance(answer, str):
                raise ValueError("Unexpected model response format")
            return self.send_json(200, {
                "ok": True, "model": model, "reply": answer,
                "usage": result.get("usage", {}),
            })
        except HTTPError as exc:
            detail = exc.read(4096).decode("utf-8", "replace")
            return self.send_json(502, {"error": "AI provider returned HTTP " + str(exc.code), "detail": detail})
        except (URLError, TimeoutError) as exc:
            return self.send_json(502, {"error": "Could not reach AI provider", "detail": str(exc)})
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            return self.send_json(502, {"error": "Invalid AI provider response", "detail": str(exc)})

    def github_snapshot(self):
        repository = os.getenv("GITHUB_REPOSITORY", "zskbot/ocodejs-cli")
        try:
            from core.github_client import GitHubClient
            client = GitHubClient(repository)
            prs = client.pull_requests("open")
            runs = client.workflow_runs(per_page=8)
            return self.send_json(200, {
                "ok": True, "repository": repository,
                "open_pull_requests": len(prs),
                "workflow_runs": [{
                    "name": item.get("name"), "status": item.get("status"),
                    "conclusion": item.get("conclusion"),
                    "branch": item.get("head_branch"),
                    "url": item.get("html_url"),
                } for item in runs],
            })
        except Exception as exc:
            return self.send_json(503, {"ok": False, "error": str(exc)})


def main():
    server = ThreadingHTTPServer((HOST, PORT), DashboardHandler)
    print(f"OCode AI Dashboard: http://{HOST}:{PORT}")
    print("Shell execution is not exposed by this web server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping dashboard...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
