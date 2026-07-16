import assert from "node:assert/strict";
import test from "node:test";
import { archiveThread, classifyGmailMutationError, GmailPaginationValidationError, listThreads, mapWithConcurrency, markThreadUnread, sanitizeGmailProviderError, threadListLabel } from "./index.js";

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
  assert.equal(classifyGmailMutationError({ request: { socket: {} } }), "uncertain_provider_outcome");
});
