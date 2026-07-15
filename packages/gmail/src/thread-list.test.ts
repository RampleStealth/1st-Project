import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency, threadListLabel } from "./index.js";

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
