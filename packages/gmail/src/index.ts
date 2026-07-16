import { google, gmail_v1 } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";
import type { AppConfig } from "@aio/config";
import { decryptSecret } from "@aio/security";
import type { MailboxView, SyncErrorCode } from "@aio/contracts";
export * from "./thread-display.js";
export * from "./draft-mime.js";

const gmailScopes = ["https://www.googleapis.com/auth/gmail.readonly"];
export class GmailPaginationValidationError extends Error {
  constructor() { super("Gmail page size must be an integer from 1 through 100"); this.name = "GmailPaginationValidationError"; }
}

export function createOAuthClient(config: AppConfig) {
  return new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI);
}
const writeScope = "https://www.googleapis.com/auth/gmail.modify";
export function writeUpgradeAuthorizationUrl(config: AppConfig, state: string, codeChallenge: string) {
  return new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, `${config.API_ORIGIN}/v1/auth/google/write/callback`).generateAuthUrl({ access_type: "offline", scope: [writeScope], state, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256, prompt: "consent", include_granted_scopes: false });
}
export async function exchangeWriteUpgradeCode(config: AppConfig, code: string, verifier: string) {
  const client = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, `${config.API_ORIGIN}/v1/auth/google/write/callback`);
  const { tokens } = await client.getToken({ code, codeVerifier: verifier });
  client.setCredentials(tokens);
  const profile = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
  return { tokens, profile: profile.data };
}

export function authorizationUrl(config: AppConfig, state: string, codeChallenge: string) {
  return createOAuthClient(config).generateAuthUrl({
    access_type: "offline",
    scope: gmailScopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    prompt: "consent",
    include_granted_scopes: false
  });
}

export async function exchangeCode(config: AppConfig, code: string, codeVerifier: string) {
  const client = createOAuthClient(config);
  const { tokens } = await client.getToken({ code, codeVerifier });
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token; reconnect with consent");
  client.setCredentials(tokens);
  const profile = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
  return { tokens, profile: profile.data };
}

export function gmailForMailbox(config: AppConfig, encryptedRefreshToken: string): gmail_v1.Gmail {
  const client = createOAuthClient(config);
  client.setCredentials({ refresh_token: decryptSecret(encryptedRefreshToken, config.TOKEN_ENCRYPTION_KEY_BASE64) });
  return google.gmail({ version: "v1", auth: client });
}

export async function initialThreadIds(gmail: gmail_v1.Gmail, maxResults = 500): Promise<string[]> {
  const response = await gmail.users.threads.list({ userId: "me", maxResults, includeSpamTrash: false });
  return response.data.threads?.flatMap((thread) => thread.id ? [thread.id] : []) ?? [];
}

export async function changedMessageIds(gmail: gmail_v1.Gmail, startHistoryId: string): Promise<{ messageIds: string[]; deletedMessageIds: string[]; latestHistoryId?: string }> {
  const ids = new Set<string>();
  const deletedIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;
  do {
    const response = await gmail.users.history.list({ userId: "me", startHistoryId, pageToken, historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] });
    latestHistoryId = response.data.historyId ?? latestHistoryId;
    for (const history of response.data.history ?? []) {
      for (const entry of [...(history.messagesAdded ?? []), ...(history.labelsAdded ?? []), ...(history.labelsRemoved ?? [])]) {
        if (entry.message?.id) ids.add(entry.message.id);
      }
      for (const entry of history.messagesDeleted ?? []) if (entry.message?.id) deletedIds.add(entry.message.id);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  for (const id of deletedIds) ids.delete(id);
  return { messageIds: [...ids], deletedMessageIds: [...deletedIds], latestHistoryId };
}

export async function getMessage(gmail: gmail_v1.Gmail, id: string) {
  return (await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] })).data;
}

export async function getThread(gmail: gmail_v1.Gmail, id: string) {
  return (await gmail.users.threads.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] })).data;
}

/** Full structured MIME only; never request Gmail's raw message format. */
export async function getThreadFull(gmail: gmail_v1.Gmail, id: string) {
  return (await gmail.users.threads.get({ userId: "me", id, format: "full" })).data;
}
export async function archiveThread(gmail: gmail_v1.Gmail, id: string) { await gmail.users.threads.modify({ userId:"me", id, requestBody:{ removeLabelIds:["INBOX"] } }); }
export async function markThreadUnread(gmail: gmail_v1.Gmail, id: string) { await gmail.users.threads.modify({ userId:"me", id, requestBody:{ addLabelIds:["UNREAD"] } }); }

export type GmailDraftReference = { draftId: string; messageId: string; threadId: string | null };

/** Creates a Gmail draft from the application-owned, validated RFC 5322 MIME document. */
export async function createDraft(gmail: gmail_v1.Gmail, mime: string): Promise<GmailDraftReference> {
  const response = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: Buffer.from(mime, "utf8").toString("base64url") } } });
  const data = response.data;
  if (!data.id || !data.message?.id) throw new Error("Gmail did not confirm a draft identifier");
  return { draftId: data.id, messageId: data.message.id, threadId: data.message.threadId ?? null };
}

/** Metadata-only lookup; raw MIME and draft bodies are deliberately never requested. */
export async function getDraft(gmail: gmail_v1.Gmail, draftId: string): Promise<GmailDraftReference> {
  const response = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "metadata" });
  const data = response.data;
  if (!data.id || !data.message?.id) throw new Error("Gmail draft is unavailable");
  return { draftId: data.id, messageId: data.message.id, threadId: data.message.threadId ?? null };
}

export type DraftMessageIdSearch = { kind: "none" } | { kind: "one"; draft: GmailDraftReference } | { kind: "ambiguous" };
/** Searches Gmail's draft resource only. It requests metadata, never raw MIME or message bodies. */
export async function findDraftByRfc822MessageId(gmail: gmail_v1.Gmail, messageId: string): Promise<DraftMessageIdSearch> {
  const list = await gmail.users.drafts.list({ userId: "me", q: `rfc822msgid:${messageId}`, maxResults: 3 });
  const ids = list.data.drafts?.flatMap((draft) => draft.id ? [draft.id] : []) ?? [];
  if (!ids.length) return { kind: "none" };
  if (ids.length > 1) return { kind: "ambiguous" };
  return { kind: "one", draft: await getDraft(gmail, ids[0]) };
}

export type GmailMutationErrorCode = "resource_deleted" | "write_scope_required" | "reauthorization_required" | "rate_limited" | "transient_provider_failure" | "uncertain_provider_outcome" | "unknown_provider_failure";

/**
 * Mutation failures are stricter than read failures: anything that may have
 * reached Gmail without a definitive response is recovered for verification,
 * never blindly retried.
 */
export function classifyGmailMutationError(error: unknown): GmailMutationErrorCode {
  if (!error || typeof error !== "object") return "unknown_provider_failure";
  const value = error as { code?: unknown; response?: { status?: unknown; data?: { error?: unknown; message?: unknown } }; request?: unknown };
  const status = typeof value.code === "number" ? value.code : typeof value.response?.status === "number" ? value.response.status : undefined;
  const providerError = typeof value.response?.data?.error === "string" ? value.response.data.error : "";
  const message = typeof value.response?.data?.message === "string" ? value.response.data.message : "";
  const scopeFailure = /insufficient.*(scope|permission)|insufficientpermissions/i.test(`${providerError} ${message}`);
  if (status === 401 || providerError === "invalid_grant") return "reauthorization_required";
  if (status === 403 && scopeFailure) return "write_scope_required";
  if (status === 404) return "resource_deleted";
  if (status === 429) return "rate_limited";
  if (status && status >= 500) return "transient_provider_failure";
  if (value.request) return "uncertain_provider_outcome";
  return "unknown_provider_failure";
}

export function threadListLabel(view: MailboxView): string | undefined {
  if (view === "inbox") return "INBOX";
  if (view === "sent") return "SENT";
  if (view === "drafts") return "DRAFT";
  return undefined;
}

export async function listThreads(gmail: gmail_v1.Gmail, view: MailboxView, pageToken: string | undefined, maxResults: number) {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) throw new GmailPaginationValidationError();
  const label = threadListLabel(view);
  const response = await gmail.users.threads.list({ userId: "me", labelIds: label ? [label] : undefined, pageToken, maxResults, includeSpamTrash: false });
  return { threadIds: response.data.threads?.flatMap((thread) => thread.id ? [thread.id] : []) ?? [], nextPageToken: response.data.nextPageToken ?? null };
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

export async function hydrateThreadMetadata(gmail: gmail_v1.Gmail, threadIds: string[], concurrency = 5) {
  const hydrated = await mapWithConcurrency(threadIds, concurrency, async (threadId) => {
    try { return await getThread(gmail, threadId); }
    catch (error) {
      if (classifyGmailError(error, "resource") === "resource_deleted") return undefined;
      throw error;
    }
  });
  return hydrated.filter((thread): thread is gmail_v1.Schema$Thread => Boolean(thread));
}

export async function currentHistoryId(gmail: gmail_v1.Gmail): Promise<string> {
  const profile = await gmail.users.getProfile({ userId: "me" });
  if (!profile.data.historyId) throw new Error("Gmail profile did not include history ID");
  return profile.data.historyId;
}

export async function watchMailbox(gmail: gmail_v1.Gmail, topicName: string) {
  return (await gmail.users.watch({ userId: "me", requestBody: { topicName } })).data;
}

export async function stopWatch(gmail: gmail_v1.Gmail) {
  await gmail.users.stop({ userId: "me" });
}

export function classifyGmailError(error: unknown, operation: "history" | "resource" | "token"): SyncErrorCode {
  if (!error || typeof error !== "object") return "unknown_provider_failure";
  const value = error as { code?: unknown; response?: { status?: unknown; data?: { error?: string } } };
  const status = typeof value.code === "number" ? value.code : typeof value.response?.status === "number" ? value.response.status : undefined;
  if (status === 401 || value.response?.data?.error === "invalid_grant") return "reauthorization_required";
  if (status === 429) return "rate_limited";
  if (status === 404) return operation === "history" ? "history_expired" : "resource_deleted";
  if (status && status >= 500) return "transient_provider_failure";
  return "unknown_provider_failure";
}

type ProviderLogContext = { operation: string; mailboxId?: string; correlationId?: string; jobId?: string };
type ProviderErrorShape = { code?: unknown; response?: { status?: unknown; data?: unknown }; config?: unknown; request?: unknown };

function providerStatusCategory(error: unknown): "http_401" | "http_404" | "http_429" | "http_4xx" | "http_5xx" | "network" | "unknown" {
  const value = error as ProviderErrorShape;
  const status = typeof value?.code === "number" ? value.code : typeof value?.response?.status === "number" ? value.response.status : undefined;
  if (status === 401) return "http_401";
  if (status === 404) return "http_404";
  if (status === 429) return "http_429";
  if (status && status >= 500) return "http_5xx";
  if (status && status >= 400) return "http_4xx";
  return value?.request ? "network" : "unknown";
}

export function isGmailProviderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as ProviderErrorShape;
  return typeof value.code === "number" || typeof value.response?.status === "number" || value.response?.data !== undefined || Boolean(value.config && value.request);
}

/** Allowlisted metadata only; raw provider responses, headers, tokens, URLs, and IDs never enter logs. */
export function sanitizeGmailProviderError(error: unknown, context: ProviderLogContext) {
  const applicationErrorCode = classifyGmailError(error, "resource");
  return {
    applicationErrorCode,
    statusCategory: providerStatusCategory(error),
    operation: context.operation,
    ...(context.mailboxId ? { mailboxId: context.mailboxId } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    ...(context.jobId ? { jobId: context.jobId } : {}),
    retryable: applicationErrorCode === "rate_limited" || applicationErrorCode === "transient_provider_failure",
    message: "Gmail provider operation failed"
  };
}
