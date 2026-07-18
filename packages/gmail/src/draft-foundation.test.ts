import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { draftContentInputSchema, draftLimits } from "@aio/contracts";
import { decryptDraftContent, decryptProviderCommandPayload, encryptDraftContent, encryptSecret, fingerprintDraftContent, providerCommandPayloadRegistry } from "@aio/security";
import { buildDraftMime, canonicalizeDraftContent, DraftValidationError, generateDraftMessageId } from "./index.js";

const key = Buffer.alloc(32, 19).toString("base64");
const messageId = "<11111111-1111-4111-8111-111111111111@message.example.test>";
const draft = {
  to: [" beta@example.test ", "alpha@example.test"],
  cc: [],
  bcc: [],
  subject: " Cafe\u0301   update ",
  plainText: "Hello\r\nworld",
  html: "<p>Hello</p><img src=\"https://tracker.example/pixel\"><script>alert(1)</script>"
};

test("draft contracts reject malformed structures and canonicalize structured content", () => {
  assert.throws(() => draftContentInputSchema.parse({ ...draft, unexpected: true }));
  assert.throws(() => canonicalizeDraftContent({ ...draft, to: ["not-an-address"] }), DraftValidationError);
  assert.throws(() => canonicalizeDraftContent({ ...draft, cc: ["alpha@example.test"] }), DraftValidationError);
  const canonical = canonicalizeDraftContent(draft);
  assert.deepEqual(canonical.to, ["alpha@example.test", "beta@example.test"]);
  assert.equal(canonical.subject, "Café update");
  assert.equal(canonical.plainText, "Hello\nworld");
  assert.equal(canonical.html?.includes("script"), false);
  assert.equal(canonical.html?.includes("img"), false);
});

test("draft content fingerprints are keyed, deterministic, and insensitive to canonical equivalence", () => {
  const first = canonicalizeDraftContent(draft);
  const equivalent = canonicalizeDraftContent({ ...draft, to: ["alpha@example.test", "beta@example.test"], subject: "Café update", plainText: "Hello\nworld" });
  const changed = canonicalizeDraftContent({ ...draft, plainText: "Hello\nchanged" });
  assert.equal(fingerprintDraftContent(first, key), fingerprintDraftContent(equivalent, key));
  assert.notEqual(fingerprintDraftContent(first, key), fingerprintDraftContent(changed, key));
  assert.notEqual(fingerprintDraftContent(first, key), fingerprintDraftContent(first, Buffer.alloc(32, 20).toString("base64")));
});

test("draft content encryption stores no recognizable plaintext", () => {
  const content = canonicalizeDraftContent(draft);
  const encrypted = encryptDraftContent(content, key);
  const serialized = JSON.stringify(encrypted);
  for (const secret of ["alpha@example.test", "beta@example.test", "Café update", "Hello", "tracker.example"]) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(decryptDraftContent(encrypted, key), content);
});

test("provider command payload registry is versioned, strict, and preserves Phase 6 payloads", () => {
  assert.equal(providerCommandPayloadRegistry.archive_thread.version, 0);
  assert.equal(providerCommandPayloadRegistry.create_draft.version, 1);
  const archive = decryptProviderCommandPayload("archive_thread", encryptSecret(JSON.stringify({ providerThreadId: "thread-1" }), key), key);
  assert.deepEqual(archive, { commandType: "archive_thread", payload: { providerThreadId: "thread-1" } });
  const create = decryptProviderCommandPayload("create_draft", encryptSecret(JSON.stringify({ version: 1, draftId: "11111111-1111-4111-8111-111111111111" }), key), key);
  assert.deepEqual(create, { commandType: "create_draft", payload: { version: 1, draftId: "11111111-1111-4111-8111-111111111111" } });
  assert.throws(() => decryptProviderCommandPayload("send_draft", encryptSecret(JSON.stringify({ version: 1, draftId: "11111111-1111-4111-8111-111111111111", revision: 1, body: "no" }), key), key));
  assert.throws(() => decryptProviderCommandPayload("update_draft", encryptSecret(JSON.stringify({ version: 0, draftId: "11111111-1111-4111-8111-111111111111", revision: 1 }), key), key));
});

test("MIME builder produces safe plain-text and multipart alternative messages", () => {
  const plain = buildDraftMime({ ...draft, html: null }, { messageId, date: new Date("2026-07-16T00:00:00Z") });
  assert.equal(plain.boundary, null);
  assert.match(plain.mime, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(plain.mime, /SGVsbG8Kd29ybGQ=/);
  assert.match(plain.mime, /Subject: =\?UTF-8\?B\?/);
  const multipart = buildDraftMime(draft, { messageId, date: new Date("2026-07-16T00:00:00Z"), boundary: "test-boundary" });
  assert.equal(multipart.boundary, "test-boundary");
  assert.match(multipart.mime, /multipart\/alternative; boundary="test-boundary"/);
  assert.match(multipart.mime, /--test-boundary--/);
  assert.equal(multipart.content.html?.includes("script"), false);
  assert.equal(multipart.content.html?.includes("tracker.example"), false);
});

test("MIME builder blocks header injection, malformed recipients, and oversized bodies", () => {
  assert.throws(() => buildDraftMime({ ...draft, subject: "safe\r\nBcc: injected@example.test" }, { messageId }), DraftValidationError);
  assert.throws(() => buildDraftMime({ ...draft, to: ["victim@example.test\r\nBcc: injected@example.test"] }, { messageId }), DraftValidationError);
  assert.throws(() => buildDraftMime({ ...draft, plainText: "x".repeat(draftLimits.maxPlainTextBytes + 1) }, { messageId }), DraftValidationError);
  assert.throws(() => buildDraftMime(draft, { messageId: "<bad\r\n@example.test>" }), DraftValidationError);
});

test("stable application-owned RFC 5322 Message-IDs are generated without MIME or Gmail access", () => {
  assert.equal(generateDraftMessageId("message.example.test", "11111111-1111-4111-8111-111111111111"), messageId);
  assert.equal(generateDraftMessageId("Drafts.Localhost.Test", "11111111-1111-4111-8111-111111111111"), "<11111111-1111-4111-8111-111111111111@drafts.localhost.test>");
  for (const domain of ["https://message.example.test", "message.example.test:4000", "user@example.test", "", "invalid domain"]) {
    assert.throws(() => generateDraftMessageId(domain, "11111111-1111-4111-8111-111111111111"), DraftValidationError);
  }
});

test("draft migration contains required lifecycle and send-safety invariants", async () => {
  const migration = await readFile(new URL("../../database/migrations/010_gmail_drafts.sql", import.meta.url), "utf8");
  for (const required of [
    "CREATE TABLE drafts",
    "rfc822_message_id",
    "encrypted_recipients",
    "confirmed_revision",
    "provider_execution_started_at",
    "provider_commands_one_active_draft_mutation",
    "provider_commands_one_active_draft_send",
    "recovery_required",
    "creation_failed"
  ]) assert.match(migration, new RegExp(required));
});
