import { createHash } from "node:crypto";
import { z } from "zod";
import { decryptSecret, deriveSearchCursorKey, encryptSecret } from "@aio/security";

const searchInputSchema = z.object({
  query: z.string(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(10)
}).strict();

const searchCursorSchema = z.object({
  version: z.literal(1),
  userId: z.string().uuid(),
  mailboxId: z.string().uuid(),
  queryDigest: z.string().length(43),
  limit: z.number().int().min(1).max(10),
  providerPageToken: z.string().min(1),
  expiresAt: z.number().int().positive()
}).strict();

export class SearchRequestError extends Error {
  constructor() { super("invalid_search_request"); }
}

export class SearchCursorError extends Error {
  constructor() { super("invalid_search_cursor"); }
}

export type KeywordSearch = { normalizedQuery: string; terms: string[] };
export type SearchCursorContext = { userId: string; mailboxId: string; queryDigest: string; limit: number };

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
  return { ...parsed.data, ...parseKeywordSearch(parsed.data.query) };
}

export function searchQueryDigest(terms: string[]) {
  return createHash("sha256").update(JSON.stringify(terms), "utf8").digest("base64url");
}

export function encodeSearchCursor(payload: SearchCursorContext & { providerPageToken: string; expiresAt: number }, masterKeyBase64: string) {
  return encryptSecret(JSON.stringify({ version: 1, ...payload }), deriveSearchCursorKey(masterKeyBase64));
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
    || payload.queryDigest !== context.queryDigest
    || payload.limit !== context.limit) throw new SearchCursorError();
  return payload.providerPageToken;
}
