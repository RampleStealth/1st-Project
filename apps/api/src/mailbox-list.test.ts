import assert from "node:assert/strict";
import test from "node:test";
import { CursorError, decodeThreadCursor, encodeThreadCursor } from "./mailbox-list.js";

const key = Buffer.alloc(32, 7).toString("base64");
const context = { userId: "11111111-1111-4111-8111-111111111111", mailboxId: "22222222-2222-4222-8222-222222222222", view: "inbox" as const, limit: 25 };

test("thread cursor keeps Gmail page tokens opaque and validates its bound context", () => {
  const cursor = encodeThreadCursor({ ...context, providerPageToken: "gmail-private-page-token", expiresAt: Date.now() + 60_000 }, key);
  assert.equal(cursor.includes("gmail-private-page-token"), false);
  assert.equal(decodeThreadCursor(cursor, context, key), "gmail-private-page-token");
  assert.throws(() => decodeThreadCursor(cursor, { ...context, view: "sent" }, key), (error) => error instanceof CursorError && error.code === "cursor_context_mismatch");
  assert.throws(() => decodeThreadCursor(cursor, { ...context, mailboxId: "33333333-3333-4333-8333-333333333333" }, key), (error) => error instanceof CursorError && error.code === "cursor_context_mismatch");
  assert.throws(() => decodeThreadCursor(cursor, { ...context, userId: "33333333-3333-4333-8333-333333333333" }, key), (error) => error instanceof CursorError && error.code === "cursor_context_mismatch");
  assert.throws(() => decodeThreadCursor(cursor, { ...context, limit: 50 }, key), (error) => error instanceof CursorError && error.code === "cursor_context_mismatch");
});

test("thread cursor rejects expiry and tampering", () => {
  const expired = encodeThreadCursor({ ...context, providerPageToken: "token", expiresAt: Date.now() - 1 }, key);
  assert.throws(() => decodeThreadCursor(expired, context, key), (error) => error instanceof CursorError && error.code === "expired_cursor");
  assert.throws(() => decodeThreadCursor("not-a-cursor", context, key), (error) => error instanceof CursorError && error.code === "invalid_cursor");
});
