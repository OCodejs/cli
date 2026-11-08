# OCode.js Auth Worker

Free-tier Cloudflare Workers + D1 implementation of the CLI Hub authentication API. This Worker is separate from the existing `ocodejs-cli` static-assets Worker.

## Bindings and variables

- D1 binding: `DB` → database `ocodejs-auth-db`
- Plain variables: `APP_ORIGIN=https://zskbot.github.io` and `APP_BASE_PATH=/ocodejs-cli/`
- Secrets: `SESSION_SECRET` (random, 48+ bytes), `TOKEN_ENCRYPTION_KEY` (base64-encoded 32-byte key), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

OAuth callback: `https://auth.ocodejs.dev/auth/github/callback`. After OAuth, the Worker redirects to `https://zskbot.github.io/ocodejs-cli/?auth=connected` (or `?auth=cancelled`) using `APP_BASE_PATH`. Create a dedicated GitHub OAuth App and set this exact callback. Until its client ID and secret are configured, PAT login works and OAuth responds with a clear 503 status.

## Security

- GitHub tokens are encrypted using AES-256-GCM with a Worker secret key.
- Session identifiers and CSRF tokens are HMAC-SHA256 hashed before storage.
- Session cookie is Secure, HttpOnly, SameSite=None for credentialed cross-site requests from `https://zskbot.github.io`; logout and disconnect clear it with matching attributes. Safari Intelligent Tracking Prevention and third-party-cookie restrictions may still block this architecture.
- Strict exact-origin CORS and Origin checks for credential-changing endpoints.
- OAuth state is random, single-use, expires after ten minutes, and is validated against an HttpOnly cookie.
- Auth endpoints are rate-limited per source IP using a hashed key.
- Request payload limits, fixed GitHub API origin, short upstream timeouts, no credential logging, and generic internal errors.
- Disconnect deletes stored encrypted credentials and all sessions. It does not revoke a PAT at GitHub; revoke it separately in GitHub Settings.

## Deployment

1. Create the D1 database and apply `migrations/0001_init.sql`.
2. Upload this module as Worker `ocodejs-auth` with D1 binding `DB`.
3. Set the variables and secrets listed above through Cloudflare's secret management API/dashboard.
4. Attach custom domain `auth.ocodejs.dev` to this Worker and set `APP_ORIGIN=https://zskbot.github.io` plus `APP_BASE_PATH=/ocodejs-cli/`.
5. Verify `GET /health`, `GET /auth/session`, OAuth callback and PAT connection.
6. Keep the existing `ocodejs-cli` Worker and all `app` / `mcp` DNS records unchanged.

Cloudflare D1 is available on Free and Paid plans. Free-plan daily query limits apply; monitor usage and do not enable paid billing for this project.


## Email and password accounts

The CLI Hub also supports email-address accounts through `POST /auth/register` and `POST /auth/login`. Email addresses are normalized to lowercase. Passwords must be 12–128 characters and are stored only as PBKDF2-HMAC-SHA256 hashes (310,000 iterations, unique random salt); plaintext passwords are never stored or logged. Email account sessions use a separate D1 table and the same HttpOnly, Secure, SameSite=None session cookie and CSRF protection.

Apply migration `migrations/0002_email_password.sql` before deploying this version. Email ownership verification and password-reset email delivery are not included in this first release; do not represent an email address as verified. Configure a transactional email provider and verification/reset flows before enabling account recovery or treating email ownership as verified.


## Email/password and Safari session transport

Apply `migrations/0003_email_auth.sql` to the existing `ocodejs-auth-db` D1 database before deploying this Worker version. It only creates the two email tables and their indexes; it does not alter existing GitHub auth tables or records.

Email passwords are hashed with PBKDF2-HMAC-SHA256 (310,000 iterations and a unique 128-bit salt). Session identifiers are stored only as HMAC hashes in D1. The API supports an Authorization Bearer session credential in addition to the HttpOnly cookie. The frontend keeps the short-lived session credential in sessionStorage and sends it over HTTPS with CSRF protection; this avoids depending on third-party cookies for GitHub Pages on iOS Safari. OAuth returns the one-time session credential in the URL fragment, which is immediately moved to sessionStorage and removed from the address bar.

Email ownership verification and password reset delivery are not implemented in this release. Do not treat an email as verified.

## Cloudflare Workers Builds

For the `ocodejs-auth` Preview build, configure the Workers Builds root directory as `/auth-worker`. The Wrangler configuration is in this directory; running `wrangler preview` from the repository root does not load `auth-worker/wrangler.jsonc` and fails with a missing `previews` block.

Use `npm test` as the build command and `npx wrangler preview` as the Preview deploy command. Keep the Preview D1 binding pointed at `ocodejs-auth-preview-db`, never the Production database. Configure `GITHUB_PREVIEW_CLIENT_ID` and `GITHUB_PREVIEW_CLIENT_SECRET` only in the Preview environment; do not copy Production OAuth credentials.

## Preview OAuth isolation

The staging Preview uses its own callback URL:
`https://staging-ocodejs-auth.huynhthuongg2505-f9b.workers.dev/auth/github/callback`.
Register a separate GitHub OAuth App with that exact callback URL and set its client ID and secret only in the Preview bindings. Do not reuse or replace the Production OAuth App credentials. Production continues to use `https://auth.ocodejs.dev/auth/github/callback`.

Preview credentials are deliberately separate from Production. On the staging Preview, set `GITHUB_PREVIEW_CLIENT_ID` as a Preview-only plain-text binding and `GITHUB_PREVIEW_CLIENT_SECRET` as a Preview-only secret. Do not copy the Production `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` into these Preview bindings. The Worker reports `oauthConfigured:false` and returns `503 github_oauth_not_configured` until both Preview-specific values exist.
