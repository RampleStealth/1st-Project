import type { NormalizedMailboxAddress, ThreadProjectionInput, ThreadProjectionMessage } from "@aio/contracts";
import type { gmail_v1 } from "googleapis";

const encodedWordPattern = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;
const emailPattern = /^[^\s@<>,;]+@[^\s@<>,;]+$/u;

function decodeBytes(bytes: Buffer, charset: string) {
  const normalized = charset.trim().toLowerCase();
  const encoding = normalized === "iso-8859-1" || normalized === "latin1" ? "latin1" : "utf-8";
  try { return new TextDecoder(encoding).decode(bytes); }
  catch { return bytes.toString("utf8"); }
}

function decodeQuotedPrintableWord(value: string) {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "=" && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push((value[index] === "_" ? " " : value[index]).charCodeAt(0));
    }
  }
  return Buffer.from(bytes);
}

export function decodeMimeHeaderWords(value: string) {
  return value.replace(encodedWordPattern, (_match, charset: string, encoding: string, encoded: string) => {
    try {
      const bytes = encoding.toLowerCase() === "b" ? Buffer.from(encoded, "base64") : decodeQuotedPrintableWord(encoded);
      return decodeBytes(bytes, charset);
    } catch {
      return "";
    }
  }).replace(/\s+/gu, " ").trim().normalize("NFC");
}

function splitMailboxList(value: string) {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  let commentDepth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"' && commentDepth === 0) { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "(") { commentDepth++; continue; }
    if (character === ")" && commentDepth > 0) { commentDepth--; continue; }
    if (commentDepth > 0) continue;
    if (character === "<") { angleDepth++; continue; }
    if (character === ">" && angleDepth > 0) { angleDepth--; continue; }
    if ((character === "," || character === ";") && angleDepth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

function normalizeDisplayName(value: string | undefined) {
  if (!value) return null;
  let name = decodeMimeHeaderWords(value).trim();
  if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(["\\])/g, "$1").trim();
  name = name.replace(/\s+/gu, " ").normalize("NFC");
  return name || null;
}

function normalizeEmail(value: string) {
  const address = value.trim().replace(/^mailto:/i, "").normalize("NFC").toLowerCase();
  return emailPattern.test(address) ? address : null;
}

function parseMailbox(entry: string): NormalizedMailboxAddress | null {
  let decoded = decodeMimeHeaderWords(entry);
  const groupPrefix = decoded.match(/^[^:]+:\s*(.+@.+)$/u);
  if (groupPrefix) decoded = groupPrefix[1].trim();
  const angle = decoded.match(/^(.*?)<([^<>]+)>\s*$/u);
  if (angle) {
    const address = normalizeEmail(angle[2]);
    return address ? { displayName: normalizeDisplayName(angle[1]), address } : null;
  }
  const comment = decoded.match(/^([^()\s]+@[^()\s]+)\s*\(([^()]*)\)\s*$/u);
  if (comment) {
    const address = normalizeEmail(comment[1]);
    return address ? { displayName: normalizeDisplayName(comment[2]), address } : null;
  }
  const trailingAddress = decoded.match(/^(.*?)\s+([^\s<>(),;]+@[^\s<>(),;]+)$/u);
  if (trailingAddress) {
    const address = normalizeEmail(trailingAddress[2]);
    return address ? { displayName: normalizeDisplayName(trailingAddress[1]), address } : null;
  }
  const address = normalizeEmail(decoded);
  return address ? { displayName: null, address } : null;
}

export function parseMailboxList(value: string | null | undefined): NormalizedMailboxAddress[] {
  if (!value) return [];
  const byAddress = new Map<string, NormalizedMailboxAddress>();
  for (const entry of splitMailboxList(value)) {
    const mailbox = parseMailbox(entry);
    if (!mailbox) continue;
    const previous = byAddress.get(mailbox.address);
    if (!previous || !previous.displayName && mailbox.displayName) byAddress.set(mailbox.address, mailbox);
  }
  return [...byAddress.values()];
}

function header(message: gmail_v1.Schema$Message, name: string) {
  return message.payload?.headers?.filter((item) => item.name?.toLowerCase() === name.toLowerCase()).flatMap((item) => item.value ? [item.value] : []).join(", ") || null;
}

function normalizeText(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const normalized = decodeMimeHeaderWords(value).replace(/\s+/gu, " ").trim().normalize("NFC");
  return normalized || null;
}

function normalizeTimestamp(value: string | null | undefined) {
  if (!value || !/^\d+$/u.test(value)) return null;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) return null;
  const timestamp = new Date(milliseconds);
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function hasAttachment(part: gmail_v1.Schema$MessagePart | null | undefined): boolean {
  if (!part) return false;
  if (Boolean(part.filename?.trim()) || Boolean(part.body?.attachmentId)) return true;
  return (part.parts ?? []).some((child) => hasAttachment(child));
}

function normalizeMessage(message: gmail_v1.Schema$Message): ThreadProjectionMessage | null {
  if (!message.id) return null;
  const from = parseMailboxList(header(message, "From"))[0] ?? null;
  return {
    providerMessageId: message.id,
    internalTimestamp: normalizeTimestamp(message.internalDate),
    labels: [...new Set(message.labelIds ?? [])].sort(),
    snippet: normalizeText(message.snippet),
    subject: normalizeText(header(message, "Subject")),
    from,
    to: parseMailboxList(header(message, "To")),
    cc: parseMailboxList(header(message, "Cc")),
    hasAttachments: hasAttachment(message.payload)
  };
}

/** Converts Gmail's partial, body-free MIME metadata into a deterministic provider-neutral projection. */
export function normalizeThreadProjection(thread: gmail_v1.Schema$Thread): ThreadProjectionInput | null {
  if (!thread.id) return null;
  const messages = (thread.messages ?? []).flatMap((message) => {
    const normalized = normalizeMessage(message);
    return normalized ? [normalized] : [];
  }).sort((left, right) => {
    if (left.internalTimestamp === null && right.internalTimestamp !== null) return -1;
    if (left.internalTimestamp !== null && right.internalTimestamp === null) return 1;
    const byTimestamp = (left.internalTimestamp ?? "").localeCompare(right.internalTimestamp ?? "");
    return byTimestamp || left.providerMessageId.localeCompare(right.providerMessageId);
  });
  return { providerThreadId: thread.id, messages };
}
