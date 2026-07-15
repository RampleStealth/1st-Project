import { createHash } from "node:crypto";
import type { gmail_v1 } from "googleapis";
import sanitizeHtml from "sanitize-html";

export type ThreadDisplayAttachment = { filename: string; mimeType: string; size: number | null };
export type ThreadDisplayMessage = {
  id: string; from: string | null; to: string[]; cc: string[]; bcc: string[]; subject: string | null;
  sentAt: string | null; labels: string[]; attachments: ThreadDisplayAttachment[]; plainText: string;
  sanitizedHtml: string | null; renderingState: "ready" | "fallback" | "failed";
};
export type ThreadDisplay = { id: string; messages: ThreadDisplayMessage[] };

const allowedTags = ["p", "br", "div", "span", "b", "strong", "i", "em", "u", "blockquote", "ul", "ol", "li", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "td", "th", "a"];
const allowedAttributes = { a: ["href", "rel", "target"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] };
export const safeIframeCsp = "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'";

function header(headers: gmail_v1.Schema$MessagePartHeader[] | null | undefined, name: string) {
  return headers?.find((item) => item.name?.toLowerCase() === name)?.value ?? null;
}
function addresses(value: string | null) { return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : []; }
function decode(data: string | null | undefined) {
  if (!data || !/^[A-Za-z0-9_-]+={0,2}$/.test(data)) throw new Error("malformed_mime");
  return Buffer.from(data, "base64url").toString("utf8");
}
function safeUrl(value: string) {
  try { const url = new URL(value); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.toString() : null; }
  catch { return null; }
}
export function sanitizeMessageHtml(value: string) {
  return sanitizeHtml(value, {
    allowedTags, allowedAttributes, allowedSchemes: ["http", "https", "mailto"],
    disallowedTagsMode: "discard",
    transformTags: {
      a: (_tagName, attrs) => {
        const href = attrs.href ? safeUrl(attrs.href) : null;
        const attribs: Record<string, string> = { rel: "noopener noreferrer" };
        if (href) { attribs.href = href; attribs.target = "_blank"; }
        return { tagName: "a", attribs };
      }
    }
  });
}
function htmlToText(value: string) { return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim(); }
type Content = { plain: string[]; html: string[]; attachments: ThreadDisplayAttachment[]; malformed: boolean };
function collect(part: gmail_v1.Schema$MessagePart | undefined, content: Content): void {
  if (!part) { content.malformed = true; return; }
  const mime = part.mimeType?.toLowerCase() ?? "";
  if (part.filename) content.attachments.push({ filename: part.filename, mimeType: mime || "application/octet-stream", size: typeof part.body?.size === "number" ? part.body.size : null });
  if (mime === "text/plain" && part.body?.data) { try { content.plain.push(decode(part.body.data)); } catch { content.malformed = true; } }
  if (mime === "text/html" && part.body?.data) { try { content.html.push(decode(part.body.data)); } catch { content.malformed = true; } }
  for (const child of part.parts ?? []) collect(child, content);
}
export function normalizeThreadDisplay(thread: gmail_v1.Schema$Thread, sanitizer = sanitizeMessageHtml): ThreadDisplay {
  if (!thread.id || !thread.messages) throw new Error("invalid_thread");
  return { id: thread.id, messages: thread.messages.map((message) => {
    const content: Content = { plain: [], html: [], attachments: [], malformed: false };
    collect(message.payload ?? undefined, content);
    const rawHtml = content.html.at(-1);
    let sanitizedHtml: string | null = null;
    let plainText = content.plain.join("\n\n").trim();
    let renderingState: ThreadDisplayMessage["renderingState"] = "ready";
    try { if (rawHtml) sanitizedHtml = sanitizer(rawHtml); }
    catch { renderingState = "failed"; }
    // Derive HTML-only fallback from the sanitized form, never from provider HTML.
    if (!plainText && sanitizedHtml) { try { plainText = htmlToText(sanitizedHtml); } catch { renderingState = "failed"; } }
    if (!plainText) plainText = renderingState === "failed" || content.malformed ? "Message content could not be rendered safely." : "No readable message content.";
    if (!sanitizedHtml && rawHtml && renderingState === "ready") renderingState = "fallback";
    if (content.malformed && !sanitizedHtml) renderingState = "failed";
    return { id: message.id ?? "", from: header(message.payload?.headers, "from"), to: addresses(header(message.payload?.headers, "to")), cc: addresses(header(message.payload?.headers, "cc")), bcc: addresses(header(message.payload?.headers, "bcc")), subject: header(message.payload?.headers, "subject"), sentAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null, labels: message.labelIds ?? [], attachments: content.attachments, plainText, sanitizedHtml, renderingState };
  }) };
}
function contentIdentity(thread: gmail_v1.Schema$Thread) { return createHash("sha256").update(JSON.stringify([thread.id, thread.historyId, thread.messages?.map((message) => [message.id, message.internalDate, message.labelIds])])).digest("hex"); }
export class SanitizedThreadCache {
  private values = new Map<string, { value: ThreadDisplay; expiresAt: number; bytes: number }>();
  private used = 0;
  constructor(private options: { ttlMs?: number; maxEntries?: number; maxBytes?: number; now?: () => number } = {}) {}
  get(key: string) { const item = this.values.get(key); if (!item) return undefined; if (item.expiresAt <= (this.options.now?.() ?? Date.now())) { this.values.delete(key); this.used -= item.bytes; return undefined; } this.values.delete(key); this.values.set(key, item); return structuredClone(item.value); }
  set(key: string, value: ThreadDisplay) { const bytes = Buffer.byteLength(JSON.stringify(value)); const maxBytes = this.options.maxBytes ?? 2 * 1024 * 1024; if (bytes > maxBytes) return; const old = this.values.get(key); if (old) { this.values.delete(key); this.used -= old.bytes; } while (this.values.size >= (this.options.maxEntries ?? 100) || this.used + bytes > maxBytes) { const first = this.values.entries().next().value as [string, { bytes: number }] | undefined; if (!first) break; this.values.delete(first[0]); this.used -= first[1].bytes; } this.values.set(key, { value: structuredClone(value), bytes, expiresAt: (this.options.now?.() ?? Date.now()) + (this.options.ttlMs ?? 300_000) }); this.used += bytes; }
  key(mailboxId: string, thread: gmail_v1.Schema$Thread) { return `${mailboxId}:${contentIdentity(thread)}`; }
}
