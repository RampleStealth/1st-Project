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
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMailboxLifecycleRoutes } from "./routes/mailbox-lifecycle.js";
import { registerProviderCommandRoutes } from "./routes/provider-commands.js";
import { registerMailboxWorkspaceRoutes } from "./routes/mailbox-workspace.js";
import { registerWritePermissionRoutes } from "./routes/permissions.js";
import { registerGoogleAuthRoutes } from "./routes/google-auth.js";
import { registerGmailWebhookRoutes } from "./routes/gmail-webhook.js";

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
registerGmailWebhookRoutes(app,{config,pool,pubsubVerifier,recordPendingHistory,enqueueSync});

app.listen({ host: "0.0.0.0", port: config.PORT }).catch((error) => { logger.fatal({ err: error }, "api startup failed"); process.exit(1); });
