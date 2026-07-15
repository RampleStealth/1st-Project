import test from "node:test";
import assert from "node:assert/strict";
import { normalizeThreadDisplay, SanitizedThreadCache } from "./thread-display.js";
const data = (value: string) => Buffer.from(value).toString("base64url");
const part = (mimeType: string, value?: string, parts?: unknown[], filename = "") => ({ mimeType, filename, body: value === undefined ? {} : { data: data(value), size: value.length }, parts });
const thread = (payload: unknown) => ({ id: "thread-1", historyId: "9", messages: [{ id: "message-1", internalDate: "0", payload }] });
test("normalizes text, html, alternative and nested multipart content", () => {
  assert.equal(normalizeThreadDisplay(thread(part("text/plain", "hello"))).messages[0].plainText, "hello");
  const html = normalizeThreadDisplay(thread(part("text/html", "<p>Hello <b>there</b></p>"))).messages[0]; assert.match(html.sanitizedHtml ?? "", /<p>Hello/); assert.match(html.plainText, /Hello there/);
  const alternative = normalizeThreadDisplay(thread(part("multipart/mixed", undefined, [part("multipart/alternative", undefined, [part("text/plain", "plain"), part("text/html", "<p>rich</p>")])]))).messages[0]; assert.equal(alternative.plainText, "plain"); assert.match(alternative.sanitizedHtml ?? "", /rich/);
});
test("malformed mime and sanitizer failure never return raw html", () => {
  const malformed = normalizeThreadDisplay(thread({ mimeType: "text/html", body: { data: "%%%" } })).messages[0]; assert.equal(malformed.sanitizedHtml, null); assert.equal(malformed.renderingState, "failed");
  const failed = normalizeThreadDisplay(thread(part("text/html", "<script>bad()</script>")), () => { throw new Error("failure"); }).messages[0]; assert.equal(failed.sanitizedHtml, null); assert.equal(failed.renderingState, "failed");
});
test("sanitizer strips active content, remote media, styles and unsafe URLs while rewriting safe links", () => {
  const result = normalizeThreadDisplay(thread(part("text/html", '<script>x</script><p onclick="x()">Text</p><form>x</form><iframe>x</iframe><svg>x</svg><style>x</style><img src="https://remote"><a href="javascript:alert(1)">bad</a><a href="https://example.com/path">safe</a>'))).messages[0].sanitizedHtml ?? "";
  for (const value of ["script", "onclick", "form", "iframe", "svg", "style", "img", "javascript:"]) assert.doesNotMatch(result, new RegExp(value, "i"));
  assert.match(result, /href="https:\/\/example\.com\/path"/); assert.match(result, /rel="noopener noreferrer"/);
});
test("sanitized cache honors hit, ttl, capacity, memory budget and mailbox isolation", () => {
  let now = 0; const value = normalizeThreadDisplay(thread(part("text/plain", "hello"))); const cache = new SanitizedThreadCache({ now: () => now, ttlMs: 5, maxEntries: 1, maxBytes: 10_000 }); const key = cache.key("mailbox-a", thread(part("text/plain", "hello"))); cache.set(key, value); assert.equal(cache.get(key)?.id, "thread-1"); now = 6; assert.equal(cache.get(key), undefined);
  const limited = new SanitizedThreadCache({ maxEntries: 1, maxBytes: 10_000 }); const keyA = limited.key("a", thread(part("text/plain", "one"))); const keyB = limited.key("b", { ...thread(part("text/plain", "two")), id: "thread-2" }); limited.set(keyA, value); limited.set(keyB, { ...value, id: "thread-2" }); assert.equal(limited.get(keyA), undefined); assert.ok(limited.get(keyB)); assert.notEqual(keyA, limited.key("b", thread(part("text/plain", "hello"))));
  const tiny = new SanitizedThreadCache({ maxBytes: 1 }); tiny.set(keyA, value); assert.equal(tiny.get(keyA), undefined);
});
