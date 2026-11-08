import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const frontend = await readFile(new URL("../../index.html", import.meta.url), "utf8");
const wranglerConfig = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
import authWorker from "../src/index.js";

test("Cloudflare auth Worker is valid JavaScript module syntax", () => {
  assert.doesNotThrow(() => new Function(worker.replace("export default", "return")));
});

test("Worker exposes all CLI Hub auth routes", () => {
  for (const route of [
    'path === "/health"',
    'path === "/auth/github"',
    'path === "/auth/github/callback"',
    'path === "/auth/pat"',
    'path === "/auth/session"',
    'path === "/auth/logout"',
    'path === "/auth/disconnect"',
    'path === "/api/github/user"',
    'path === "/api/github/repos"'
  ]) assert.ok(worker.includes(route), "missing route " + route);
});

test("Worker protects tokens and sessions with encryption, HMAC, cookies and CSRF", () => {
  for (const required of [
    'name: "AES-GCM"',
    'name: "HMAC"',
    'HttpOnly; Secure; SameSite=Lax',
    'X-Ocode-CSRF',
    'oauth_states',
    'originAllowed(request, env)',
    'rateLimit(request, env, 60000, 60)',
    'github_token_invalid',
    'TOKEN_ENCRYPTION_KEY',
    'SESSION_SECRET'
  ]) assert.ok(worker.includes(required), "missing security control " + required);
  assert.doesNotMatch(worker, /console\.(?:log|error)\([^\n]*(?:token|secret|credential|authorization)/i);
});

test("D1 migration creates only auth-owned tables and indexes", () => {
  for (const table of ["auth_users","auth_sessions","oauth_states","auth_rate_limits"]) {
    assert.match(migration, new RegExp("CREATE TABLE IF NOT EXISTS " + table));
  }
  assert.match(migration, /token_ciphertext TEXT NOT NULL/);
  assert.match(migration, /FOREIGN KEY\(github_id\) REFERENCES auth_users/);
  assert.match(migration, /auth_sessions_expiry_idx/);
});

test("GitHub OAuth Preview uses an explicit HTTPS callback override", () => {
  assert.ok(worker.includes("env.GITHUB_REDIRECT_URI"));
  assert.ok(worker.includes("env.GITHUB_PREVIEW_CLIENT_ID"));
  assert.ok(worker.includes("env.GITHUB_PREVIEW_CLIENT_SECRET"));
  assert.ok(worker.includes('callbackUrl.protocol !== "https:"'));
});

test("Wrangler Preview uses an isolated D1 database and explicit staging callback", () => {
  assert.ok(wranglerConfig.previews, "missing Wrangler previews configuration");
  assert.equal(wranglerConfig.previews.vars.APP_ORIGIN, wranglerConfig.vars.APP_ORIGIN);
  assert.match(wranglerConfig.previews.vars.GITHUB_REDIRECT_URI, /^https:\/\/.+\.workers\.dev\/auth\/github\/callback$/);
  assert.equal(wranglerConfig.previews.d1_databases[0].binding, "DB");
  assert.notEqual(
    wranglerConfig.previews.d1_databases[0].database_id,
    wranglerConfig.d1_databases[0].database_id,
    "Preview must never bind to the Production D1 database"
  );
});

test("PAT authentication returns a Bearer-compatible session credential", () => {
  const patRoute = worker.slice(worker.indexOf('path === "/auth/pat"'), worker.indexOf('path === "/auth/session"'));
  assert.ok(patRoute.includes("sessionToken: session.id"));
});

test("Turnstile registration is verified server-side for the expected host and action", () => {
  assert.ok(worker.includes("challenges.cloudflare.com/turnstile/v0/siteverify"));
  assert.ok(worker.includes('challenge.hostname !== "zskbot.github.io"'));
  assert.ok(worker.includes('challenge.action !== "register"'));
});

test("CORS preflight, CSRF logout, and Bearer sessions are implemented", () => {
  assert.ok(worker.includes('if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors || {} });'));
  assert.ok(worker.includes('"Access-Control-Allow-Headers": "Content-Type, X-Ocode-CSRF, Authorization"'));
  assert.ok(worker.includes('if (!csrf || await hmac(csrf, env.SESSION_SECRET) !== session.csrf_hash)'));
  assert.ok(worker.includes('const bearer = authorization.match(/^Bearer ([A-Za-z0-9_-]{20,128})$/)'));
});

function fakeEnv(extra = {}, firstHook = () => null) {
  const statements = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              statements.push({ sql, args, method: "first" });
              if (sql.includes("INSERT INTO auth_rate_limits")) return { hits: 1 };
              return firstHook(sql, args);
            },
            run: async () => {
              statements.push({ sql, args, method: "run" });
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  return { env: {
    APP_ORIGIN: "https://zskbot.github.io",
    APP_BASE_PATH: "/ocodejs-cli/",
    SESSION_SECRET: "test-session-secret-that-is-long-enough-for-hmac",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    DB,
    ...extra
  }, statements };
}

function mockFetch(t, handler) {
  return t.mock.method(globalThis, "fetch", handler);
}

test("CORS preflight returns exact origin, credentials, methods, and required headers", async () => {
  const { env } = fakeEnv();
  const response = await authWorker.fetch(new Request("https://auth.test/auth/login", {
    method: "OPTIONS",
    headers: {
      Origin: env.APP_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-ocode-csrf,authorization"
    }
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), env.APP_ORIGIN);
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /X-Ocode-CSRF/);
});

test("CORS rejects an untrusted origin", async () => {
  const { env } = fakeEnv();
  const response = await authWorker.fetch(new Request("https://auth.test/auth/login", {
    method: "OPTIONS", headers: { Origin: "https://attacker.example" }
  }), env);
  assert.equal(response.status, 403);
});

test("GitHub OAuth redirects to the explicit Preview callback and exchanges the code", async (t) => {
  const callback = "https://staging-ocodejs-auth.huynhthuongg2505-f9b.workers.dev/auth/github/callback";
  const { env } = fakeEnv({
    GITHUB_PREVIEW_CLIENT_ID: "preview-client-id",
    GITHUB_PREVIEW_CLIENT_SECRET: "preview-client-secret",
    GITHUB_REDIRECT_URI: callback
  }, (sql, args) => sql.includes("DELETE FROM oauth_states") ? { state_hash: args[0] } : null);
  mockFetch(t, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      assert.equal(init.method, "POST");
      const exchangeBody = JSON.parse(init.body);
      assert.equal(exchangeBody.redirect_uri, callback);
      assert.equal(exchangeBody.code, "mock-code");
      return Response.json({ access_token: "mock-github-access-token" });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return new Response(JSON.stringify({ id: 12345, login: "preview-user", name: "Preview User" }), {
        status: 200, headers: { "content-type": "application/json", "x-oauth-scopes": "read:user" }
      });
    }
    throw new Error("Unexpected upstream URL: " + url.href);
  });
  const start = await authWorker.fetch(new Request("https://preview.test/auth/github"), env);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("Location"));
  assert.equal(authorize.searchParams.get("redirect_uri"), callback);
  const state = authorize.searchParams.get("state");
  const stateCookie = start.headers.get("Set-Cookie").split(";")[0];
  const finish = await authWorker.fetch(new Request("https://preview.test/auth/github/callback?code=mock-code&state=" + state, {
    headers: { Cookie: stateCookie }
  }), env);
  assert.equal(finish.status, 302);
  assert.match(finish.headers.get("Location"), /auth=connected/);
  assert.match(finish.headers.get("Location"), /auth_session=/);
});

test("Gmail/password registration requires confirmation and validates Turnstile server-side", async (t) => {
  const { env, statements } = fakeEnv();
  mockFetch(t, async (input, init = {}) => {
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const form = init.body;
    assert.equal(form.get("response"), "mock-valid-turnstile-token");
    return Response.json({ success: true, hostname: "zskbot.github.io", action: "register" });
  });
  const response = await authWorker.fetch(new Request("https://auth.test/auth/register", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "preview-user@example.com",
      password: "StrongPassword123!",
      passwordConfirmation: "StrongPassword123!",
      turnstileToken: "mock-valid-turnstile-token"
    })
  }), env);
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.created, true);
  assert.ok(body.sessionToken);
  assert.ok(body.csrfToken);
  assert.ok(statements.some(x => x.sql.includes("INSERT INTO email_accounts")));
  assert.ok(statements.some(x => x.sql.includes("INSERT INTO email_sessions")));
});

test("Gmail registration rate limit is scoped to normalized email, not shared IP", async (t) => {
  const { env, statements } = fakeEnv();
  mockFetch(t, async () => Response.json({ success: true, hostname: "zskbot.github.io", action: "register" }));
  const response = await authWorker.fetch(new Request("https://auth.test/auth/register", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "CF-Connecting-IP": "203.0.113.10", "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "Agent@Example.com",
      password: "StrongPassword123!",
      passwordConfirmation: "StrongPassword123!",
      turnstileToken: "mock-valid-turnstile-token"
    })
  }), env);
  assert.equal(response.status, 201);
  const limitKeys = statements.filter(x => x.sql.includes("INSERT INTO auth_rate_limits")).map(x => x.args[0]);
  const expectedEmailKey = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("register-email:agent@example.com"))).toString("base64url");
  assert.ok(limitKeys.includes(expectedEmailKey), "registration must consume a per-email quota");
  assert.equal(new Set(limitKeys).size, 2, "IP-wide and email-specific quotas must be independent");
});

test("Gmail/password registration rejects an invalid Turnstile token without creating an account", async (t) => {
  const { env, statements } = fakeEnv();
  mockFetch(t, async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }));
  const response = await authWorker.fetch(new Request("https://auth.test/auth/register", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "blocked@example.com",
      password: "StrongPassword123!",
      passwordConfirmation: "StrongPassword123!",
      turnstileToken: "invalid-token"
    })
  }), env);
  assert.equal(response.status, 403);
  assert.ok(!statements.some(x => x.sql.includes("INSERT INTO email_accounts")));
});

test("PAT exchange returns the Bearer session token and stores only encrypted credentials", async (t) => {
  const { env, statements } = fakeEnv();
  mockFetch(t, async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.github.com");
    assert.equal(url.pathname, "/user");
    return new Response(JSON.stringify({ id: 9876, login: "pat-preview-user" }), {
      status: 200, headers: { "content-type": "application/json", "x-oauth-scopes": "repo" }
    });
  });
  const response = await authWorker.fetch(new Request("https://auth.test/auth/pat", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "ghp_mock_preview_token_1234567890" })
  }), env);
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.ok(body.sessionToken);
  assert.equal(body.user.login, "pat-preview-user");
  const saved = statements.find(x => x.sql.includes("INSERT INTO auth_users"));
  assert.ok(saved);
  assert.notEqual(saved.args[2], "ghp_mock_preview_token_1234567890");
  assert.ok(statements.some(x => x.sql.includes("INSERT INTO auth_sessions")));
});

test("Logout rejects a missing or invalid CSRF token", async () => {
  const sessionRow = {
    id_hash: "stored-session-hash", github_id: "123", csrf_hash: "not-the-csrf-hash",
    expires_at: Date.now() + 60000, github_login: "preview-user",
    token_ciphertext: "unused", token_kind: "pat", scopes: "[]"
  };
  const { env, statements } = fakeEnv({}, (sql) => sql.includes("SELECT s.id_hash, s.github_id") ? sessionRow : null);
  const response = await authWorker.fetch(new Request("https://auth.test/auth/logout", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, Authorization: "Bearer 12345678901234567890123456789012" }
  }), env);
  assert.equal(response.status, 403);
  assert.ok(!statements.some(x => x.sql.includes("DELETE FROM auth_sessions")));
});

test("iPhone Safari transport uses sessionStorage Bearer tokens without third-party cookies", () => {
  assert.ok(frontend.includes('sessionStorage.getItem("ocodejs_session_token")'));
  assert.ok(frontend.includes('headers.Authorization="Bearer "+token'));
  assert.ok(frontend.includes('credentials:"omit"'));
});

test("Preview OAuth does not fall back to Production GitHub credentials", async () => {
  const { env } = fakeEnv({
    GITHUB_CLIENT_ID: "production-client-id",
    GITHUB_CLIENT_SECRET: "production-client-secret",
    GITHUB_REDIRECT_URI: "https://staging-ocodejs-auth.huynhthuongg2505-f9b.workers.dev/auth/github/callback"
  });
  const health = await authWorker.fetch(new Request("https://preview.test/health"), env);
  const healthBody = await health.json();
  assert.equal(healthBody.oauthConfigured, false);
  const start = await authWorker.fetch(new Request("https://preview.test/auth/github"), env);
  assert.equal(start.status, 503);
  assert.equal((await start.json()).error, "github_oauth_not_configured");
});

test("Gmail/password login verifies the PBKDF2 hash and creates a Bearer session", async () => {
  const password = "StrongPassword123!";
  const salt = new Uint8Array(16).fill(5);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", salt, iterations:310000, hash:"SHA-256" }, key, 256);
  const saltText = Buffer.from(salt).toString("base64url");
  const hashText = Buffer.from(bits).toString("base64url");
  const passwordHash = "pbkdf2$310000$" + saltText + "$" + hashText;
  const { env, statements } = fakeEnv({}, (sql) => sql.includes("SELECT email, display_name, password_hash FROM email_accounts")
    ? { email:"login-preview@example.com", display_name:"Preview", password_hash:passwordHash }
    : null);
  const response = await authWorker.fetch(new Request("https://auth.test/auth/login", {
    method:"POST",
    headers:{ Origin:env.APP_ORIGIN, "Content-Type":"application/json" },
    body:JSON.stringify({ email:"login-preview@example.com", password })
  }), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.connected, true);
  assert.ok(body.sessionToken);
  assert.ok(body.csrfToken);
  assert.ok(statements.some(x => x.sql.includes("INSERT INTO email_sessions")));
});
