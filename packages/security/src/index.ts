import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { providerCommandPayloadDefinitions, type CanonicalDraftContent, type ProviderCommandPayload, type ProviderCommandType } from "@aio/contracts";

const algorithm = "aes-256-gcm";
const cursorDerivationSalt = Buffer.from("aio/key-derivation-salt/v1", "utf8");
const cursorDerivationContext = Buffer.from("aio/thread-pagination-cursor/v1", "utf8");
const draftFingerprintDerivationContext = Buffer.from("aio/draft-content-fingerprint/v1", "utf8");

function masterKey(keyBase64: string) {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  return key;
}

/** Derives a purpose-specific AES-256 key; master-key encryption behavior remains unchanged. */
export function deriveThreadCursorKey(masterKeyBase64: string): string {
  return Buffer.from(hkdfSync("sha256", masterKey(masterKeyBase64), cursorDerivationSalt, cursorDerivationContext, 32)).toString("base64");
}

/** Derives a purpose-specific key so content fingerprints cannot be reversed or reused as encryption keys. */
export function deriveDraftFingerprintKey(masterKeyBase64: string): string {
  return Buffer.from(hkdfSync("sha256", masterKey(masterKeyBase64), cursorDerivationSalt, draftFingerprintDerivationContext, 32)).toString("base64");
}

export function fingerprintDraftContent(content: CanonicalDraftContent, masterKeyBase64: string): string {
  const canonical = JSON.stringify({ to: content.to, cc: content.cc, bcc: content.bcc, subject: content.subject, plainText: content.plainText, html: content.html });
  return createHmac("sha256", Buffer.from(deriveDraftFingerprintKey(masterKeyBase64), "base64")).update(canonical, "utf8").digest("base64url");
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

type RegisteredPayload = { version: number; parse: (value: unknown) => unknown; decrypt: (encryptedPayload: string, keyBase64: string) => unknown };
function registeredPayload(definition: { version: number; parse: (value: unknown) => unknown }): RegisteredPayload {
  return {
    version: definition.version,
    parse: definition.parse,
    decrypt: (encryptedPayload, keyBase64) => definition.parse(JSON.parse(decryptSecret(encryptedPayload, keyBase64)))
  };
}

/** Each command type has one versioned schema/parser/decryptor; callers never switch on payload shape. */
export const providerCommandPayloadRegistry: Record<ProviderCommandType, RegisteredPayload> = Object.fromEntries(
  Object.entries(providerCommandPayloadDefinitions).map(([type, definition]) => [type, registeredPayload(definition)])
) as Record<ProviderCommandType, RegisteredPayload>;

/** Validates a versioned payload before it crosses the encrypted command boundary. */
export function encryptProviderCommandPayload<T extends ProviderCommandType>(commandType: T, payload: unknown, keyBase64: string): string {
  const parsed = providerCommandPayloadRegistry[commandType].parse(payload);
  return encryptSecret(JSON.stringify(parsed), keyBase64);
}

export function decryptProviderCommandPayload(commandType: ProviderCommandType, encryptedPayload: string, keyBase64: string): ProviderCommandPayload {
  return { commandType, payload: providerCommandPayloadRegistry[commandType].decrypt(encryptedPayload, keyBase64) } as ProviderCommandPayload;
}

export type EncryptedDraftContent = {
  encryptedRecipients: string;
  encryptedSubject: string;
  encryptedPlainText: string;
  encryptedHtml: string | null;
};

export function encryptDraftContent(content: CanonicalDraftContent, keyBase64: string): EncryptedDraftContent {
  return {
    encryptedRecipients: encryptSecret(JSON.stringify({ to: content.to, cc: content.cc, bcc: content.bcc }), keyBase64),
    encryptedSubject: encryptSecret(content.subject, keyBase64),
    encryptedPlainText: encryptSecret(content.plainText, keyBase64),
    encryptedHtml: content.html === null ? null : encryptSecret(content.html, keyBase64)
  };
}

export function decryptDraftContent(content: EncryptedDraftContent, keyBase64: string): CanonicalDraftContent {
  const recipients = JSON.parse(decryptSecret(content.encryptedRecipients, keyBase64)) as { to: string[]; cc: string[]; bcc: string[] };
  return {
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject: decryptSecret(content.encryptedSubject, keyBase64),
    plainText: decryptSecret(content.encryptedPlainText, keyBase64),
    html: content.encryptedHtml === null ? null : decryptSecret(content.encryptedHtml, keyBase64)
  };
}

export function redact(value: string | undefined): string | undefined {
  if (!value) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
