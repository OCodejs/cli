const COOKIE = "ocode_session";
const STATE_COOKIE = "ocode_oauth_state";
const SESSION_TTL = 7 * 24 * 60 * 60;
const COOKIE_SECURITY_ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax";
const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
function cookies(request) {
  return Object.fromEntries((request.headers.get("Cookie") || "").split(";").map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf("="); return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
  }));
}
function cookie(name, value, maxAge, path = "/", sameSite = "Lax") {
  return name + "=" + encodeURIComponent(value) + "; Path=" + path + "; Max-Age=" + maxAge + (sameSite === "Lax" ? "; " + COOKIE_SECURITY_ATTRIBUTES : "; HttpOnly; Secure; SameSite=" + sameSite);
}
function clearCookie(name, path = "/", sameSite = "Lax") {
  return name + "=; Path=" + path + "; Max-Age=0" + (sameSite === "Lax" ? "; " + COOKIE_SECURITY_ATTRIBUTES : "; HttpOnly; Secure; SameSite=" + sameSite);
}
function b64(bytes) {
  let binary = ""; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function unb64(value) {
  const input = String(value || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return Uint8Array.from(input.match(/.{2}/g), pair => parseInt(pair, 16));
  }
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0));
}
function b64url(bytes) { return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes); crypto.getRandomValues(data); return b64url(data);
}
async function sha256(value) {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}
async function encryptionKey(value) {
  if (!value) throw new Error("encryption_key_missing");
  let raw;
  try { raw = unb64(value); } catch { throw new Error("encryption_key_invalid_encoding"); }
  if (raw.byteLength !== 32) throw new Error("encryption_key_invalid_length");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptToken(token, env) {
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);
  const key = await encryptionKey(env.TOKEN_ENCRYPTION_KEY);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(token));
  return b64(iv) + "." + b64(ciphertext);
}
async function decryptToken(payload, env) {
  const [iv, ciphertext, extra] = payload.split(".");
  if (!iv || !ciphertext || extra) throw new Error("invalid_ciphertext");
  const key = await encryptionKey(env.TOKEN_ENCRYPTION_KEY);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ciphertext));
  return dec.decode(plaintext);
}
function githubOAuthConfig(env, requestUrl) {
  const callback = new URL(env.GITHUB_REDIRECT_URI || (requestUrl.origin + "/auth/github/callback"));
  const preview = callback.hostname.endsWith(".workers.dev");
  return preview
    ? { clientId: env.GITHUB_PREVIEW_CLIENT_ID, clientSecret: env.GITHUB_PREVIEW_CLIENT_SECRET, redirectUri: callback.toString() }
    : { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, redirectUri: callback.toString() };
}
function appUrl(env, query = "") {
  const segments = String(env.APP_BASE_PATH || "").split("/").filter(Boolean);
  const basePath = segments.length ? "/" + segments.join("/") + "/" : "/";
  let origin = String(env.APP_ORIGIN || "");
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  return origin + basePath + query;
}
function originAllowed(request, env) {
  return request.headers.get("Origin") === env.APP_ORIGIN;
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  if (origin !== env.APP_ORIGIN) return null;
  return { "Access-Control-Allow-Origin": env.APP_ORIGIN, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "Content-Type, X-Ocode-CSRF, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
async function rateLimit(request, env, windowMs = 900000, maximum = 20, identity = "") {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await sha256(identity || ip);
  const window = Math.floor(Date.now() / windowMs);
  const row = await env.DB.prepare("INSERT INTO auth_rate_limits(key_hash, window_id, hits) VALUES(?, ?, 1) ON CONFLICT(key_hash) DO UPDATE SET window_id=excluded.window_id, hits=CASE WHEN auth_rate_limits.window_id=excluded.window_id THEN auth_rate_limits.hits+1 ELSE 1 END RETURNING hits").bind(key, window).first();
  return Number(row?.hits || 0) <= maximum;
}
async function githubRequest(path, token, init = {}) {
  const response = await fetch("https://api.github.com" + path, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "OCodeJS-CLI-Hub", ...(init.headers || {}) },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(response.status === 401 ? "github_token_invalid" : "github_api_error");
  return { data: await response.json(), scopes: (response.headers.get("x-oauth-scopes") || "").split(",").map(x => x.trim()).filter(Boolean) };
}
async function saveCredential(user, token, kind, scopes, env) {
  let step = "token_encryption";
  try {
    const encrypted = await encryptToken(token, env);
    step = "d1_upsert";
    await env.DB.prepare("INSERT INTO auth_users(github_id, github_login, token_ciphertext, token_kind, scopes, updated_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(github_id) DO UPDATE SET github_login=excluded.github_login, token_ciphertext=excluded.token_ciphertext, token_kind=excluded.token_kind, scopes=excluded.scopes, updated_at=excluded.updated_at")
      .bind(String(user.id), user.login, encrypted, kind, JSON.stringify(scopes || []), Date.now()).run();
  } catch (error) {
    console.error("oauth_credential_persist_failed", { step, name: error instanceof Error ? error.name : "Error", code: error instanceof Error ? error.message : "unknown_error" });
    throw new Error("credential_" + step + "_failed");
  }
}
async function createSession(githubId, env) {
  const id = randomToken(), csrf = randomToken(), expires = Date.now() + SESSION_TTL * 1000;
  await env.DB.prepare("INSERT INTO auth_sessions(id_hash, github_id, csrf_hash, expires_at) VALUES(?, ?, ?, ?)").bind(await hmac(id, env.SESSION_SECRET), String(githubId), await hmac(csrf, env.SESSION_SECRET), expires).run();
  return { id, csrf };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}
function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
async function hashPassword(password) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, key, 256);
  return "pbkdf2$310000$" + b64url(salt) + "$" + b64url(bits);
}
async function verifyPassword(password, stored) {
  const [scheme, rounds, saltText, hashText, extra] = String(stored || "").split("$");
  if (scheme !== "pbkdf2" || rounds !== "310000" || !saltText || !hashText || extra) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unb64(saltText), iterations: 310000, hash: "SHA-256" }, key, 256);
  return b64url(bits) === hashText;
}
async function createEmailSession(email, env) {
  const id = randomToken(), csrf = randomToken(), expires = Date.now() + SESSION_TTL * 1000;
  await env.DB.prepare("INSERT INTO email_sessions(id_hash, email, csrf_hash, expires_at) VALUES(?, ?, ?, ?)").bind(await hmac(id, env.SESSION_SECRET), email, await hmac(csrf, env.SESSION_SECRET), expires).run();
  return { id, csrf };
}
async function findEmailSession(request, env) {
  const id = sessionCredential(request);
  if (!id || id.length > 128) return null;
  const row = await env.DB.prepare("SELECT s.id_hash, s.email, s.csrf_hash, s.expires_at, a.display_name FROM email_sessions s JOIN email_accounts a ON a.email=s.email WHERE s.id_hash=? AND s.expires_at>?").bind(await hmac(id, env.SESSION_SECRET), Date.now()).first();
  return row ? { ...row, auth_type: "email", github_id: "email:" + row.email, github_login: row.email, token_kind: "email", scopes: "[]" } : null;
}

function sessionCredential(request) {
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer ([A-Za-z0-9_-]{20,128})$/);
  return bearer?.[1] || cookies(request)[COOKIE];
}
async function findSession(request, env) {
  const id = sessionCredential(request);
  if (!id || id.length > 128) return null;
  const github = await env.DB.prepare("SELECT s.id_hash, s.github_id, s.csrf_hash, s.expires_at, u.github_login, u.token_ciphertext, u.token_kind, u.scopes FROM auth_sessions s JOIN auth_users u ON u.github_id=s.github_id WHERE s.id_hash=? AND s.expires_at>?").bind(await hmac(id, env.SESSION_SECRET), Date.now()).first();
  if (github) return { ...github, auth_type: "github" };
  return findEmailSession(request, env);
}
async function requireSession(request, env) {
  const session = await findSession(request, env);
  if (!session) return { error: json({ error: "not_authenticated" }, 401) };
  const csrf = request.headers.get("X-Ocode-CSRF");
  if (!csrf || await hmac(csrf, env.SESSION_SECRET) !== session.csrf_hash) return { error: json({ error: "csrf_check_failed" }, 403) };
  return { session };
}
function publicUser(row) {
  let scopes = []; try { scopes = JSON.parse(row.scopes || "[]"); } catch {}
  if (row.auth_type === "email") return { id: "email:" + row.email, login: row.email, email: row.email, name: row.display_name || "", method: "email", scopes: [] };
  return { id: String(row.github_id), login: row.github_login, method: row.token_kind, scopes };
}
async function githubProfile(token) {
  const result = await githubRequest("/user", token);
  const u = result.data;
  return { user: { id: String(u.id), login: u.login, name: u.name, avatar_url: u.avatar_url, html_url: u.html_url }, scopes: result.scopes };
}
async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/health" && request.method === "GET") {
    const oauth = githubOAuthConfig(env, url);
    return json({ ok: true, service: "ocodejs-auth-worker", patConfigured: Boolean(env.DB && env.SESSION_SECRET && env.TOKEN_ENCRYPTION_KEY), oauthConfigured: Boolean(oauth.clientId && oauth.clientSecret), emailPasswordConfigured: Boolean(env.DB && env.SESSION_SECRET) });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (path.startsWith("/auth/") && !(await rateLimit(request, env, 900000, 20))) return json({ error: "rate_limit_exceeded" }, 429);
  if (path.startsWith("/api/") && !(await rateLimit(request, env, 60000, 60))) return json({ error: "rate_limit_exceeded" }, 429);
  if (path === "/auth/github" && request.method === "GET") {
    const oauth = githubOAuthConfig(env, url);
    if (!oauth.clientId || !oauth.clientSecret) return json({ error: "github_oauth_not_configured" }, 503);
    const state = randomToken();
    const stateCookieName = STATE_COOKIE + "_" + state;
    // Keep the authorization transaction alive long enough for mobile Safari
    // app switching, while retaining a strict, one-time server-side state.
    await env.DB.prepare("INSERT INTO oauth_states(state_hash, expires_at) VALUES(?, ?)").bind(await sha256(state), Date.now() + 900000).run();
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", oauth.clientId);
    const callbackUrl = new URL(env.GITHUB_REDIRECT_URI || (url.origin + "/auth/github/callback"));
    if (callbackUrl.protocol !== "https:") return json({ error: "github_callback_misconfigured" }, 503);
    authorize.searchParams.set("redirect_uri", callbackUrl.toString());
    authorize.searchParams.set("scope", "read:user");
    authorize.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { Location: authorize.toString(), "Set-Cookie": cookie(stateCookieName, state, 900, "/auth/github/callback"), "Cache-Control": "no-store" } });
  }
  if (path === "/auth/github/callback" && request.method === "GET") {
    const state = url.searchParams.get("state"), code = url.searchParams.get("code");
    const stateCookieName = state && /^[A-Za-z0-9_-]{40,64}$/.test(state) ? STATE_COOKIE + "_" + state : STATE_COOKIE;
    const stateCookie = cookies(request)[stateCookieName];
    const headers = new Headers({ "Set-Cookie": clearCookie(stateCookieName, "/auth/github/callback"), "Cache-Control": "no-store" });
    const stateErrorPage = (reason) => new Response(
      "<!doctype html><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"dark\"><title>GitHub sign-in expired</title><main style=\"font:16px system-ui;max-width:36rem;margin:12vh auto;padding:28px;color:#eee;background:#111;border:1px solid #333\"><h1>Phiên GitHub đã hết hạn</h1><p>" + reason + "</p><p>Hãy bắt đầu lại từ OCode.js. Không tải lại trang callback này.</p><p><a style=\"display:inline-block;padding:12px 18px;background:#eee;color:#111;text-decoration:none\" href=\"" + url.origin + "/auth/github\">Thử đăng nhập GitHub lại</a></p><p><a style=\"color:#9abaff\" href=\"" + appUrl(env) + "\">Quay lại OCode.js</a></p></main>",
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": headers.get("Set-Cookie") } }
    );
    if (url.searchParams.has("error")) { headers.set("Location", appUrl(env, "?auth=cancelled")); return new Response(null, { status: 302, headers }); }
    if (!code || !state || !stateCookie || state !== stateCookie) return stateErrorPage("Không thể xác minh yêu cầu đăng nhập. Có thể bạn đã mở nhiều tab hoặc trình duyệt đã xóa cookie xác thực.");
    const valid = await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING state_hash").bind(await sha256(state), Date.now()).first();
    if (!valid) return stateErrorPage("Yêu cầu đăng nhập đã được sử dụng hoặc hết hạn. Vì lý do bảo mật, mỗi yêu cầu chỉ được dùng một lần.");
    let oauthStage = "token_exchange";
    try {
      const exchange = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: githubOAuthConfig(env, url).clientId, client_secret: githubOAuthConfig(env, url).clientSecret, code, redirect_uri: githubOAuthConfig(env, url).redirectUri }), signal: AbortSignal.timeout(12000) });
      const payload = await exchange.json();
      if (!exchange.ok || !payload.access_token) return new Response("GitHub OAuth exchange failed", { status: 400, headers });
      oauthStage = "github_profile";
      const profile = await githubProfile(payload.access_token);
      oauthStage = "credential_encryption_and_d1";
      await saveCredential(profile.user, payload.access_token, "oauth", profile.scopes, env);
      oauthStage = "session_creation";
      const session = await createSession(profile.user.id, env);
      headers.append("Set-Cookie", cookie(COOKIE, session.id, SESSION_TTL, "/", "None"));
      headers.set("Location", appUrl(env, "?auth=connected#page=home&auth_session=" + encodeURIComponent(session.id)));
      return new Response(null, { status: 302, headers });
    } catch (error) {
      const diagnostic = error instanceof Error && /^credential_(token_encryption|d1_upsert)_failed$/.test(error.message) ? error.message : "internal_error";
      console.error("oauth_callback_failed", { stage: oauthStage, diagnostic });
      headers.delete("Set-Cookie");
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response("<!doctype html><meta name=\"viewport\" content=\"width=device-width\"><title>OCode.js sign-in error</title><main style=\"font:16px system-ui;max-width:34rem;margin:12vh auto;padding:24px;color:#eee;background:#111\"><h1>GitHub sign-in failed</h1><p>OCode.js could not complete GitHub authentication.</p><p>Diagnostic stage: <code>" + oauthStage + "/" + diagnostic + "</code></p><p><a style=\"color:#9abaff\" href=\"" + appUrl(env) + "\">Return to OCode.js</a></p></main>", { status: 502, headers });
    }
  }
  if (path === "/auth/register" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "origin_not_allowed" }, 403);
    const raw = await request.text(); if (raw.length > 4000) return json({ error: "request_too_large" }, 413);
    let body; try { body = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }
    const email = normalizeEmail(body?.email), password = body?.password, passwordConfirmation = body?.passwordConfirmation, turnstileToken = body?.turnstileToken, displayName = String(body?.name || "").trim().slice(0, 80);
    if (!validEmail(email)) return json({ error: "invalid_email" }, 400);
    if (typeof password !== "string" || password.length < 12 || password.length > 128) return json({ error: "password_policy" }, 400);
    if (password !== passwordConfirmation) return json({ error: "password_mismatch" }, 400);
    if (typeof turnstileToken !== "string" || !turnstileToken || turnstileToken.length > 2048) return json({ error: "turnstile_required" }, 400);
    if (!env.TURNSTILE_SECRET_KEY) return json({ error: "turnstile_not_configured" }, 503);
    const verification = new FormData();
    verification.set("secret", env.TURNSTILE_SECRET_KEY);
    verification.set("response", turnstileToken);
    const remoteIp = request.headers.get("CF-Connecting-IP");
    if (remoteIp) verification.set("remoteip", remoteIp);
    verification.set("idempotency_key", crypto.randomUUID());
    let challenge;
    try {
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: verification, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return json({ error: "turnstile_failed" }, 403);
      challenge = await response.json();
    } catch { return json({ error: "turnstile_failed" }, 403); }
    if (!challenge.success || challenge.hostname !== "zskbot.github.io" || challenge.action !== "register") return json({ error: "turnstile_failed" }, 403);
    // Keep the shared IP-wide /auth limiter; scope the stricter registration quota to the normalized email.
    if (!(await rateLimit(request, env, 900000, 5, "register-email:" + email))) return json({ error: "rate_limit_exceeded" }, 429);
    const passwordHash = await hashPassword(password);
    try {
      await env.DB.prepare("INSERT INTO email_accounts(email, display_name, password_hash, created_at, updated_at) VALUES(?, ?, ?, ?, ?)").bind(email, displayName, passwordHash, Date.now(), Date.now()).run();
    } catch { return json({ error: "email_already_registered" }, 409); }
    const session = await createEmailSession(email, env);
    return json({ created: true, connected: true, sessionToken: session.id, user: { id: "email:" + email, login: email, email, name: displayName, method: "email" }, csrfToken: session.csrf }, 201, { "Set-Cookie": cookie(COOKIE, session.id, SESSION_TTL, "/", "None") });
  }
  if (path === "/auth/login" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "origin_not_allowed" }, 403);
    if (!(await rateLimit(request, env, 900000, 8))) return json({ error: "rate_limit_exceeded" }, 429);
    const raw = await request.text(); if (raw.length > 4000) return json({ error: "request_too_large" }, 413);
    let body; try { body = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }
    const email = normalizeEmail(body?.email), password = body?.password;
    if (!validEmail(email) || typeof password !== "string" || password.length > 128) return json({ error: "invalid_credentials" }, 401);
    const account = await env.DB.prepare("SELECT email, display_name, password_hash FROM email_accounts WHERE email=?").bind(email).first();
    if (!account || !(await verifyPassword(password, account.password_hash))) return json({ error: "invalid_credentials" }, 401);
    const session = await createEmailSession(email, env);
    return json({ connected: true, sessionToken: session.id, user: { id: "email:" + email, login: email, email, name: account.display_name || "", method: "email" }, csrfToken: session.csrf }, 200, { "Set-Cookie": cookie(COOKIE, session.id, SESSION_TTL, "/", "None") });
  }
  if (path === "/auth/pat" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "origin_not_allowed" }, 403);
    const raw = await request.text();
    if (raw.length > 16000) return json({ error: "request_too_large" }, 413);
    let body; try { body = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }
    const token = body?.token;
    if (typeof token !== "string" || token.length < 20 || token.length > 500 || /\s/.test(token)) return json({ error: "invalid_token_format" }, 400);
    try {
      const profile = await githubProfile(token);
      await saveCredential(profile.user, token, "pat", profile.scopes, env);
      const session = await createSession(profile.user.id, env);
      return json({ connected: true, sessionToken: session.id, user: { id: profile.user.id, login: profile.user.login, method: "pat", scopes: profile.scopes }, csrfToken: session.csrf }, 201, { "Set-Cookie": cookie(COOKIE, session.id, SESSION_TTL, "/", "None") });
    } catch (error) {
      if (error.message === "github_token_invalid") return json({ error: "github_token_invalid" }, 401);
      return json({ error: "pat_connection_failed" }, 502);
    }
  }
  if (path === "/auth/session" && request.method === "GET") {
    const session = await findSession(request, env);
    if (!session) return json({ connected: false });
    const csrf = randomToken();
    if (session.auth_type === "email") {
      await env.DB.prepare("UPDATE email_sessions SET csrf_hash=? WHERE id_hash=?").bind(await hmac(csrf, env.SESSION_SECRET), session.id_hash).run();
    } else {
      await env.DB.prepare("UPDATE auth_sessions SET csrf_hash=? WHERE id_hash=?").bind(await hmac(csrf, env.SESSION_SECRET), session.id_hash).run();
    }
    return json({ connected: true, user: publicUser(session), csrfToken: csrf });
  }
  if (path === "/auth/logout" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "origin_not_allowed" }, 403);
    const auth = await requireSession(request, env); if (auth.error) return auth.error;
    await env.DB.prepare("DELETE FROM auth_sessions WHERE id_hash=?").bind(auth.session.id_hash).run();
    await env.DB.prepare("DELETE FROM email_sessions WHERE id_hash=?").bind(auth.session.id_hash).run();
    return json({ disconnected: true }, 200, { "Set-Cookie": clearCookie(COOKIE, "/", "None") });
  }
  if (path === "/auth/disconnect" && request.method === "POST") {
    if (!originAllowed(request, env)) return json({ error: "origin_not_allowed" }, 403);
    const auth = await requireSession(request, env); if (auth.error) return auth.error;
    if (auth.session.auth_type === "email") {
      await env.DB.prepare("DELETE FROM email_sessions WHERE email=?").bind(auth.session.email).run();
      await env.DB.prepare("DELETE FROM email_accounts WHERE email=?").bind(auth.session.email).run();
    } else {
      await env.DB.prepare("DELETE FROM auth_sessions WHERE github_id=?").bind(auth.session.github_id).run();
      await env.DB.prepare("DELETE FROM auth_users WHERE github_id=?").bind(auth.session.github_id).run();
    }
    return json({ disconnected: true, credentialsDeleted: true }, 200, { "Set-Cookie": clearCookie(COOKIE, "/", "None") });
  }
  if (path === "/api/github/user" && request.method === "GET") {
    if (!originAllowed(request, env)) return json({ error: "origin_not_allowed" }, 403);
    const auth = await requireSession(request, env); if (auth.error) return auth.error;
    if (auth.session.auth_type !== "github") return json({ error: "github_account_required" }, 403);
    try {
      const token = await decryptToken(auth.session.token_ciphertext, env);
      const profile = await githubProfile(token);
      return json(profile.user);
    } catch { return json({ error: "github_user_request_failed" }, 502); }
  }
  if (path === "/api/github/repos" && request.method === "GET") {
    if (!originAllowed(request, env)) return json({ error: "origin_not_allowed" }, 403);
    const auth = await requireSession(request, env); if (auth.error) return auth.error;
    if (auth.session.auth_type !== "github") return json({ error: "github_account_required" }, 403);
    try {
      const token = await decryptToken(auth.session.token_ciphertext, env);
      const page = Math.min(10, Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
      const result = await githubRequest("/user/repos?per_page=100&sort=updated&page=" + page, token);
      return json(result.data.map(r => ({ id: r.id, name: r.name, full_name: r.full_name, private: r.private, html_url: r.html_url, description: r.description, updated_at: r.updated_at })));
    } catch { return json({ error: "github_repos_request_failed" }, 502); }
  }
  return json({ error: "not_found" }, 404);
}
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (cors === null) return json({ error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors || {} });
    try {
      const response = await handle(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors || {})) headers.set(key, value);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      return json({ error: "internal_server_error" }, 500, cors || {});
    }
  }
};
