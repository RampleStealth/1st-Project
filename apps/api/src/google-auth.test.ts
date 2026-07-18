import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { resetWritePermissionAfterReadOnlyConnection } from "./routes/google-auth.js";

test("a read-only reconnect atomically revokes a stale write grant", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rowCount: 1, rows: [] };
    }
  } as unknown as PoolClient;

  await resetWritePermissionAfterReadOnlyConnection(client, "mailbox-id", ["https://www.googleapis.com/auth/gmail.readonly"]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /write_capability='read_only'/);
  assert.match(calls[0].text, /upgrade_attempt_id=NULL/);
  assert.match(calls[0].text, /upgrade_expires_at=NULL/);
  assert.deepEqual(calls[0].values, ["mailbox-id", ["https://www.googleapis.com/auth/gmail.readonly"]]);
});
