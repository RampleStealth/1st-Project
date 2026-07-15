import type { FastifyInstance } from "fastify";
import type { OAuth2Client } from "google-auth-library";
import type { Pool } from "pg";
import type { AppConfig } from "@aio/config";
import type { SyncJob } from "@aio/contracts";
import { gmailNotificationSchema } from "@aio/contracts";
import { correlationId } from "../route-helpers/security.js";

type Deps = {
  config: AppConfig;
  pool: Pool;
  pubsubVerifier: OAuth2Client;
  recordPendingHistory: (mailboxAccountId: string, historyId: string) => Promise<void>;
  enqueueSync: (job: SyncJob) => Promise<unknown>;
};

export function registerGmailWebhookRoutes(
  app: FastifyInstance<any, any, any, any>,
  { config, pool, pubsubVerifier, recordPendingHistory, enqueueSync }: Deps
) {
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
}
