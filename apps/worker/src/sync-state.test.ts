import assert from "node:assert/strict";
import test from "node:test";
import { hasUnprocessedPendingHistory, shouldRetryForUnavailableHistory } from "./sync-state.js";

test("pending history above the applied watermark requires another sync pass", () => {
  assert.equal(hasUnprocessedPendingHistory("9007199254740993", "9007199254740992"), true);
});

test("pending history at or below the applied watermark is already covered", () => {
  assert.equal(hasUnprocessedPendingHistory("73", "73"), false);
  assert.equal(hasUnprocessedPendingHistory("72", "73"), false);
  assert.equal(hasUnprocessedPendingHistory(null, "73"), false);
});

test("a notification ahead of an unchanged Gmail history range is retried", () => {
  assert.equal(shouldRetryForUnavailableHistory("100", "100", "101"), true);
  assert.equal(shouldRetryForUnavailableHistory("101", "100", "101"), false);
});
