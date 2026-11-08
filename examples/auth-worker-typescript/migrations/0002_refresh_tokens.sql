ALTER TABLE auth_users ADD COLUMN refresh_token_ciphertext TEXT;
ALTER TABLE auth_users ADD COLUMN access_token_expires_at INTEGER;
ALTER TABLE auth_users ADD COLUMN refresh_token_expires_at INTEGER;
