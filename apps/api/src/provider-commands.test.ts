import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import type { Pool } from "pg";
import { registerProviderCommandRoutes } from "./routes/provider-commands.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";
const sessionHash = (value: string) => createHash("sha256").update(value).digest("hex");

async function makeApp() {
  const pool = {
    query: async (text: string, values: unknown[]) => {
      if (text.startsWith("SELECT user_id AS id FROM sessions")) {
        return { rows: values[0] === sessionHash("owner-session") ? [{ id: ownerId }] : [], rowCount: values[0] === sessionHash("owner-session") ? 1 : 0 };
      }
      if (text.startsWith("SELECT c.id,c.command_type")) {
        const owned = values[0] === commandId && values[1] === mailboxId && values[2] === ownerId;
        return { rows: owned ? [{ id: commandId, command_type: "mark_thread_unread", status: "succeeded", failure_code: null, attempt_count: 8, next_attempt_at: "internal", failure_detail: "internal", active_claim_id: "internal", lease_expires_at: "internal", encrypted_payload: "internal" }] : [], rowCount: owned ? 1 : 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    }
  } as unknown as Pool;
  const app = Fastify();
  await app.register(cookie, { secret: "a".repeat(32) });
  registerProviderCommandRoutes(app, { pool });
  await app.ready();
  return app;
}

test("provider-command status is owner-scoped and exposes only normalized safe fields", async () => {
  const app = await makeApp();
  const ownerCookie = app.signCookie("owner-session");
  const url = `/v1/mailboxes/${mailboxId}/provider-commands/${commandId}`;

  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: `/v1/mailboxes/${mailboxId}/provider-commands/44444444-4444-4444-8444-444444444444`, headers: { cookie: `aio_session=${ownerCookie}` } })).statusCode, 404);

  const response = await app.inject({ method: "GET", url, headers: { cookie: `aio_session=${ownerCookie}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { id: commandId, commandType: "mark_thread_unread", status: "succeeded", failureCode: null });
  for (const internal of ["command_type", "attempt_count", "next_attempt_at", "failure_detail", "active_claim_id", "lease_expires_at", "encrypted_payload", "provider_result_reference", "request_fingerprint"]) assert.equal(internal in response.json(), false, internal);
  await app.close();
});
