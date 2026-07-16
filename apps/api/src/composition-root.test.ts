import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@aio/config";
import type { Pool, PoolClient } from "pg";
import { logger } from "@aio/observability";
import { createApiApp, type ApiAppDependencies } from "./app.js";
import { startApi, stopApi, type BootstrapDependencies } from "./bootstrap.js";
import { createProductionApiDependencies, type ProductionDependencyFactories } from "./dependencies.js";

const config: AppConfig = {
  NODE_ENV: "test",
  APP_ORIGIN: "http://app.example.test",
  API_ORIGIN: "http://app.example.test",
  DATABASE_URL: "postgres://user:password@localhost:5432/aio",
  REDIS_URL: "redis://localhost:6379",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REDIRECT_URI: "http://app.example.test/v1/auth/google/callback",
  GOOGLE_PUBSUB_TOPIC: "projects/project/topics/topic",
  GOOGLE_CLOUD_PROJECT: "project",
  PUBSUB_PUSH_AUDIENCE: "http://app.example.test/webhooks/gmail",
  PUBSUB_SERVICE_ACCOUNT_EMAIL: "push@example.test",
  GMAIL_INITIAL_SYNC_LIMIT: 500,
  SYNC_RECONCILIATION_INTERVAL_MINUTES: 30,
  TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  SESSION_SECRET: "a".repeat(32),
  PORT: 4000,
  WEB_PORT: 3000
};

function makeApiDependencies(events: string[] = []): ApiAppDependencies {
  const client = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
  const redis = {
    set: async () => "OK",
    getdel: async () => null,
    quit: async () => { events.push("redis.close"); return "OK"; }
  } as unknown as ApiAppDependencies["redis"];
  return {
    config,
    logger,
    pool: client as unknown as Pool,
    redis,
    pubsubVerifier: {} as ApiAppDependencies["pubsubVerifier"],
    sanitizedThreadCache: { key: () => "", get: () => undefined, set: () => undefined } as unknown as ApiAppDependencies["sanitizedThreadCache"],
    withTransaction: async (fn) => fn(client),
    findMailboxForUser: async () => null,
    ensureMailboxSyncState: async () => undefined,
    recordPendingHistory: async () => undefined,
    enqueueSync: async () => undefined,
    insertProviderCommand: async () => ({ id: "command", commandType: "archive_thread", status: "pending" }),
    isIdempotencyConflictError: () => false
  };
}

function makeFactories(events: string[], dependencies: ApiAppDependencies): ProductionDependencyFactories {
  return {
    createRedis: (url) => { events.push(`redis:${url}`); return dependencies.redis; },
    createPubsubVerifier: () => { events.push("verifier"); return dependencies.pubsubVerifier; },
    createSanitizedThreadCache: () => { events.push("cache"); return dependencies.sanitizedThreadCache; },
    logger: dependencies.logger,
    pool: dependencies.pool,
    withTransaction: dependencies.withTransaction,
    findMailboxForUser: dependencies.findMailboxForUser,
    ensureMailboxSyncState: dependencies.ensureMailboxSyncState,
    recordPendingHistory: dependencies.recordPendingHistory,
    enqueueSync: dependencies.enqueueSync,
    insertProviderCommand: dependencies.insertProviderCommand,
    isIdempotencyConflictError: dependencies.isIdempotencyConflictError
  };
}

test("composition modules import without listeners, configuration loading, or client construction", async () => {
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await Promise.all([import("./app.js"), import("./dependencies.js"), import("./bootstrap.js")]);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  const appSource = await readFile(new URL("./app.ts", import.meta.url), "utf8");
  assert.doesNotMatch(appSource, /loadConfig|new Redis|new Queue|\.listen\(|process\.once/);
});

test("application factory imports without startup side effects and registers the API surface", async () => {
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const app = await createApiApp(makeApiDependencies());
  assert.equal(app.server.listening, false);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);

  for (const [method, url] of [
    ["GET", "/health"],
    ["POST", "/v1/auth/logout"],
    ["POST", "/v1/auth/google/start"],
    ["GET", "/v1/auth/google/callback"],
    ["POST", "/v1/mailboxes/:mailboxId/permissions/write/start"],
    ["GET", "/v1/auth/google/write/callback"],
    ["POST", "/v1/webhooks/gmail"],
    ["GET", "/v1/mailboxes"],
    ["GET", "/v1/mailboxes/:mailboxId/threads"],
    ["GET", "/v1/mailboxes/:mailboxId/threads/:threadId"],
    ["DELETE", "/v1/mailboxes/:mailboxId"],
    ["GET", "/v1/mailboxes/:mailboxId/provider-commands/:commandId"]
  ] as const) assert.equal(app.hasRoute({ method, url }), true, `${method} ${url}`);

  app.get("/__composition-hook", async (request) => ({ correlationId: request.headers["x-correlation-id"] }));
  const health = await app.inject({ method: "GET", url: "/health" });
  const logout = await app.inject({ method: "POST", url: "/v1/auth/logout" });
  const cors = await app.inject({ method: "OPTIONS", url: "/health", headers: { origin: config.APP_ORIGIN, "access-control-request-method": "GET" } });
  const hook = await app.inject({ method: "GET", url: "/__composition-hook" });
  assert.deepEqual(health.json(), { status: "ok" });
  assert.equal(logout.statusCode, 204);
  assert.equal(cors.statusCode, 204);
  assert.match(hook.json().correlationId, /^[0-9a-f-]{36}$/i);
  await app.close();
});

test("production dependencies remain import-safe, construct through injected factories, and clean Redis after partial failure", async () => {
  const events: string[] = [];
  const dependencies = makeApiDependencies(events);
  const constructed = await createProductionApiDependencies(config, async () => { events.push("load"); return makeFactories(events, dependencies); });
  assert.deepEqual(events, ["load", `redis:${config.REDIS_URL}`, "verifier", "cache"]);
  assert.equal(constructed.redis, dependencies.redis);
  assert.equal(constructed.pool, dependencies.pool);
  assert.equal(constructed.enqueueSync, dependencies.enqueueSync);
  const app = await createApiApp(constructed);
  await app.close();

  const failedEvents: string[] = [];
  const failing = makeFactories(failedEvents, makeApiDependencies(failedEvents));
  failing.createPubsubVerifier = () => { throw new Error("verifier failed"); };
  await assert.rejects(() => createProductionApiDependencies(config, async () => failing), /verifier failed/);
  assert.deepEqual(failedEvents, [`redis:${config.REDIS_URL}`, "redis.close"]);
});

function makeBootstrapProcess(events: string[], handlers: Map<string, () => void>, exitThrows = false): BootstrapDependencies["process"] {
  return {
    once: (signal: string, handler: () => void) => { events.push(`signal:${signal}`); handlers.set(signal, handler); return process; },
    exit: (code?: number) => { events.push(`exit:${code}`); if (exitThrows) throw new Error(`exit:${code}`); return undefined as never; }
  } as unknown as BootstrapDependencies["process"];
}

function fakeFastify(events: string[], listenFailure?: Error): FastifyInstance {
  return {
    listen: async () => { events.push("listen"); if (listenFailure) throw listenFailure; },
    close: async () => { events.push("app.close"); }
  } as unknown as FastifyInstance;
}

test("bootstrap starts in order, installs signals only after listening, and stops owned resources once", async () => {
  const events: string[] = [];
  const handlers = new Map<string, () => void>();
  const dependencies = makeApiDependencies(events);
  const runtime = await startApi({
    loadEnvironment: () => { events.push("environment"); },
    loadConfig: () => { events.push("config"); return config; },
    createProductionApiDependencies: (async () => { events.push("dependencies"); return dependencies; }) as BootstrapDependencies["createProductionApiDependencies"],
    createApiApp: (async () => { events.push("app"); return fakeFastify(events); }) as BootstrapDependencies["createApiApp"],
    process: makeBootstrapProcess(events, handlers)
  });
  assert.deepEqual(events, ["environment", "config", "dependencies", "app", "listen", "signal:SIGINT", "signal:SIGTERM"]);
  await Promise.all([stopApi(runtime), stopApi(runtime)]);
  assert.deepEqual(events.slice(-2), ["app.close", "redis.close"]);
  assert.equal(events.filter((event) => event === "app.close").length, 1);
  assert.equal(events.filter((event) => event === "redis.close").length, 1);
});

test("bootstrap cleans started resources after listen failure and signals perform graceful shutdown", async () => {
  const failureEvents: string[] = [];
  const failureHandlers = new Map<string, () => void>();
  const failureDependencies = makeApiDependencies(failureEvents);
  failureDependencies.logger = { fatal: () => { failureEvents.push("fatal"); }, error: () => { failureEvents.push("error"); } } as unknown as ApiAppDependencies["logger"];
  await assert.rejects(() => startApi({
    loadEnvironment: () => { failureEvents.push("environment"); },
    loadConfig: () => { failureEvents.push("config"); return config; },
    createProductionApiDependencies: (async () => { failureEvents.push("dependencies"); return failureDependencies; }) as BootstrapDependencies["createProductionApiDependencies"],
    createApiApp: (async () => { failureEvents.push("app"); return fakeFastify(failureEvents, new Error("listen failed")); }) as BootstrapDependencies["createApiApp"],
    process: makeBootstrapProcess(failureEvents, failureHandlers)
  }), /listen failed/);
  assert.deepEqual(failureEvents, ["environment", "config", "dependencies", "app", "listen", "fatal", "app.close", "redis.close", "exit:1"]);

  const constructionEvents: string[] = [];
  const constructionDependencies = makeApiDependencies(constructionEvents);
  constructionDependencies.logger = { fatal: () => { constructionEvents.push("fatal"); }, error: () => undefined } as unknown as ApiAppDependencies["logger"];
  await assert.rejects(() => startApi({
    loadEnvironment: () => undefined,
    loadConfig: () => config,
    createProductionApiDependencies: (async () => constructionDependencies) as BootstrapDependencies["createProductionApiDependencies"],
    createApiApp: (async () => { throw new Error("app failed"); }) as BootstrapDependencies["createApiApp"],
    process: makeBootstrapProcess(constructionEvents, new Map())
  }), /app failed/);
  assert.deepEqual(constructionEvents, ["fatal", "redis.close", "exit:1"]);

  const signalEvents: string[] = [];
  const signalHandlers = new Map<string, () => void>();
  const signalRuntime = await startApi({
    loadEnvironment: () => undefined,
    loadConfig: () => config,
    createProductionApiDependencies: (async () => makeApiDependencies(signalEvents)) as BootstrapDependencies["createProductionApiDependencies"],
    createApiApp: (async () => fakeFastify(signalEvents)) as BootstrapDependencies["createApiApp"],
    process: makeBootstrapProcess(signalEvents, signalHandlers)
  });
  signalHandlers.get("SIGINT")?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  signalHandlers.get("SIGTERM")?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(signalEvents, ["listen", "signal:SIGINT", "signal:SIGTERM", "app.close", "redis.close", "exit:0", "exit:0"]);
  await stopApi(signalRuntime);
});

test("server remains the only production executable that starts the API", async () => {
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  assert.match(source, /await startApi\(\);/);
});
