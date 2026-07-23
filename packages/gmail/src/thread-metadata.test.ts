import assert from "node:assert/strict";
import test from "node:test";
import { getThread } from "./index.js";
import { normalizeThreadProjection, parseMailboxList } from "./thread-metadata.js";

test("mailbox parsing normalizes quoted, encoded, comment, bare, and duplicate addresses", () => {
  assert.deepEqual(
    parseMailboxList('"Doe, John" <JOHN@Example.COM>, =?UTF-8?B?Sm9zw6kgTcO8bGxlcg==?= <jose@example.com>, bare@EXAMPLE.COM, duplicate@example.com, "Named" <DUPLICATE@example.com>, invalid'),
    [
      { displayName: "Doe, John", address: "john@example.com" },
      { displayName: "José Müller", address: "jose@example.com" },
      { displayName: null, address: "bare@example.com" },
      { displayName: "Named", address: "duplicate@example.com" }
    ]
  );
  assert.deepEqual(parseMailboxList("person@example.com (Person Name)"), [{ displayName: "Person Name", address: "person@example.com" }]);
  assert.deepEqual(parseMailboxList("Team: Alice alice@example.com, bob@example.com;"), [
    { displayName: "Alice", address: "alice@example.com" },
    { displayName: null, address: "bob@example.com" }
  ]);
  assert.deepEqual(parseMailboxList(null), []);
});

test("thread metadata normalization is deterministic, body-free, and detects nested attachments", () => {
  const messages = [
    {
      id: "message-latest",
      internalDate: "4102444800000",
      labelIds: ["UNREAD", "INBOX", "UNREAD"],
      snippet: "  Latest   preview ",
      payload: {
        headers: [
          { name: "From", value: '"Doe, John" <JOHN@Example.COM>' },
          { name: "To", value: "Owner <owner@example.com>, second@example.com" },
          { name: "Cc", value: "Copy <copy@example.com>" },
          { name: "Subject", value: "  Project   update " }
        ],
        parts: [{ mimeType: "multipart/mixed", parts: [{ filename: "", mimeType: "application/pdf", body: { attachmentId: "private-id" } }] }]
      }
    },
    {
      id: "message-first",
      internalDate: "1700000000000",
      labelIds: ["INBOX"],
      payload: { headers: [{ name: "From", value: "first@example.com" }] }
    },
    {
      id: "message-missing-time",
      internalDate: "invalid",
      labelIds: [],
      payload: { headers: [{ name: "From", value: "missing@example.com" }] }
    }
  ];
  const first = normalizeThreadProjection({ id: "thread", messages });
  const reordered = normalizeThreadProjection({ id: "thread", messages: [messages[2], messages[0], messages[1]] });
  assert.deepEqual(first, reordered);
  assert.equal(JSON.stringify(first).includes("private-id"), false);
  assert.deepEqual(first?.messages.map((message) => message.providerMessageId), ["message-missing-time", "message-first", "message-latest"]);
  assert.equal(first?.messages[0].internalTimestamp, null);
  assert.equal(first?.messages[2].internalTimestamp, "2100-01-01T00:00:00.000Z");
  assert.equal(first?.messages[2].hasAttachments, true);
  assert.deepEqual(first?.messages[2].labels, ["INBOX", "UNREAD"]);
  assert.deepEqual(first?.messages[2].from, { displayName: "Doe, John", address: "john@example.com" });
});

test("projection hydration requests only partial MIME structure and never message bodies", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const gmail = { users: { threads: { get: async (input: Record<string, unknown>) => {
    calls.push(input);
    return { data: { id: "thread", messages: [{ id: "message", internalDate: "1700000000000", payload: { headers: [{ name: "From", value: "sender@example.com" }], parts: [{ filename: "file.txt", mimeType: "text/plain" }] } }] } };
  } } } };
  const result = await getThread(gmail as never, "thread");
  assert.equal(result?.messages[0].hasAttachments, true);
  assert.equal(calls[0].format, "full");
  assert.equal(String(calls[0].fields).includes("attachmentId"), true);
  assert.equal(String(calls[0].fields).includes("data"), false);
  assert.equal(String(calls[0].fields).includes("parts"), true);
});
