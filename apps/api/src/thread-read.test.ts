import test from "node:test";
import assert from "node:assert/strict";
import { threadReadProviderFailure } from "./thread-read.js";
test("maps Gmail deletion and temporary failures to safe reader responses", () => {
  assert.equal(threadReadProviderFailure({ response: { status: 404 } }).body.code, "thread_deleted");
  assert.equal(threadReadProviderFailure({ response: { status: 503 } }).status, 503);
});
