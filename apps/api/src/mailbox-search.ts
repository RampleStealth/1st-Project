import { createHash } from "node:crypto";
import { z } from "zod";
import { mailboxSearchScopeSchema, type MailboxSearchCriteria } from "@aio/contracts";
import { decryptSecret, deriveSearchCursorKey, encryptSecret } from "@aio/security";

const searchInputSchema = z.object({
  query: z.string().optional(),
  scope: mailboxSearchScopeSchema.default("all"),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  unread: z.literal("true").optional(),
  hasAttachment: z.literal("true").optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(10).max(10).default(10)
}).strict();

const searchCursorSchema = z.object({
  version: z.literal(2),
  userId: z.string().uuid(),
  mailboxId: z.string().uuid(),
  criteriaDigest: z.string().length(43),
  limit: z.literal(10),
  providerPageToken: z.string().min(1),
  expiresAt: z.number().int().positive()
}).strict();

export class SearchRequestError extends Error {
  constructor(readonly field?: "query" | "scope" | "from" | "to" | "subject" | "after" | "before" | "unread" | "hasAttachment") { super("invalid_search_request"); }
}

export class SearchCursorError extends Error {
  constructor() { super("invalid_search_cursor"); }
}

export type KeywordSearch = { normalizedQuery: string; terms: string[] };
export type SearchCursorContext = { userId: string; mailboxId: string; criteriaDigest: string; limit: 10 };

export function parseKeywordSearch(input: string): KeywordSearch {
  const value = input.normalize("NFC").trim();
  if (!value || [...value].length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new SearchRequestError();
  const terms: string[] = [];
  let token = "";
  let quoted = false;
  let tokenWasQuoted = false;
  const finish = () => {
    const term = token.trim().replace(/\s+/gu, " ");
    if (!term) {
      if (tokenWasQuoted) throw new SearchRequestError();
      return;
    }
    if (!tokenWasQuoted && term.includes(":")) throw new SearchRequestError();
    terms.push(term);
    token = "";
    tokenWasQuoted = false;
  };
  for (const character of value) {
    if (character === "\"") {
      if (quoted) { quoted = false; tokenWasQuoted = true; }
      else {
        if (token.trim()) throw new SearchRequestError();
        quoted = true;
      }
      continue;
    }
    if (/\s/u.test(character) && !quoted) { finish(); continue; }
    if (tokenWasQuoted || character === "\\") throw new SearchRequestError();
    token += character;
  }
  if (quoted) throw new SearchRequestError();
  finish();
  if (!terms.length || terms.length > 20 || terms.some((term) => [...term].length > 100)) throw new SearchRequestError();
  return {
    terms,
    normalizedQuery: terms.map((term) => term.includes(" ") || term.includes(":") ? `"${term}"` : term).join(" ")
  };
}

export function parseSearchRequest(input: unknown) {
  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) throw new SearchRequestError();
  const keyword = parsed.data.query?.trim() ? parseKeywordSearch(parsed.data.query) : { normalizedQuery: "", terms: [] };
  const criteria: MailboxSearchCriteria = {
    terms: keyword.terms,
    scope: parsed.data.scope,
    from: normalizeFilterLiteral(parsed.data.from, 254, "from"),
    to: normalizeFilterLiteral(parsed.data.to, 254, "to"),
    subject: normalizeFilterLiteral(parsed.data.subject, 200, "subject"),
    after: normalizeDate(parsed.data.after, "after"),
    before: normalizeDate(parsed.data.before, "before"),
    unread: parsed.data.unread === "true",
    hasAttachment: parsed.data.hasAttachment === "true"
  };
  if (criteria.after && criteria.before && criteria.after >= criteria.before) throw new SearchRequestError("before");
  if (!hasEffectiveSearchCriteria(criteria)) throw new SearchRequestError();
  return { cursor: parsed.data.cursor, limit: parsed.data.limit as 10, normalizedQuery: keyword.normalizedQuery, criteria };
}

function normalizeFilterLiteral(input: string | undefined, maximum: number, field: "from" | "to" | "subject") {
  if (input === undefined) return null;
  if (/[\u0000-\u001f\u007f-\u009f"\\]/u.test(input)) throw new SearchRequestError(field);
  const value = input.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!value) return null;
  if ([...value].length > maximum) throw new SearchRequestError(field);
  return value;
}

function normalizeDate(input: string | undefined, field: "after" | "before") {
  if (input === undefined || !input.trim()) return null;
  const value = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SearchRequestError(field);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new SearchRequestError(field);
  return value;
}

export function hasEffectiveSearchCriteria(criteria: MailboxSearchCriteria) {
  return criteria.terms.length > 0
    || criteria.scope !== "all"
    || Boolean(criteria.from || criteria.to || criteria.subject || criteria.after || criteria.before || criteria.unread || criteria.hasAttachment);
}

export function searchCriteriaDigest(criteria: MailboxSearchCriteria) {
  return createHash("sha256").update(JSON.stringify(criteria), "utf8").digest("base64url");
}

export function encodeSearchCursor(payload: SearchCursorContext & { providerPageToken: string; expiresAt: number }, masterKeyBase64: string) {
  return encryptSecret(JSON.stringify({ version: 2, ...payload }), deriveSearchCursorKey(masterKeyBase64));
}

export function decodeSearchCursor(cursor: string, context: SearchCursorContext, masterKeyBase64: string) {
  let payload: z.infer<typeof searchCursorSchema>;
  try {
    payload = searchCursorSchema.parse(JSON.parse(decryptSecret(cursor, deriveSearchCursorKey(masterKeyBase64))));
  } catch {
    throw new SearchCursorError();
  }
  if (payload.expiresAt <= Date.now()
    || payload.userId !== context.userId
    || payload.mailboxId !== context.mailboxId
    || payload.criteriaDigest !== context.criteriaDigest
    || payload.limit !== context.limit) throw new SearchCursorError();
  return payload.providerPageToken;
}
