import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ORIGIN: z.string().url(),
  API_ORIGIN: z.string().url(),
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
  SESSION_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
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
  if (new URL(value.APP_ORIGIN).hostname !== new URL(value.API_ORIGIN).hostname) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["API_ORIGIN"], message: "APP_ORIGIN and API_ORIGIN must use the same hostname for secure session handling." });
  }
  if (value.WORKER_HEARTBEAT_STALE_SECONDS !== undefined && value.WORKER_HEARTBEAT_INTERVAL_SECONDS !== undefined && value.WORKER_HEARTBEAT_STALE_SECONDS <= value.WORKER_HEARTBEAT_INTERVAL_SECONDS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["WORKER_HEARTBEAT_STALE_SECONDS"], message: "WORKER_HEARTBEAT_STALE_SECONDS must exceed the heartbeat interval." });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
