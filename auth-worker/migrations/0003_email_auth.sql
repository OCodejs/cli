-- Additive email/password authentication schema for the existing OCodeJS D1 database.
-- Existing GitHub users, sessions, OAuth states, rate limits and secrets are untouched.
CREATE TABLE IF NOT EXISTS email_accounts (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_sessions (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY(email) REFERENCES email_accounts(email) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS email_sessions_expiry_idx ON email_sessions(expires_at);
CREATE INDEX IF NOT EXISTS email_sessions_user_idx ON email_sessions(email);
