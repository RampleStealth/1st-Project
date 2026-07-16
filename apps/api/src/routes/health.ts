import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@aio/config";

type Deps = { config: AppConfig; pool: { query: (text: string) => Promise<unknown> }; redis: { ping: () => Promise<unknown> } };

function matchesOperationalToken(actual: unknown, expected: string) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Public liveness is intentionally dependency-free; readiness and diagnostics are separate. */
export function registerHealthRoutes(app: FastifyInstance<any, any, any, any>, { config, pool, redis }: Deps) {
  const release = { version: config.RELEASE_VERSION ?? "development", commit: config.RELEASE_COMMIT_SHA ?? null, builtAt: config.RELEASE_BUILT_AT ?? null, role: "api", environment: config.NODE_ENV };
  app.get("/health", async () => ({ status: "ok", release }));
  app.get("/livez", async () => ({ status: "ok", release }));
  app.get("/readyz", async (_request, reply) => {
    try { await Promise.all([pool.query("SELECT 1"), redis.ping()]); return { status: "ready" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });
  // No diagnostics route exists unless it is explicitly protected by an operational secret.
  if (config.DIAGNOSTICS_TOKEN) {
    app.get("/diagnostics", async (request, reply) => {
      if (!matchesOperationalToken(request.headers["x-operational-token"], config.DIAGNOSTICS_TOKEN!)) return reply.code(404).send();
      try { await Promise.all([pool.query("SELECT 1"), redis.ping()]); return { status: "healthy" }; }
      catch { return reply.code(503).send({ status: "unavailable" }); }
    });
  }
}
