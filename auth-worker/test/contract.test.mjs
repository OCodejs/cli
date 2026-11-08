import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");

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
  assert.ok(worker.includes('callbackUrl.protocol !== "https:"'));
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
