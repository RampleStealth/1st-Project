import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const cursorDerivationSalt = Buffer.from("aio/key-derivation-salt/v1", "utf8");
const cursorDerivationContext = Buffer.from("aio/thread-pagination-cursor/v1", "utf8");

function masterKey(keyBase64: string) {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  return key;
}

/** Derives a purpose-specific AES-256 key; master-key encryption behavior remains unchanged. */
export function deriveThreadCursorKey(masterKeyBase64: string): string {
  return Buffer.from(hkdfSync("sha256", masterKey(masterKeyBase64), cursorDerivationSalt, cursorDerivationContext, 32)).toString("base64");
}

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = masterKey(keyBase64);
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const key = masterKey(keyBase64);
  const bytes = Buffer.from(payload, "base64url");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  const decipher = createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function redact(value: string | undefined): string | undefined {
  if (!value) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
