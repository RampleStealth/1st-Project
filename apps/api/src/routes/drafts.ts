import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "@aio/config";
import type { MailboxAccount } from "@aio/database";
import type { DraftContentInput } from "@aio/contracts";
import { canonicalizeDraftContent, generateDraftMessageId } from "@aio/gmail";
import { decryptDraftContent, encryptDraftContent, encryptProviderCommandPayload, fingerprintDraftContent } from "@aio/security";
import type { Pool } from "pg";
import { requireCsrf } from "../route-helpers/security.js";
import { authenticatedUser } from "../route-helpers/session.js";

type CreatedDraftCommand = { id: string; commandType: string; status: string; draftId: string };
type StoredDraft = Parameters<typeof decryptDraftContent>[0] & {
  id: string; status: string; revision: number; confirmedRevision: number | null; recipientCount: number; hasHtml: boolean; createdAt: Date; updatedAt: Date;
};
type Deps = {
  config: AppConfig;
  pool: Pool;
  findMailboxForUser: (mailboxAccountId: string, userId: string) => Promise<MailboxAccount | null>;
  createDraftWithCommand: (input: {
    draftId: string; mailboxId: string; rfc822MessageId: string; contentFingerprint: string; encryptedRecipients: string; encryptedSubject: string; encryptedPlainText: string; encryptedHtml: string | null;
    recipientCount: number; bodyByteCount: number; hasHtml: boolean; encryptedCommandPayload: string; requestFingerprint: string; idempotencyKey: string;
  }) => Promise<CreatedDraftCommand>;
  findDraftForUser: (mailboxId: string, draftId: string, userId: string) => Promise<StoredDraft | null>;
  isIdempotencyConflictError: (error: unknown) => boolean;
};

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function bodyBytes(content: { plainText: string; html: string | null }) { return Buffer.byteLength(content.plainText, "utf8") + (content.html ? Buffer.byteLength(content.html, "utf8") : 0); }

export function registerDraftRoutes(app: FastifyInstance<any, any, any, any>, deps: Deps) {
  const { config, pool, findMailboxForUser, createDraftWithCommand, findDraftForUser, isIdempotencyConflictError } = deps;
  app.post<{ Params: { mailboxId: string }; Body: DraftContentInput }>("/v1/mailboxes/:mailboxId/drafts", async (request, reply) => {
    const user = await authenticatedUser(request, pool);
    if (!user) return reply.code(401).send({ code: "unauthenticated" });
    if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (!validIdempotencyKey(idempotencyKey)) return reply.code(400).send({ code: "invalid_idempotency_key" });
    const mailbox = await findMailboxForUser(request.params.mailboxId, user.id);
    if (!mailbox) return reply.code(404).send({ code: "mailbox_not_found" });
    if (mailbox.status !== "active") return reply.code(409).send({ code: "provider_reauthentication_required" });
    const permission = await pool.query<{ write_capability: string }>("SELECT write_capability FROM mailbox_permission_state WHERE mailbox_account_id=$1", [mailbox.id]);
    if (permission.rows[0]?.write_capability !== "write_granted") return reply.code(409).send({ code: "permission_required" });
    let content;
    try { content = canonicalizeDraftContent(request.body); }
    catch { return reply.code(400).send({ code: "invalid_draft_content" }); }
    const fingerprint = fingerprintDraftContent(content, config.TOKEN_ENCRYPTION_KEY_BASE64);
    const encryptedContent = encryptDraftContent(content, config.TOKEN_ENCRYPTION_KEY_BASE64);
    try {
      const draftId = randomUUID();
      const command = await createDraftWithCommand({
        draftId,
        mailboxId: mailbox.id,
        rfc822MessageId: generateDraftMessageId(new URL(config.API_ORIGIN).hostname),
        contentFingerprint: fingerprint,
        ...encryptedContent,
        recipientCount: content.to.length + content.cc.length + content.bcc.length,
        bodyByteCount: bodyBytes(content),
        hasHtml: content.html !== null,
        encryptedCommandPayload: encryptProviderCommandPayload("create_draft", { version: 1, draftId }, config.TOKEN_ENCRYPTION_KEY_BASE64),
        requestFingerprint: createHash("sha256").update(`create_draft:${fingerprint}`).digest("hex"),
        idempotencyKey
      });
      return reply.code(202).send({ id: command.id, commandType: command.commandType, status: command.status, draftId: command.draftId });
    } catch (error) {
      if (isIdempotencyConflictError(error)) return reply.code(409).send({ code: "idempotency_conflict" });
      throw error;
    }
  });

  app.get<{ Params: { mailboxId: string; draftId: string } }>("/v1/mailboxes/:mailboxId/drafts/:draftId", async (request, reply) => {
    const user = await authenticatedUser(request, pool);
    if (!user) return reply.code(401).send({ code: "unauthenticated" });
    // Ownership is proven by the repository query before encrypted content is decrypted.
    const draft = await findDraftForUser(request.params.mailboxId, request.params.draftId, user.id);
    if (!draft) return reply.code(404).send({ code: "draft_not_found" });
    try {
      const content = decryptDraftContent(draft, config.TOKEN_ENCRYPTION_KEY_BASE64);
      return { id: draft.id, status: draft.status, revision: draft.revision, confirmedRevision: draft.confirmedRevision, recipientCount: draft.recipientCount, hasHtml: draft.hasHtml, createdAt: draft.createdAt, updatedAt: draft.updatedAt, ...content };
    } catch {
      return reply.code(422).send({ code: "draft_unavailable" });
    }
  });
}
