import { z } from "zod";
import { draftMessageIdDomainSchema } from "@aio/contracts";

const placeholderSecretPattern = /^(?:change[-_]?me|example|placeholder|your[-_]?secret|secret)$/i;
const nonPlaceholderSecret = (minimum: number) => z.string().min(minimum)
  .refine((value) => !placeholderSecretPattern.test(value.trim()), "must not use a placeholder value")
  .refine((value) => new Set(value).size >= 4, "must not use a low-entropy placeholder value");
const positiveBoundedInteger = (minimum: number, maximum: number, fallback: number) => z.coerce.number().int().min(minimum).max(maximum).default(fallback);
const strictEnvironmentBoolean = z.preprocess((value) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}, z.boolean());

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ORIGIN: z.string().url(),
  API_ORIGIN: z.string().url(),
  DRAFT_MESSAGE_ID_DOMAIN: draftMessageIdDomainSchema,
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_PUBSUB_TOPIC: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/),
  GOOGLE_CLOUD_PROJECT: z.string().min(1),
  PUBSUB_PUSH_AUDIENCE: z.string().url(),
  PUBSUB_SERVICE_ACCOUNT_EMAIL: z.string().email(),
  GMAIL_INITIAL_SYNC_LIMIT: z.coerce.number().int().min(1).max(1_000).default(500),
  SYNC_RECONCILIATION_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(30),
  TOKEN_ENCRYPTION_KEY_BASE64: z.string().min(43),
  SESSION_SECRET: nonPlaceholderSecret(32),
  /** Optional previous secret keeps existing signed session cookies valid during a planned rotation. */
  SESSION_SECRET_PREVIOUS: nonPlaceholderSecret(32).optional(),
  TRUST_PROXY: strictEnvironmentBoolean.default(false),
  API_BODY_LIMIT_BYTES: positiveBoundedInteger(16 * 1024, 2 * 1024 * 1024, 600 * 1024),
  WEBHOOK_BODY_LIMIT_BYTES: positiveBoundedInteger(1 * 1024, 256 * 1024, 64 * 1024),
  RATE_LIMIT_FAILURE_MODE: z.enum(["fail_closed", "fail_open"]).optional(),
  /** When set, diagnostics are protected at the application boundary. */
  DIAGNOSTICS_TOKEN: nonPlaceholderSecret(32).optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  RELEASE_VERSION: z.string().min(1).max(128).optional(),
  RELEASE_COMMIT_SHA: z.string().regex(/^[a-f0-9]{7,64}$/i).optional(),
  RELEASE_BUILT_AT: z.string().datetime().optional(),
  WORKER_ID: z.string().uuid().optional(),
  WORKER_RELEASE: z.string().min(1).max(128).optional(),
  WORKER_SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(1_000).max(300_000).optional(),
  WORKER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).optional(),
  WORKER_HEARTBEAT_STALE_SECONDS: z.coerce.number().int().min(15).max(3_600).optional(),
  WORKER_OUTBOX_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).optional(),
  WORKER_LEASE_RECOVERY_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3_600).optional(),
  WORKER_RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3_600).optional(),
  WORKER_WATCH_RENEWAL_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).optional(),
  WORKER_ORPHAN_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3_600).optional(),
  WORKER_OUTBOX_BATCH_LIMIT: z.coerce.number().int().min(1).max(100).optional(),
  WORKER_RECONCILIATION_BATCH_LIMIT: z.coerce.number().int().min(1).max(500).optional(),
  WORKER_ORPHAN_BATCH_LIMIT: z.coerce.number().int().min(1).max(500).optional(),
  SYNC_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).optional(),
  COMMAND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(25).optional()
}).superRefine((value, context) => {
  const appOrigin = new URL(value.APP_ORIGIN);
  const apiOrigin = new URL(value.API_ORIGIN);
  if (appOrigin.hostname !== apiOrigin.hostname) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["API_ORIGIN"], message: "APP_ORIGIN and API_ORIGIN must use the same hostname for secure session handling." });
  }
  if (appOrigin.username || appOrigin.password || apiOrigin.username || apiOrigin.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["APP_ORIGIN"], message: "Application origins must not contain credentials." });
  }
  if (appOrigin.pathname !== "/" || appOrigin.search || appOrigin.hash || apiOrigin.pathname !== "/" || apiOrigin.search || apiOrigin.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["APP_ORIGIN"], message: "Application origins must be origin-only URLs without paths, queries, or fragments." });
  }
  const encryptionKey = Buffer.from(value.TOKEN_ENCRYPTION_KEY_BASE64, "base64");
  if (encryptionKey.length !== 32) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["TOKEN_ENCRYPTION_KEY_BASE64"], message: "Encryption master key must decode to exactly 32 bytes." });
  }
  if (value.NODE_ENV === "production") {
    if (appOrigin.protocol !== "https:" || apiOrigin.protocol !== "https:") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["APP_ORIGIN"], message: "Production application origins must use HTTPS." });
    }
    if (!value.TRUST_PROXY) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["TRUST_PROXY"], message: "Production requires an explicitly trusted TLS-terminating proxy." });
    }
    if (value.RATE_LIMIT_FAILURE_MODE === "fail_open") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["RATE_LIMIT_FAILURE_MODE"], message: "Production rate limiting must fail closed." });
    }
    for (const field of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
      if (placeholderSecretPattern.test(value[field].trim())) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Production OAuth configuration must not use a placeholder value." });
      }
    }
  }
  if (value.GOOGLE_REDIRECT_URI !== `${apiOrigin.origin}/v1/auth/google/callback`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["GOOGLE_REDIRECT_URI"], message: "Google redirect URI must use the configured API origin and callback path." });
  }
  if (value.PUBSUB_PUSH_AUDIENCE !== `${apiOrigin.origin}/v1/webhooks/gmail`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["PUBSUB_PUSH_AUDIENCE"], message: "Pub/Sub audience must use the configured API webhook origin and path." });
  }
  if (value.GOOGLE_PUBSUB_TOPIC.split("/")[1] !== value.GOOGLE_CLOUD_PROJECT) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["GOOGLE_PUBSUB_TOPIC"], message: "Pub/Sub topic must belong to GOOGLE_CLOUD_PROJECT." });
  }
  if (value.WEBHOOK_BODY_LIMIT_BYTES > value.API_BODY_LIMIT_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["WEBHOOK_BODY_LIMIT_BYTES"], message: "Webhook body limit must not exceed the API body limit." });
  }
  if (value.WORKER_HEARTBEAT_STALE_SECONDS !== undefined && value.WORKER_HEARTBEAT_INTERVAL_SECONDS !== undefined && value.WORKER_HEARTBEAT_STALE_SECONDS <= value.WORKER_HEARTBEAT_INTERVAL_SECONDS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["WORKER_HEARTBEAT_STALE_SECONDS"], message: "WORKER_HEARTBEAT_STALE_SECONDS must exceed the heartbeat interval." });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
