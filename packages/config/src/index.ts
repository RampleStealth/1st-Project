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
  TOKEN_ENCRYPTION_KEY_BASE64: z.string().min(43),
  SESSION_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_PORT: z.coerce.number().int().positive().default(3000)
}).superRefine((value, context) => {
  if (new URL(value.APP_ORIGIN).hostname !== new URL(value.API_ORIGIN).hostname) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["API_ORIGIN"], message: "APP_ORIGIN and API_ORIGIN must use the same hostname for secure session handling." });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
