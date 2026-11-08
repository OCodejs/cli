import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

type SessionRow = {
  id_hash: string;
  github_id: string;
  csrf_hash: string;
  expires_at: number;
  github_login: string;
  token_ciphertext: string;
  scopes: string;
};

class FakeStatement {
  private args: unknown[] = [];

  constructor(private readonly sql: string, private readonly db: FakeD1) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async run(): Promise<{ success: true }> {
    this.db.executed.push({ sql: this.sql, args: this.args });
    return { success: true };
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes("DELETE FROM oauth_states")) {
      return (this.db.oauthStateAvailable ? { state_hash: "used" } : null) as T | null;
    }
    if (this.sql.startsWith("SELECT s.id_hash")) return this.db.session as T | null;
    return null;
  }
}

class FakeD1 {
  oauthStateAvailable = true;
  session: SessionRow | null = null;
  executed: Array<{ sql: string; args: unknown[] }> = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this);
  }
}

function base64Key(): string {
  const bytes = new Uint8Array(32).fill(7);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeEnv(db = new FakeD1()): Env & { DB: FakeD1 } {
  return {
    DB: db,
    APP_ORIGIN: "https://frontend.example",
    APP_BASE_PATH: "/app/",
    GITHUB_REDIRECT_URI: "https://auth.example/auth/github/callback",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: base64Key(),
    SESSION_TTL_SECONDS: "3600",
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Origin", "https://frontend.example");
  return new Request(`https://auth.example${path}`, { ...init, headers });
}

describe("GitHub OAuth Worker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns health and CORS headers", async () => {
    const response = await worker.fetch(request("/health"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "ocodejs-auth-worker" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://frontend.example");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("starts OAuth with state cookie and least-privilege scope", async () => {
    const db = new FakeD1();
    const response = await worker.fetch(request("/auth/github"), makeEnv(db));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("redirect_uri")).toBe("https://auth.example/auth/github/callback");
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(response.headers.get("Set-Cookie")).toContain("ocode_oauth_state=");
    expect(db.executed[0].sql).toContain("INSERT INTO oauth_states");
  });

  it("rejects a callback when state is missing or mismatched", async () => {
    const response = await worker.fetch(request("/auth/github/callback?code=code&state=wrong", { headers: { Cookie: "ocode_oauth_state=other" } }), makeEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "oauth_state_invalid" });
  });

  it("exchanges code, stores encrypted credential, creates session, and redirects", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const authorize = await worker.fetch(request("/auth/github"), env);
    const location = new URL(authorize.headers.get("Location")!);
    const state = location.searchParams.get("state")!;
    const stateCookie = authorize.headers.get("Set-Cookie")!.match(/ocode_oauth_state=([^;]+)/)![1];

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "oauth-token", scope: "read:user" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "octocat" }), { status: 200, headers: { "X-OAuth-Scopes": "read:user" } })));

    const response = await worker.fetch(request(`/auth/github/callback?code=temporary-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: `ocode_oauth_state=${stateCookie}` } }), env);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://frontend.example/app/?auth=connected");
    expect(response.headers.get("Set-Cookie")).toContain("ocode_session=");
    expect(db.executed.some(({ sql }) => sql.includes("INSERT INTO auth_users"))).toBe(true);
    expect(db.executed.some(({ sql }) => sql.includes("INSERT INTO auth_sessions"))).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("returns a fresh CSRF token for an existing session", async () => {
    const db = new FakeD1();
    db.session = { id_hash: "session-hash", github_id: "42", csrf_hash: "old", expires_at: Date.now() + 60_000, github_login: "octocat", token_ciphertext: "ciphertext", scopes: '["read:user"]' };
    const response = await worker.fetch(request("/auth/session", { headers: { Cookie: "ocode_session=session-id" } }), makeEnv(db));
    expect(response.status).toBe(200);
    const body = await response.json() as { connected: boolean; user: { login: string }; csrfToken: string };
    expect(body.connected).toBe(true);
    expect(body.user.login).toBe("octocat");
    expect(body.csrfToken).toBeTruthy();
    expect(db.executed.some(({ sql }) => sql.includes("UPDATE auth_sessions SET csrf_hash"))).toBe(true);
  });

  it("rejects protected API calls with a missing or invalid CSRF token", async () => {
    const db = new FakeD1();
    db.session = { id_hash: "session-hash", github_id: "42", csrf_hash: "expected-hash", expires_at: Date.now() + 60_000, github_login: "octocat", token_ciphertext: "ciphertext", scopes: "[]" };
    const response = await worker.fetch(request("/api/github/user", { headers: { Cookie: "ocode_session=session-id" } }), makeEnv(db));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "csrf_check_failed" });
  });

  it("returns GitHub user data only after valid session and CSRF", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    db.session = { id_hash: "session-hash", github_id: "42", csrf_hash: "placeholder", expires_at: Date.now() + 60_000, github_login: "octocat", token_ciphertext: "", scopes: "[]" };

    // Obtain a valid CSRF hash by creating a session through the real callback flow.
    const start = await worker.fetch(request("/auth/github"), env);
    const startUrl = new URL(start.headers.get("Location")!);
    const state = startUrl.searchParams.get("state")!;
    const stateCookie = start.headers.get("Set-Cookie")!.match(/ocode_oauth_state=([^;]+)/)![1];
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "oauth-token", scope: "read:user" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "octocat" }), { headers: { "X-OAuth-Scopes": "read:user" } })));
    const callback = await worker.fetch(request(`/auth/github/callback?code=code&state=${encodeURIComponent(state)}`, { headers: { Cookie: `ocode_oauth_state=${stateCookie}` } }), env);
    const sessionCookie = callback.headers.get("Set-Cookie")!.match(/ocode_session=([^;]+)/)![1];
    const userInsert = db.executed.find(({ sql }) => sql.includes("INSERT INTO auth_users"))!;
    const sessionInsert = db.executed.find(({ sql }) => sql.includes("INSERT INTO auth_sessions"))!;
    db.session!.id_hash = String(sessionInsert.args[0]);
    db.session!.csrf_hash = String(sessionInsert.args[2]);
    db.session!.token_ciphertext = String(userInsert.args[2]);
    const sessionResponse = await worker.fetch(request("/auth/session", { headers: { Cookie: `ocode_session=${sessionCookie}` } }), env);
    const sessionBody = await sessionResponse.json() as { csrfToken: string };
    // The fake stores the latest UPDATE argument as the expected hash.
    db.session!.csrf_hash = String(db.executed.findLast(({ sql }) => sql.includes("UPDATE auth_sessions SET csrf_hash"))!.args[0]);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "octocat", name: "The Octocat" })));

    const response = await worker.fetch(request("/api/github/user", { headers: { Cookie: `ocode_session=${sessionCookie}`, "X-Ocode-CSRF": sessionBody.csrfToken } }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ login: "octocat" });
  });
});
