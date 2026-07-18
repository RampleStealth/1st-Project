import assert from "node:assert/strict";
import test from "node:test";
import type { MailboxSearchCriteria } from "@aio/contracts";
import { archiveThread, classifyGmailMutationError, compileGmailSearch, createDraft, findDraftByRfc822MessageId, findSentMessageByRfc822MessageId, getDraft, GmailPaginationValidationError, GmailSearchValidationError, listThreads, mapWithConcurrency, markThreadUnread, sanitizeGmailMutationError, sanitizeGmailProviderError, searchThreads, sendDraft, threadListLabel, updateDraft } from "./index.js";

function searchCriteria(overrides: Partial<MailboxSearchCriteria> = {}): MailboxSearchCriteria { return { terms: ["invoice"], scope: "all", from: null, to: null, subject: null, after: null, before: null, unread: false, hasAttachment: false, ...overrides }; }

test("maps workspace views to Gmail system labels", () => {
  assert.equal(threadListLabel("inbox"), "INBOX");
  assert.equal(threadListLabel("all"), undefined);
  assert.equal(threadListLabel("sent"), "SENT");
  assert.equal(threadListLabel("drafts"), "DRAFT");
});

test("metadata hydration helper bounds concurrent requests", async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  assert.equal(maximum, 2);
});

test("adapter rejects invalid page sizes before calling Gmail", async () => {
  for (const value of [0, -1, 1.5, Number.NaN, Infinity, 101]) {
    let called = false;
    const gmail = { users: { threads: { list: async () => { called = true; return { data: {} }; } } } };
    await assert.rejects(() => listThreads(gmail as never, "inbox", undefined, value), GmailPaginationValidationError);
    assert.equal(called, false);
  }
});

test("provider log sanitizer strips sensitive provider fields", () => {
  const secretValues = ["Bearer access-token", "refresh-token", "person@example.com", "gmail-resource-id", "https://gmail.googleapis.com/private", "response-body-secret"];
  const providerError = {
    code: 401,
    response: { status: 401, data: { authorization: secretValues[0], refreshToken: secretValues[1], email: secretValues[2], id: secretValues[3], body: secretValues[5] } },
    config: { url: secretValues[4], headers: { authorization: secretValues[0] } },
    request: { headers: { authorization: secretValues[0] } }
  };
  const serialized = JSON.stringify(sanitizeGmailProviderError(providerError, { operation: "gmail_thread_list", mailboxId: "mailbox-uuid", correlationId: "correlation-uuid" }));
  for (const secret of secretValues) assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /reauthorization_required/);
  assert.match(serialized, /http_401/);
});
test("thread mutations use only fixed Gmail system labels", async () => { const calls: unknown[]=[]; const gmail={users:{threads:{modify:async (input:unknown)=>{calls.push(input);}}}}; await archiveThread(gmail as never,"thread"); await markThreadUnread(gmail as never,"thread"); assert.deepEqual(calls,[{userId:"me",id:"thread",requestBody:{removeLabelIds:["INBOX"]}},{userId:"me",id:"thread",requestBody:{addLabelIds:["UNREAD"]}}]); });

test("mutation error classification is safe for retries, permissions, and uncertain outcomes", () => {
  assert.equal(classifyGmailMutationError({ response: { status: 404, data: {} } }), "resource_deleted");
  assert.equal(classifyGmailMutationError({ response: { status: 429, data: {} } }), "rate_limited");
  assert.equal(classifyGmailMutationError({ response: { status: 503, data: {} } }), "transient_provider_failure");
  assert.equal(classifyGmailMutationError({ response: { status: 401, data: {} } }), "reauthorization_required");
  assert.equal(classifyGmailMutationError({ response: { status: 403, data: { message: "Request had insufficient authentication scopes." } } }), "write_scope_required");
  assert.equal(classifyGmailMutationError({ response: { status: 403, data: { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } } } }), "write_scope_required");
  assert.equal(classifyGmailMutationError({ response: { status: 400, data: { error: { code: 400, status: "INVALID_ARGUMENT" } } } }), "provider_rejected");
  assert.equal(classifyGmailMutationError({ request: { socket: {} } }), "uncertain_provider_outcome");
});

test("structured search compiles fixed operators, system labels, and provider pagination server-side", async () => {
  const calls: unknown[] = [];
  const gmail = { users: { threads: { list: async (input: unknown) => { calls.push(input); return { data: { threads: [{ id: "one" }, { id: null }, { id: "two" }], nextPageToken: "provider-next" } }; } } } };
  const criteria = searchCriteria({ terms: ["invoice", "August statement", "from:literal@example.test"], scope: "inbox", from: "Billing Team", to: "owner@example.test", subject: "Quarterly report", after: "2026-07-01", before: "2026-08-01", unread: true, hasAttachment: true });
  assert.deepEqual(await searchThreads(gmail as never, criteria, "provider-current", 10), { threadIds: ["one", "two"], nextPageToken: "provider-next" });
  assert.deepEqual(calls, [{ userId: "me", q: "\"invoice\" \"August statement\" \"from:literal@example.test\" from:\"Billing Team\" to:\"owner@example.test\" subject:\"Quarterly report\" after:2026/07/01 before:2026/08/01 has:attachment", labelIds: ["INBOX", "UNREAD"], pageToken: "provider-current", maxResults: 10, includeSpamTrash: false }]);
});

test("structured search maps each scope and filter without accepting raw labels", () => {
  assert.deepEqual(compileGmailSearch(searchCriteria()), { q: "\"invoice\"", labelIds: undefined });
  assert.deepEqual(compileGmailSearch(searchCriteria({ terms: [], scope: "sent" })), { q: undefined, labelIds: ["SENT"] });
  assert.deepEqual(compileGmailSearch(searchCriteria({ terms: [], scope: "drafts", unread: true })), { q: undefined, labelIds: ["DRAFT", "UNREAD"] });
  assert.deepEqual(compileGmailSearch(searchCriteria({ terms: [], scope: "all", hasAttachment: true })), { q: "has:attachment", labelIds: undefined });
});

test("structured search rejects unsafe criteria and page sizes before Gmail is called", async () => {
  for (const input of [
    { criteria: searchCriteria({ terms: [], scope: "all" }), limit: 10 },
    { criteria: searchCriteria({ terms: ["quote\"term"] }), limit: 10 },
    { criteria: searchCriteria({ terms: ["back\\slash"] }), limit: 10 },
    { criteria: searchCriteria({ from: "line\nbreak" }), limit: 10 },
    { criteria: searchCriteria({ subject: "x".repeat(201) }), limit: 10 },
    { criteria: searchCriteria({ terms: Array.from({ length: 20 }, () => "x".repeat(100)), from: "a".repeat(254), to: "b".repeat(254), subject: "c".repeat(200) }), limit: 10 },
    { criteria: searchCriteria({ after: "2026-02-30" }), limit: 10 },
    { criteria: searchCriteria({ after: "2026-08-01", before: "2026-07-01" }), limit: 10 },
    { criteria: searchCriteria(), limit: 11 },
    { criteria: searchCriteria(), limit: 1.5 }
  ]) {
    let called = false;
    const gmail = { users: { threads: { list: async () => { called = true; return { data: {} }; } } } };
    await assert.rejects(() => searchThreads(gmail as never, input.criteria, undefined, input.limit), GmailSearchValidationError);
    assert.equal(called, false);
  }
});

test("mutation diagnostics retain only safe status and Google reason fields", () => {
  const secrets = ["Bearer access-token", "person@example.test", "gmail-thread-id", "raw-response-body"];
  const error = {
    response: {
      status: 403,
      data: {
        error: { code: 403, status: "PERMISSION_DENIED", message: secrets[3], errors: [{ reason: "insufficientPermissions" }] },
        email: secrets[1], threadId: secrets[2]
      }
    },
    config: { headers: { authorization: secrets[0] } }
  };
  const metadata = sanitizeGmailMutationError(error, { operation: "gmail.threads.modify.mark_unread", mailboxId: "mailbox-id", commandId: "command-id", correlationId: "correlation-id" });
  assert.deepEqual(metadata, {
    applicationErrorCode: "write_scope_required",
    statusCategory: "http_4xx",
    httpStatus: 403,
    googleStatus: "PERMISSION_DENIED",
    googleReason: "insufficientPermissions",
    operation: "gmail.threads.modify.mark_unread",
    mailboxId: "mailbox-id",
    correlationId: "correlation-id",
    commandId: "command-id",
    retryable: false,
    message: "Gmail mutation failed"
  });
  const serialized = JSON.stringify(metadata);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
});

test("draft adapter creates and reads only normalized Gmail draft references", async () => {
  const calls: unknown[] = [];
  const gmail = { users: { drafts: {
    create: async (input: unknown) => { calls.push(input); return { data: { id: "gmail-draft", message: { id: "gmail-message", threadId: "gmail-thread", raw: "never-returned" } } }; },
    get: async (input: unknown) => { calls.push(input); return { data: { id: "gmail-draft", message: { id: "gmail-message", threadId: "gmail-thread", raw: "never-returned" } } }; }
  } } };
  const created = await createDraft(gmail as never, "Subject: test\r\n\r\nbody");
  const read = await getDraft(gmail as never, "gmail-draft");
  assert.deepEqual(created, { draftId: "gmail-draft", messageId: "gmail-message", threadId: "gmail-thread" });
  assert.deepEqual(read, created);
  assert.deepEqual(calls, [
    { userId: "me", requestBody: { message: { raw: Buffer.from("Subject: test\r\n\r\nbody", "utf8").toString("base64url") } } },
    { userId: "me", id: "gmail-draft", format: "metadata" }
  ]);
  assert.equal(JSON.stringify(created).includes("never-returned"), false);
});

test("draft adapter updates only the Gmail Draft resource and normalizes its replacement message", async () => {
  const calls: unknown[] = [];
  const gmail = { users: { drafts: { update: async (input: unknown) => { calls.push(input); return { data: { id: "draft-resource", message: { id: "replacement-message", threadId: "thread" } } }; } } } };
  assert.deepEqual(await updateDraft(gmail as never, "draft-resource", "Subject: x\r\n\r\nbody"), { draftId: "draft-resource", messageId: "replacement-message", threadId: "thread" });
  assert.deepEqual(calls, [{ userId: "me", id: "draft-resource", requestBody: { message: { raw: Buffer.from("Subject: x\r\n\r\nbody", "utf8").toString("base64url") } } }]);
});

test("draft Message-ID verification searches only Gmail drafts and returns normalized cardinality", async () => {
  const calls: unknown[] = [];
  const gmail = { users: { drafts: {
    list: async (input: unknown) => { calls.push(input); return { data: { drafts: [{ id: "draft-one" }] } }; },
    get: async (input: unknown) => { calls.push(input); return { data: { id: "draft-one", message: { id: "message-one", threadId: "thread-one", payload: { body: { data: "never-returned" } } } } }; }
  } } };
  assert.deepEqual(await findDraftByRfc822MessageId(gmail as never, "<stable@example.test>"), { kind: "one", draft: { draftId: "draft-one", messageId: "message-one", threadId: "thread-one" } });
  assert.deepEqual(calls, [{ userId: "me", q: "rfc822msgid:<stable@example.test>", maxResults: 3 }, { userId: "me", id: "draft-one", format: "metadata" }]);
  const none = { users: { drafts: { list: async () => ({ data: { drafts: [] } }) } } };
  const multiple = { users: { drafts: { list: async () => ({ data: { drafts: [{ id: "one" }, { id: "two" }] } }) } } };
  assert.deepEqual(await findDraftByRfc822MessageId(none as never, "<stable@example.test>"), { kind: "none" });
  assert.deepEqual(await findDraftByRfc822MessageId(multiple as never, "<stable@example.test>"), { kind: "ambiguous" });
});

test("send uses only the Gmail Draft resource and Sent verification is metadata-only", async () => {
  const calls: unknown[] = [];
  const gmail = { users: {
    drafts: { send: async (input: unknown) => { calls.push(input); return { data: { id: "sent-message", threadId: "sent-thread", internalDate: "1000", raw: "never-returned" } }; } },
    messages: {
      list: async (input: unknown) => { calls.push(input); return { data: { messages: [{ id: "sent-message" }] } }; },
      get: async (input: unknown) => { calls.push(input); return { data: { id: "sent-message", threadId: "sent-thread", internalDate: "1000", raw: "never-returned" } }; }
    }
  } };
  assert.deepEqual(await sendDraft(gmail as never, "gmail-draft"), { messageId: "sent-message", threadId: "sent-thread", sentAt: new Date(1000) });
  assert.deepEqual(await findSentMessageByRfc822MessageId(gmail as never, "<stable@example.test>"), { kind: "one", message: { messageId: "sent-message", threadId: "sent-thread", sentAt: new Date(1000) } });
  assert.deepEqual(calls, [
    { userId: "me", requestBody: { id: "gmail-draft" } },
    { userId: "me", labelIds: ["SENT"], q: "rfc822msgid:<stable@example.test>", maxResults: 3, includeSpamTrash: false },
    { userId: "me", id: "sent-message", format: "metadata" }
  ]);
  assert.equal(JSON.stringify(await findSentMessageByRfc822MessageId(gmail as never, "<stable@example.test>")).includes("never-returned"), false);
  const none = { users: { messages: { list: async () => ({ data: { messages: [] } }) } } };
  const many = { users: { messages: { list: async () => ({ data: { messages: [{ id: "one" }, { id: "two" }] } }) } } };
  assert.deepEqual(await findSentMessageByRfc822MessageId(none as never, "<stable@example.test>"), { kind: "none" });
  assert.deepEqual(await findSentMessageByRfc822MessageId(many as never, "<stable@example.test>"), { kind: "ambiguous" });
});
