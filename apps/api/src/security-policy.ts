import type { AppConfig } from "@aio/config";
import type { FastifyReply, FastifyRequest } from "fastify";

export const productionCsp = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export function applySecurityHeaders(reply: FastifyReply, config: AppConfig) {
  reply.header("content-security-policy", productionCsp);
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  reply.header("cross-origin-opener-policy", "same-origin");
  // APP_ORIGIN and API_ORIGIN share a hostname but can use different local-development ports.
  reply.header("cross-origin-resource-policy", "same-site");
  reply.header("x-frame-options", "DENY");
  if (config.NODE_ENV === "production") reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
}

export function trustedOrigin(value: unknown, config: AppConfig): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try { return new URL(value).origin === new URL(config.APP_ORIGIN).origin && new URL(value).pathname === "/"; }
  catch { return false; }
}

export function isBrowserMutationRequest(request: FastifyRequest): boolean {
  if (!(["POST", "PUT", "DELETE"] as string[]).includes(request.method)) return false;
  const route = request.routeOptions.url ?? request.url.split("?")[0];
  if (route === "/v1/webhooks/gmail") return false;
  // Intentional, unauthenticated account connection must still prove same-origin browser intent.
  if (route === "/v1/auth/google/start") return true;
  return Boolean(request.cookies.aio_session);
}

export function hasAllowedContentType(request: FastifyRequest): boolean {
  const route = request.routeOptions.url ?? request.url.split("?")[0];
  const contentType = request.headers["content-type"];
  const mediaType = typeof contentType === "string" ? contentType.split(";", 1)[0].trim().toLowerCase() : "";
  const acceptsJson = route === "/v1/webhooks/gmail" || route === "/v1/mailboxes/:mailboxId/drafts" || (route === "/v1/mailboxes/:mailboxId/drafts/:draftId" && request.method === "PUT");
  if (acceptsJson) return mediaType === "application/json";
  return !mediaType || mediaType === "application/json";
}

export function requiresEmptyBody(request: FastifyRequest): boolean {
  const route = request.routeOptions.url ?? request.url.split("?")[0];
  return [
    "/v1/auth/logout", "/v1/auth/google/start", "/v1/mailboxes/:mailboxId/permissions/write/start",
    "/v1/mailboxes/:mailboxId/threads/:threadId/archive", "/v1/mailboxes/:mailboxId/threads/:threadId/mark-unread",
    "/v1/mailboxes/:mailboxId/drafts/:draftId/send", "/v1/mailboxes/:mailboxId/drafts/:draftId/send-verification",
    "/v1/mailboxes/:mailboxId"
  ].includes(route);
}

export function declaredContentLength(request: FastifyRequest): number | null {
  const value = request.headers["content-length"];
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}
