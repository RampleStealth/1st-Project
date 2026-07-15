import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { OAuth2Client } from "google-auth-library";
import { loadConfig } from "@aio/config";
import { pool, withTransaction } from "@aio/database";
import { recordPendingHistory } from "@aio/database/repositories/mailbox-sync";
import { SanitizedThreadCache } from "@aio/gmail";
import { enqueueSync } from "@aio/jobs";
import { logger } from "@aio/observability";
import { gmailNotificationSchema } from "@aio/contracts";
import { correlationId } from "./route-helpers/security.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMailboxLifecycleRoutes } from "./routes/mailbox-lifecycle.js";
import { registerProviderCommandRoutes } from "./routes/provider-commands.js";
import { registerMailboxWorkspaceRoutes } from "./routes/mailbox-workspace.js";
import { registerWritePermissionRoutes } from "./routes/permissions.js";
import { registerGoogleAuthRoutes } from "./routes/google-auth.js";

const config = loadConfig();
const redis = new Redis(config.REDIS_URL);
const app = Fastify({ loggerInstance: logger, trustProxy: config.NODE_ENV === "production" });
const sanitizedThreadCache = new SanitizedThreadCache();
const pubsubVerifier = new OAuth2Client();
await app.register(cookie, { secret: config.SESSION_SECRET, hook: "onRequest" });
await app.register(cors, { origin: config.APP_ORIGIN, credentials: true, methods: ["GET", "POST", "DELETE"] });


app.addHook("onRequest", async (request) => { request.headers["x-correlation-id"] ??= randomUUID(); });
registerHealthRoutes(app);

registerMailboxWorkspaceRoutes(app,{config,pool,withTransaction,sanitizedThreadCache});
registerProviderCommandRoutes(app,{pool});
registerWritePermissionRoutes(app,{config,pool,redis,withTransaction});

registerMailboxLifecycleRoutes(app,{config,pool,withTransaction});

registerAuthRoutes(app, { config, pool });
registerGoogleAuthRoutes(app,{config,pool,redis,withTransaction});

app.post("/v1/webhooks/gmail", async (request, reply) => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return reply.code(401).send();
  try {
    const ticket = await pubsubVerifier.verifyIdToken({ idToken: authorization.slice(7), audience: config.PUBSUB_PUSH_AUDIENCE });
    const claims = ticket.getPayload();
    if (!claims?.email_verified || claims.email !== config.PUBSUB_SERVICE_ACCOUNT_EMAIL) return reply.code(401).send();
    const body = request.body as { message?: { data?: string } };
    if (!body.message?.data) return reply.code(400).send();
    const notification = gmailNotificationSchema.parse(JSON.parse(Buffer.from(body.message.data, "base64url").toString("utf8")));
    const account = await pool.query<{ id: string }>("SELECT id FROM mailbox_accounts WHERE lower(email_address)=lower($1) AND status='active'", [notification.emailAddress]);
    if (account.rowCount) {
      await recordPendingHistory(account.rows[0].id, notification.historyId);
      await enqueueSync({ mailboxAccountId: account.rows[0].id, requestedHistoryId: notification.historyId, reason: "notification" });
    }
    return reply.code(204).send();
  } catch { request.log.warn({ correlationId: correlationId(request) }, "rejected gmail notification"); return reply.code(401).send(); }
});

app.listen({ host: "0.0.0.0", port: config.PORT }).catch((error) => { logger.fatal({ err: error }, "api startup failed"); process.exit(1); });
