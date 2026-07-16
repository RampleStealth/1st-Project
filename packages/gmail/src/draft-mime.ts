import { randomBytes, randomUUID } from "node:crypto";
import { draftContentInputSchema, draftLimits, type CanonicalDraftContent, type DraftContentInput } from "@aio/contracts";
import { sanitizeMessageHtml } from "./thread-display.js";

const recipientPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const messageIdPattern = /^<[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+>$/;

export class DraftValidationError extends Error {
  constructor(public readonly code: "invalid_recipient" | "header_injection" | "content_too_large" | "invalid_message_id" | "invalid_message_id_domain") {
    super(code);
    this.name = "DraftValidationError";
  }
}

function nfc(value: string) { return value.normalize("NFC"); }
function normalNewlines(value: string) { return nfc(value).replace(/\r\n?/g, "\n"); }
function assertNoHeaderBreak(value: string) {
  if (/[\r\n\0]/.test(value)) throw new DraftValidationError("header_injection");
}
function assertBodySize(value: string, limit: number) {
  if (Buffer.byteLength(value, "utf8") > limit) throw new DraftValidationError("content_too_large");
}
function normalizeRecipient(value: string) {
  const normalized = nfc(value).trim();
  assertNoHeaderBreak(normalized);
  if (!recipientPattern.test(normalized)) throw new DraftValidationError("invalid_recipient");
  const at = normalized.lastIndexOf("@");
  return `${normalized.slice(0, at)}@${normalized.slice(at + 1).toLowerCase()}`;
}
function sortRecipients(values: string[]) { return [...new Set(values.map(normalizeRecipient))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0); }
function base64Lines(value: string) { return Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? ""; }
function formatDate(value: Date) {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${weekdays[value.getUTCDay()]}, ${String(value.getUTCDate()).padStart(2, "0")} ${months[value.getUTCMonth()]} ${value.getUTCFullYear()} ${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}:${String(value.getUTCSeconds()).padStart(2, "0")} +0000`;
}
function encodeSubject(value: string) {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function canonicalizeDraftContent(input: DraftContentInput): CanonicalDraftContent {
  const parsed = draftContentInputSchema.parse(input);
  const to = sortRecipients(parsed.to);
  const cc = sortRecipients(parsed.cc);
  const bcc = sortRecipients(parsed.bcc);
  if (to.length + cc.length + bcc.length > draftLimits.maxRecipients) throw new DraftValidationError("invalid_recipient");
  if (new Set([...to, ...cc, ...bcc]).size !== to.length + cc.length + bcc.length) throw new DraftValidationError("invalid_recipient");
  assertNoHeaderBreak(parsed.subject);
  const subject = nfc(parsed.subject).trim().replace(/[\t\f\v ]+/g, " ");
  const plainText = normalNewlines(parsed.plainText);
  const rawHtml = parsed.html === null ? null : normalNewlines(parsed.html);
  assertBodySize(plainText, draftLimits.maxPlainTextBytes);
  if (rawHtml !== null) assertBodySize(rawHtml, draftLimits.maxHtmlBytes);
  const html = rawHtml === null ? null : normalNewlines(sanitizeMessageHtml(rawHtml)) || null;
  return { to, cc, bcc, subject, plainText, html };
}

export function generateDraftMessageId(domain: string, uuid = randomUUID()) {
  const normalizedDomain = domain.trim().toLowerCase();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(normalizedDomain)) {
    throw new DraftValidationError("invalid_message_id_domain");
  }
  return `<${uuid}@${normalizedDomain}>`;
}

export type DraftMime = { mime: string; content: CanonicalDraftContent; boundary: string | null };
export function buildDraftMime(input: DraftContentInput, options: { messageId: string; date?: Date; boundary?: string } ): DraftMime {
  if (!messageIdPattern.test(options.messageId) || /[\r\n\0]/.test(options.messageId)) throw new DraftValidationError("invalid_message_id");
  const content = canonicalizeDraftContent(input);
  const headers = [
    `Message-ID: ${options.messageId}`,
    `Date: ${formatDate(options.date ?? new Date())}`,
    ...(content.to.length ? [`To: ${content.to.join(", ")}`] : []),
    ...(content.cc.length ? [`Cc: ${content.cc.join(", ")}`] : []),
    ...(content.bcc.length ? [`Bcc: ${content.bcc.join(", ")}`] : []),
    `Subject: ${encodeSubject(content.subject)}`,
    "MIME-Version: 1.0"
  ];
  if (content.html === null) {
    return { content, boundary: null, mime: [...headers, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lines(content.plainText), ""].join("\r\n") };
  }
  const boundary = options.boundary ?? `aio-${randomBytes(18).toString("base64url")}`;
  if (!/^[A-Za-z0-9_-]+$/.test(boundary)) throw new DraftValidationError("header_injection");
  return {
    content,
    boundary,
    mime: [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(content.plainText),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(content.html),
      `--${boundary}--`,
      ""
    ].join("\r\n")
  };
}
