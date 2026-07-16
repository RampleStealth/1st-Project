import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "@aio/config";
import type { ProviderCommandType } from "@aio/contracts";
import type { MailboxAccount } from "@aio/database";
import type { Pool } from "pg";
import { encryptSecret } from "@aio/security";
import { requireCsrf } from "../route-helpers/security.js";
import { authenticatedUser } from "../route-helpers/session.js";

type ThreadCommandType = Extract<ProviderCommandType, "archive_thread" | "mark_thread_unread">;
type CreatedCommand = {
  id: string;
  commandType: string;
  status: string;
};
type Deps = {
  config: AppConfig;
  pool: Pool;
  findMailboxForUser: (mailboxAccountId: string, userId: string) => Promise<MailboxAccount | null>;
  insertProviderCommand: (input: { mailboxId: string; commandType: ThreadCommandType; encryptedPayload: string; fingerprint: string; idempotencyKey: string }) => Promise<CreatedCommand>;
  isIdempotencyConflictError: (error: unknown) => boolean;
};

export function registerThreadMutationRoutes(
  app: FastifyInstance<any, any, any, any>,
  { config, pool, findMailboxForUser, insertProviderCommand, isIdempotencyConflictError }: Deps
) {
  async function createThreadCommand(request: FastifyRequest<{ Params: { mailboxId: string; threadId: string } }>, reply: any, type: ThreadCommandType) {
    const user = await authenticatedUser(request, pool);
    if (!user) return reply.code(401).send({ code: "unauthenticated" });
    if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return reply.code(400).send({ code: "invalid_idempotency_key" });
    const mailbox = await findMailboxForUser(request.params.mailboxId, user.id);
    if (!mailbox) return reply.code(404).send({ code: "mailbox_not_found" });
    const permission = await pool.query<{ write_capability: string }>("SELECT write_capability FROM mailbox_permission_state WHERE mailbox_account_id=$1", [mailbox.id]);
    if (permission.rows[0]?.write_capability !== "write_granted") return reply.code(409).send({ code: "permission_required" });
    const thread = await pool.query<{ id: string }>("SELECT id FROM threads WHERE mailbox_account_id=$1 AND provider_thread_id=$2", [mailbox.id, request.params.threadId]);
    if (!thread.rowCount) return reply.code(404).send({ code: "thread_not_found" });
    try {
      const fingerprint = createHash("sha256").update(`${type}:${request.params.threadId}`).digest("hex");
      const command = await insertProviderCommand({ mailboxId: mailbox.id, commandType: type, encryptedPayload: encryptSecret(JSON.stringify({ providerThreadId: request.params.threadId }), config.TOKEN_ENCRYPTION_KEY_BASE64), fingerprint, idempotencyKey: key });
      return reply.code(202).send({ id: command.id, commandType: command.commandType, status: command.status });
    } catch (error) {
      if (isIdempotencyConflictError(error)) return reply.code(409).send({ code: "idempotency_conflict" });
      throw error;
    }
  }

  app.post<{ Params: { mailboxId: string; threadId: string } }>("/v1/mailboxes/:mailboxId/threads/:threadId/archive", (request, reply) => createThreadCommand(request, reply, "archive_thread"));
  app.post<{ Params: { mailboxId: string; threadId: string } }>("/v1/mailboxes/:mailboxId/threads/:threadId/mark-unread", (request, reply) => createThreadCommand(request, reply, "mark_thread_unread"));
}
