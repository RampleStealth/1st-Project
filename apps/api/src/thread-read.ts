import { classifyGmailError } from "@aio/gmail";

export function threadReadProviderFailure(error: unknown) {
  const failure = classifyGmailError(error, "resource");
  if (failure === "reauthorization_required") return { status: 409, body: { code: "provider_reauthentication_required", message: "Reconnect Gmail before reading this conversation.", retryable: false } };
  if (failure === "resource_deleted") return { status: 404, body: { code: "thread_deleted", message: "This conversation is no longer available in Gmail.", retryable: false } };
  if (failure === "rate_limited" || failure === "transient_provider_failure") return { status: 503, body: { code: "provider_temporarily_unavailable", message: "Gmail is temporarily unavailable. Try again shortly.", retryable: true } };
  return { status: 502, body: { code: "provider_thread_read_failed", message: "We could not load this Gmail conversation.", retryable: true } };
}
