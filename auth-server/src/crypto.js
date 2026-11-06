import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export function encryptionKey(value) {
  if (!value) throw new Error("TOKEN_ENCRYPTION_KEY is required");
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}
export function encryptSecret(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(x => x.toString("base64")).join(".");
}
export function decryptSecret(value, key) {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64"));
  decipher.setAuthTag(Buffer.from(parts[1], "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
}

export const keyedHash = (value, secret) => createHmac('sha256', secret).update(value).digest('hex');
