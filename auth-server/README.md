# OCode.js Node Authentication Service

Independent Node.js 20+ backend for GitHub OAuth and user-supplied GitHub PATs. GitHub Pages remains a static frontend and must call this service over HTTPS. Secrets are never bundled into frontend assets.

## Security model
- OAuth authorization-code flow with random one-time 10-minute state, HttpOnly state cookie, and server-side code exchange.
- PAT accepted by POST /auth/pat over HTTPS; the token is never returned by the API.
- Credentials encrypted at rest using AES-256-GCM and TOKEN_ENCRYPTION_KEY.
- Opaque random sessions stored by keyed SHA-256/HMAC hash using SESSION_SECRET.
- HttpOnly session cookies; Secure and SameSite=None in production for cross-origin frontend/API calls.
- Mutating authenticated requests require exact Origin validation and a session-bound CSRF token.
- Exact-origin CORS, Helmet, request-size limits, rate limits, fixed GitHub API origin, generic error responses.
- Disconnect deletes the encrypted credential and all sessions for that GitHub account. It does not revoke a PAT at GitHub; users must revoke it in GitHub Settings.
- Logs omit request bodies, headers, tokens, OAuth codes, and exception messages.

## Local development
```bash
cp .env.example .env
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY
openssl rand -hex 48      # SESSION_SECRET
npm install
npm run dev
```
Create a GitHub OAuth App with callback URL http://localhost:8787/auth/github/callback. Set APP_ORIGIN to the exact frontend origin and run PostgreSQL. Schema is created on startup.

## Endpoints
- GET /health
- GET /auth/github — OAuth redirect
- GET /auth/github/callback — state validation, code exchange, session creation
- POST /auth/pat — JSON { "token": "..." }; response never contains the token
- GET /auth/session — connection status and fresh CSRF token
- POST /auth/logout — clear current session
- POST /auth/disconnect — delete stored credential and sessions
- GET /api/github/user
- GET /api/github/repos?page=1

Browser calls must use credentials: include. POST logout/disconnect require X-Ocode-CSRF from the latest session response.

## Production deployment requirements
1. Deploy auth-server as a separate Node service; GitHub Pages cannot run Node.
2. Configure all variables from .env.example in the host secret/environment manager. Never put them in GitHub source or frontend build variables.
3. Set NODE_ENV=production, HTTPS PUBLIC_API_URL, exact APP_ORIGIN, TLS PostgreSQL, and a unique 32-byte encryption key.
4. Prefer a custom domain with frontend and API on the same registrable site. Third-party cookie restrictions can block github.io frontend + unrelated API domain.
5. Use a dedicated OAuth App, least privilege, encrypted database backups, monitoring without secrets, and a key-rotation procedure.
6. Changing TOKEN_ENCRYPTION_KEY directly makes existing credentials unreadable; rotate with a decrypt/re-encrypt migration.

This commit adds the backend foundation and secret template. The public Pages UI is not yet wired to these endpoints, and no production service or OAuth app has been configured.
