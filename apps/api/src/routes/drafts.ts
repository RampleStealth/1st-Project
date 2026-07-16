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
  id: string; status: string; revision: number; confirmedRevision: number | null; contentFingerprint: string; confirmedContentFingerprint: string | null; recipientCount: number; hasHtml: boolean; createdAt: Date; updatedAt: Date;
};
type Deps = {
  config: AppConfig;
  pool: Pool;
  findMailboxForUser: (mailboxAccountId: string, userId: string) => Promise<MailboxAccount | null>;
  createDraftWithCommand: (input: {
    draftId: string; mailboxId: string; rfc822MessageId: string; contentFingerprint: string; encryptedRecipients: string; encryptedSubject: string; encryptedPlainText: string; encryptedHtml: string | null;
    recipientCount: number; bodyByteCount: number; hasHtml: boolean; encryptedCommandPayload: string; requestFingerprint: string; idempotencyKey: string;
  }) => Promise<CreatedDraftCommand>;
  updateDraftWithCommand: (input: {
    draftId: string; mailboxId: string; expectedRevision: number; contentFingerprint: string; encryptedRecipients: string; encryptedSubject: string; encryptedPlainText: string; encryptedHtml: string | null;
    recipientCount: number; bodyByteCount: number; hasHtml: boolean; encryptedCommandPayload: string; requestFingerprint: string; idempotencyKey: string;
  }) => Promise<CreatedDraftCommand>;
  sendDraftWithCommand: (input: { draftId: string; mailboxId: string; expectedRevision: number; encryptedCommandPayload: string; requestFingerprint: string; idempotencyKey: string }) => Promise<CreatedDraftCommand>;
  findDraftForUser: (mailboxId: string, draftId: string, userId: string) => Promise<StoredDraft | null>;
  findSendRecoveryCommandForUser: (mailboxId: string, draftId: string, userId: string) => Promise<{ id: string; status: string } | null>;
  enqueueSendDraftVerification: (commandId: string) => Promise<unknown>;
  isIdempotencyConflictError: (error: unknown) => boolean;
  isDraftRevisionConflictError: (error: unknown) => boolean;
  isDraftStateConflictError: (error: unknown) => boolean;
  isActiveDraftCommandError: (error: unknown) => boolean;
};

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function bodyBytes(content: { plainText: string; html: string | null }) { return Buffer.byteLength(content.plainText, "utf8") + (content.html ? Buffer.byteLength(content.html, "utf8") : 0); }
function ifMatchRevision(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^"([1-9]\d*)"$/.exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

export function registerDraftRoutes(app: FastifyInstance<any, any, any, any>, deps: Deps) {
  const { config, pool, findMailboxForUser, createDraftWithCommand, updateDraftWithCommand, sendDraftWithCommand, findDraftForUser, findSendRecoveryCommandForUser, enqueueSendDraftVerification, isIdempotencyConflictError, isDraftRevisionConflictError, isDraftStateConflictError, isActiveDraftCommandError } = deps;
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

  app.put<{ Params: { mailboxId: string; draftId: string }; Body: DraftContentInput }>("/v1/mailboxes/:mailboxId/drafts/:draftId", async (request, reply) => {
    const user = await authenticatedUser(request, pool);
    if (!user) return reply.code(401).send({ code: "unauthenticated" });
    if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (!validIdempotencyKey(idempotencyKey)) return reply.code(400).send({ code: "invalid_idempotency_key" });
    const header = request.headers["if-match"];
    if (header === undefined) return reply.code(428).send({ code: "precondition_required" });
    const expectedRevision = ifMatchRevision(header);
    if (expectedRevision === null) return reply.code(400).send({ code: "invalid_draft_revision" });
    const mailbox = await findMailboxForUser(request.params.mailboxId, user.id);
    if (!mailbox) return reply.code(404).send({ code: "mailbox_not_found" });
    if (mailbox.status !== "active") return reply.code(409).send({ code: "provider_reauthentication_required" });
    const permission = await pool.query<{ write_capability: string }>("SELECT write_capability FROM mailbox_permission_state WHERE mailbox_account_id=$1", [mailbox.id]);
    if (permission.rows[0]?.write_capability !== "write_granted") return reply.code(409).send({ code: "permission_required" });
    // Verify owner scope before accepting, canonicalizing, or encrypting any new desired content.
    if (!await findDraftForUser(mailbox.id, request.params.draftId, user.id)) return reply.code(404).send({ code: "draft_not_found" });
    let content;
    try { content = canonicalizeDraftContent(request.body); }
    catch { return reply.code(400).send({ code: "invalid_draft_content" }); }
    const fingerprint = fingerprintDraftContent(content, config.TOKEN_ENCRYPTION_KEY_BASE64);
    const nextRevision = expectedRevision + 1;
    try {
      const command = await updateDraftWithCommand({
        draftId: request.params.draftId,
        mailboxId: mailbox.id,
        expectedRevision,
        contentFingerprint: fingerprint,
        ...encryptDraftContent(content, config.TOKEN_ENCRYPTION_KEY_BASE64),
        recipientCount: content.to.length + content.cc.length + content.bcc.length,
        bodyByteCount: bodyBytes(content),
        hasHtml: content.html !== null,
        encryptedCommandPayload: encryptProviderCommandPayload("update_draft", { version: 1, draftId: request.params.draftId, revision: nextRevision }, config.TOKEN_ENCRYPTION_KEY_BASE64),
        requestFingerprint: createHash("sha256").update(`update_draft:${request.params.draftId}:${expectedRevision}:${fingerprint}`).digest("hex"),
        idempotencyKey
      });
      return reply.code(202).send({ id: command.id, commandType: command.commandType, status: command.status, draftId: command.draftId, revision: nextRevision });
    } catch (error) {
      if (isIdempotencyConflictError(error)) return reply.code(409).send({ code: "idempotency_conflict" });
      if (isDraftRevisionConflictError(error)) return reply.code(409).send({ code: "draft_revision_conflict" });
      if (isActiveDraftCommandError(error)) return reply.code(409).send({ code: "draft_command_active" });
      if (isDraftStateConflictError(error)) return reply.code(409).send({ code: "draft_not_ready" });
      throw error;
    }
  });

  app.post<{ Params: { mailboxId: string; draftId: string } }>("/v1/mailboxes/:mailboxId/drafts/:draftId/send", async (request, reply) => {
    const user = await authenticatedUser(request, pool);
    if (!user) return reply.code(401).send({ code: "unauthenticated" });
    if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (!validIdempotencyKey(idempotencyKey)) return reply.code(400).send({ code: "invalid_idempotency_key" });
    const header = request.headers["if-match"];
    if (header === undefined) return reply.code(428).send({ code: "precondition_required" });
    const expectedRevision = ifMatchRevision(header);
    if (expectedRevision === null) return reply.code(400).send({ code: "invalid_draft_revision" });
    const mailbox = await findMailboxForUser(request.params.mailboxId, user.id);
    if (!mailbox) return reply.code(404).send({ code: "mailbox_not_found" });
    if (mailbox.status !== "active") return reply.code(409).send({ code: "provider_reauthentication_required" });
    const permission = await pool.query<{ write_capability: string }>("SELECT write_capability FROM mailbox_permission_state WHERE mailbox_account_id=$1", [mailbox.id]);
    if (permission.rows[0]?.write_capability !== "write_granted") return reply.code(409).send({ code: "permission_required" });
    // Prove owner scope before deriving the fingerprint; request bodies have no send controls.
    const draft = await findDraftForUser(mailbox.id, request.params.draftId, user.id);
    if (!draft) return reply.code(404).send({ code: "draft_not_found" });
    if (draft.revision !== expectedRevision || draft.confirmedRevision !== expectedRevision || draft.contentFingerprint !== draft.confirmedContentFingerprint) return reply.code(409).send({ code: "draft_not_confirmed" });
    const requestFingerprint = createHash("sha256").update(`send_draft:${mailbox.id}:${draft.id}:${expectedRevision}:${draft.confirmedContentFingerprint}`).digest("hex");
    try {
      const command = await sendDraftWithCommand({
        draftId: draft.id,
        mailboxId: mailbox.id,
        expectedRevision,
        encryptedCommandPayload: encryptProviderCommandPayload("send_draft", { version: 1, draftId: draft.id, revision: expectedRevision }, config.TOKEN_ENCRYPTION_KEY_BASE64),
        requestFingerprint,
        idempotencyKey
      });
      return reply.code(202).send({ id: command.id, commandType: command.commandType, status: command.status, draftId: command.draftId, revision: expectedRevision });
    } catch (error) {
      if (isIdempotencyConflictError(error)) return reply.code(409).send({ code: "idempotency_conflict" });
      if (isDraftRevisionConflictError(error)) return reply.code(409).send({ code: "draft_revision_conflict" });
      if (isActiveDraftCommandError(error)) return reply.code(409).send({ code: "draft_command_active" });
      if (isDraftStateConflictError(error)) return reply.code(409).send({ code: "draft_not_ready" });
      throw error;
    }
  });

  app.post<{ Params: { mailboxId: string; draftId: string } }>("/v1/mailboxes/:mailboxId/drafts/:draftId/send-verification", async (request, reply) => {
    const user = await authenticatedUser(request, pool);
    if (!user) return reply.code(401).send({ code: "unauthenticated" });
    if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed" });
    const command = await findSendRecoveryCommandForUser(request.params.mailboxId, request.params.draftId, user.id);
    if (!command) return reply.code(409).send({ code: "send_verification_unavailable" });
    try { await enqueueSendDraftVerification(command.id); }
    catch { return reply.code(503).send({ code: "verification_unavailable" }); }
    return reply.code(202).send({ id: command.id, status: "verification_pending" });
  });
}
