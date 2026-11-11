import pg from "pg";
const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000
});
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      github_id BIGINT PRIMARY KEY, github_login TEXT NOT NULL,
      token_ciphertext TEXT NOT NULL, token_kind TEXT NOT NULL CHECK(token_kind IN ('oauth','pat')),
      scopes TEXT[] NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id_hash TEXT PRIMARY KEY, github_id BIGINT NOT NULL REFERENCES auth_users(github_id) ON DELETE CASCADE,
      csrf_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL);
  `);
  await pool.query("DELETE FROM auth_sessions WHERE expires_at < NOW()");
  await pool.query("DELETE FROM oauth_states WHERE expires_at < NOW()");
}
