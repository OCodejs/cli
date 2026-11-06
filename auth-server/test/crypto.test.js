import test from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret, encryptionKey, keyedHash, randomToken, sha256 } from "../src/crypto.js";

const key = Buffer.alloc(32, 7);

test("AES-256-GCM encrypts and decrypts credentials", () => {
  const token = "github_pat_test_value_that_is_not_a_real_credential";
  const encrypted = encryptSecret(token, key);
  assert.notEqual(encrypted, token);
  assert.equal(decryptSecret(encrypted, key), token);
});

test("AES-256-GCM rejects tampered ciphertext", () => {
  const encrypted = encryptSecret("test-secret", key);
  const [iv, tag, data] = encrypted.split(".");
  const bytes = Buffer.from(data, "base64");
  bytes[0] ^= 1;
  assert.throws(() => decryptSecret([iv, tag, bytes.toString("base64")].join(".")));
});

test("encryption key parser accepts exactly 32 bytes", () => {
  assert.equal(encryptionKey(key.toString("base64")).length, 32);
  assert.equal(encryptionKey(key.toString("hex")).length, 32);
  assert.throws(() => encryptionKey(Buffer.alloc(16, 1).toString("base64")), /exactly 32 bytes/);
});

test("session tokens are random and keyed hashes are deterministic", () => {
  const first = randomToken();
  const second = randomToken();
  assert.notEqual(first, second);
  assert.equal(keyedHash("session", "secret"), keyedHash("session", "secret"));
  assert.notEqual(keyedHash("session", "secret"), keyedHash("session", "other"));
  assert.equal(sha256("abc").length, 64);
});
