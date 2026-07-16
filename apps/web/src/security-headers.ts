import type { AppConfig } from "@aio/config";

export function browserSecurityHeaders(config: Pick<AppConfig, "NODE_ENV">): Record<string, string> {
  return {
    "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; connect-src 'self'; img-src 'self' data:; font-src 'self'; script-src 'self'; style-src 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-site",
    "x-frame-options": "DENY",
    ...(config.NODE_ENV === "production" ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {})
  };
}
