export interface Env {
  DB: D1Database;
  APP_ORIGIN: string;
  APP_BASE_PATH: string;
  GITHUB_REDIRECT_URI: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  SESSION_TTL_SECONDS?: string;
}

const SESSION_COOKIE = "ocode_session";
const STATE_COOKIE = "ocode_oauth_state";
const DEFAULT_TTL = 7 * 24 * 60 * 60;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomToken(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const raw = base64ToBytes(env.TOKEN_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(token: string, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(token));
  const result = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.byteLength);
  return bytesToBase64Url(result);
}

async function decryptToken(value: string, env: Env): Promise<string> {
  const payload = base64ToBytes(value);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(0, 12) }, await encryptionKey(env), payload.slice(12));
  return new TextDecoder().decode(plaintext);
}

function ttl(env: Env): number {
  return Math.max(300, Number(env.SESSION_TTL_SECONDS || DEFAULT_TTL));
}

function cookie(name: string, value: string, maxAge: number, path: string): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=None`;
}

function clearCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; Secure; SameSite=None`;
}

function cors(request: Request, env: Env): Headers {
  const headers = new Headers({ "Access-Control-Allow-Origin": env.APP_ORIGIN, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "Content-Type, X-Ocode-CSRF", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin", "Cache-Control": "no-store" });
  if (request.headers.get("Origin") && request.headers.get("Origin") !== env.APP_ORIGIN) throw new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers: { "Content-Type": "application/json" } });
  return headers;
}

function json(data: unknown, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function redirectResponse(location: string, headers: Headers): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

async function githubTokenRequest(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ocodejs-auth-worker" } });
}

type TokenPayload = { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string; error?: string };

async function findSession(request: Request, env: Env) {
  const match = request.headers.get("Cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  const idHash = await hmac(id, env.SESSION_SECRET);
  return env.DB.prepare(`SELECT s.id_hash, s.github_id, s.csrf_hash, s.expires_at, u.github_login, u.token_ciphertext, u.refresh_token_ciphertext, u.access_token_expires_at, u.refresh_token_expires_at, u.scopes FROM auth_sessions s JOIN auth_users u ON u.github_id=s.github_id WHERE s.id_hash=? AND s.expires_at>?`).bind(idHash, Date.now()).first();
}

async function refreshAccessToken(session: Record<string, unknown>, env: Env): Promise<string> {
  const refreshCiphertext = session.refresh_token_ciphertext;
  if (typeof refreshCiphertext !== "string" || !refreshCiphertext) throw new Error("github_token_refresh_unavailable");
  const refreshExpiresAt = Number(session.refresh_token_expires_at || 0);
  if (refreshExpiresAt && refreshExpiresAt <= Date.now()) throw new Error("github_refresh_token_expired");
  const refreshToken = await decryptToken(refreshCiphertext, env);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const payload = await response.json() as TokenPayload;
  if (!response.ok || !payload.access_token) throw new Error("github_token_refresh_failed");
  const now = Date.now();
  const accessExpiresAt = payload.expires_in ? now + payload.expires_in * 1000 : null;
  const refreshExpiresAtNext = payload.refresh_token_expires_in ? now + payload.refresh_token_expires_in * 1000 : refreshExpiresAt || null;
  const nextRefreshCiphertext = payload.refresh_token ? await encryptToken(payload.refresh_token, env) : refreshCiphertext;
  const nextTokenCiphertext = await encryptToken(payload.access_token, env);
  await env.DB.prepare("UPDATE auth_users SET token_ciphertext=?, refresh_token_ciphertext=?, access_token_expires_at=?, refresh_token_expires_at=?, updated_at=? WHERE github_id=?").bind(nextTokenCiphertext, nextRefreshCiphertext, accessExpiresAt, refreshExpiresAtNext, now, session.github_id).run();
  session.token_ciphertext = nextTokenCiphertext;
  session.access_token_expires_at = accessExpiresAt;
  session.refresh_token_ciphertext = nextRefreshCiphertext;
  session.refresh_token_expires_at = refreshExpiresAtNext;
  return payload.access_token;
}

async function accessTokenForSession(session: Record<string, unknown>, env: Env): Promise<string> {
  const expiresAt = Number(session.access_token_expires_at || 0);
  if (expiresAt && expiresAt <= Date.now() + 30_000) return refreshAccessToken(session, env);
  return decryptToken(String(session.token_ciphertext), env);
}

async function requireCsrf(request: Request, env: Env) {
  const session = await findSession(request, env);
  if (!session) return { error: json({ error: "not_authenticated" }, 401) };
  const csrf = request.headers.get("X-Ocode-CSRF");
  if (!csrf || await hmac(csrf, env.SESSION_SECRET) !== session.csrf_hash) return { error: json({ error: "csrf_check_failed" }, 403) };
  return { session };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, service: "ocodejs-auth-worker" }, 200, headers);

      if (url.pathname === "/auth/github" && request.method === "GET") {
        const state = randomToken();
        await env.DB.prepare("INSERT INTO oauth_states(state_hash, expires_at) VALUES (?, ?)").bind(await sha256(state), Date.now() + 10 * 60 * 1000).run();
        const authorize = new URL("https://github.com/login/oauth/authorize");
        authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
        authorize.searchParams.set("redirect_uri", env.GITHUB_REDIRECT_URI);
        authorize.searchParams.set("scope", "read:user offline_access");
        authorize.searchParams.set("state", state);
        headers.append("Set-Cookie", cookie(STATE_COOKIE, state, 600, "/auth/github/callback"));
        return redirectResponse(authorize.toString(), headers);
      }

      if (url.pathname === "/auth/github/callback" && request.method === "GET") {
        const stateCookie = request.headers.get("Cookie")?.match(new RegExp(`${STATE_COOKIE}=([^;]+)`))?.[1];
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        headers.append("Set-Cookie", clearCookie(STATE_COOKIE, "/auth/github/callback"));
        if (!state || !code || !stateCookie || decodeURIComponent(stateCookie) !== state) return json({ error: "oauth_state_invalid" }, 400, headers);
        const used = await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING state_hash").bind(await sha256(state), Date.now()).first();
        if (!used) return json({ error: "oauth_state_expired_or_used" }, 400, headers);
        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: env.GITHUB_REDIRECT_URI }) });
        const tokenPayload = await tokenResponse.json() as TokenPayload;
        if (!tokenResponse.ok || !tokenPayload.access_token) return json({ error: "github_oauth_exchange_failed" }, 502, headers);
        const profileResponse = await githubTokenRequest("/user", tokenPayload.access_token);
        if (!profileResponse.ok) return json({ error: "github_profile_failed" }, 502, headers);
        const profile = await profileResponse.json() as { id: number; login: string };
        const scopes = (profileResponse.headers.get("X-OAuth-Scopes") || tokenPayload.scope || "").split(",").map((x) => x.trim()).filter(Boolean);
        const now = Date.now();
        const accessExpiresAt = tokenPayload.expires_in ? now + tokenPayload.expires_in * 1000 : null;
        const refreshExpiresAt = tokenPayload.refresh_token_expires_in ? now + tokenPayload.refresh_token_expires_in * 1000 : null;
        const tokenCiphertext = await encryptToken(tokenPayload.access_token, env);
        const refreshTokenCiphertext = tokenPayload.refresh_token ? await encryptToken(tokenPayload.refresh_token, env) : null;
        await env.DB.prepare("INSERT INTO auth_users(github_id, github_login, token_ciphertext, refresh_token_ciphertext, access_token_expires_at, refresh_token_expires_at, scopes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(github_id) DO UPDATE SET github_login=excluded.github_login, token_ciphertext=excluded.token_ciphertext, refresh_token_ciphertext=excluded.refresh_token_ciphertext, access_token_expires_at=excluded.access_token_expires_at, refresh_token_expires_at=excluded.refresh_token_expires_at, scopes=excluded.scopes, updated_at=excluded.updated_at").bind(String(profile.id), profile.login, tokenCiphertext, refreshTokenCiphertext, accessExpiresAt, refreshExpiresAt, JSON.stringify(scopes), now).run();
        const sessionId = randomToken();
        const csrf = randomToken();
        await env.DB.prepare("INSERT INTO auth_sessions(id_hash, github_id, csrf_hash, expires_at) VALUES (?, ?, ?, ?)").bind(await hmac(sessionId, env.SESSION_SECRET), String(profile.id), await hmac(csrf, env.SESSION_SECRET), Date.now() + ttl(env) * 1000).run();
        headers.append("Set-Cookie", cookie(SESSION_COOKIE, sessionId, ttl(env), "/"));
        const redirect = new URL(env.APP_ORIGIN + env.APP_BASE_PATH);
        redirect.searchParams.set("auth", "connected");
        return redirectResponse(redirect.toString(), headers);
      }

      if (url.pathname === "/auth/session" && request.method === "GET") {
        const session = await findSession(request, env);
        if (!session) return json({ connected: false }, 200, headers);
        const csrf = randomToken();
        await env.DB.prepare("UPDATE auth_sessions SET csrf_hash=? WHERE id_hash=?").bind(await hmac(csrf, env.SESSION_SECRET), session.id_hash).run();
        return json({ connected: true, user: { id: session.github_id, login: session.github_login, method: "oauth", scopes: JSON.parse(String(session.scopes || "[]")) }, csrfToken: csrf }, 200, headers);
      }

      if (url.pathname === "/api/github/user" && request.method === "GET") {
        const auth = await requireCsrf(request, env);
        if (auth.error) return json(await auth.error.json(), auth.error.status, headers);
        try {
          let token = await accessTokenForSession(auth.session, env);
          let response = await githubTokenRequest("/user", token);
          if (response.status === 401 && auth.session.refresh_token_ciphertext) {
            token = await refreshAccessToken(auth.session, env);
            response = await githubTokenRequest("/user", token);
          }
          if (!response.ok) return json({ error: "github_user_request_failed" }, 502, headers);
          return json(await response.json(), 200, headers);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("github_")) return json({ error: "github_token_refresh_failed" }, 502, headers);
          throw error;
        }
      }

      if (url.pathname === "/auth/logout" && request.method === "POST") {
        const auth = await requireCsrf(request, env);
        if (auth.error) return json(await auth.error.json(), auth.error.status, headers);
        await env.DB.prepare("DELETE FROM auth_sessions WHERE id_hash=?").bind(auth.session.id_hash).run();
        headers.append("Set-Cookie", clearCookie(SESSION_COOKIE, "/"));
        return json({ disconnected: true }, 200, headers);
      }

      return json({ error: "not_found" }, 404, headers);
    } catch (error) {
      console.error("request_failed", error instanceof Error ? error.name : "unknown");
      return json({ error: "internal_server_error" }, 500, headers);
    }
  },
};
