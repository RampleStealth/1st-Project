import { createHash } from "node:crypto";

export type RateLimitInput = {
  category: string;
  dimension: "ip" | "user" | "mailbox";
  identifier: string;
  limit: number;
  windowMs: number;
};

export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };
export type RateLimiter = { consume: (input: RateLimitInput) => Promise<RateLimitDecision> };

export const allowAllRateLimiter: RateLimiter = { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) };

type RedisScriptClient = { eval: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown> };

const fixedWindowScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if current > tonumber(ARGV[2]) then return {0, ttl} end
return {1, ttl}
`;

function keyFor(input: RateLimitInput) {
  const digest = createHash("sha256").update(`${input.category}:${input.dimension}:${input.identifier}`, "utf8").digest("base64url");
  return `aio:rate-limit:v1:${input.category}:${input.dimension}:${digest}`;
}

/** Redis-fixed-window limiter. Keys are opaque hashes and are never sent to callers or logs. */
export function createRedisRateLimiter(redis: RedisScriptClient, onFailure: "fail_closed" | "fail_open"): RateLimiter {
  return {
    async consume(input) {
      try {
        const result = await redis.eval(fixedWindowScript, 1, keyFor(input), input.windowMs, input.limit) as [number, number];
        const allowed = Array.isArray(result) && Number(result[0]) === 1;
        const ttl = Array.isArray(result) ? Math.max(0, Number(result[1])) : input.windowMs;
        return { allowed, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1_000)) };
      } catch {
        return onFailure === "fail_open" ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds: 1 };
      }
    }
  };
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async consume(input: RateLimitInput): Promise<RateLimitDecision> {
    const key = keyFor(input); const now = this.now(); const existing = this.buckets.get(key);
    const bucket = !existing || existing.expiresAt <= now ? { count: 0, expiresAt: now + input.windowMs } : existing;
    bucket.count += 1; this.buckets.set(key, bucket);
    return { allowed: bucket.count <= input.limit, retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1_000)) };
  }
}

export type RateLimitPolicy = { category: string; limit: number; windowMs: number; dimensions: Array<"ip" | "user" | "mailbox"> };

export function policyForRoute(method: string, route: string): RateLimitPolicy | null {
  if (route === "/v1/webhooks/gmail") return null; // authenticated Pub/Sub traffic is governed by Google delivery and idempotent history application.
  if (route === "/v1/auth/google/start" || route === "/v1/auth/google/callback" || route === "/v1/auth/google/write/callback") return { category: "oauth", limit: 20, windowMs: 60_000, dimensions: ["ip"] };
  if (route === "/diagnostics") return { category: "diagnostics", limit: 20, windowMs: 60_000, dimensions: ["ip"] };
  if (route === "/v1/mailboxes/:mailboxId/threads/:threadId" && method === "GET") return { category: "thread_read", limit: 120, windowMs: 60_000, dimensions: ["ip", "user", "mailbox"] };
  if (method === "GET" && route.startsWith("/v1/mailboxes")) return { category: "mailbox_read", limit: 240, windowMs: 60_000, dimensions: ["ip", "user", "mailbox"] };
  if (route.includes("/send-verification")) return { category: "verification", limit: 10, windowMs: 60_000, dimensions: ["ip", "user", "mailbox"] };
  if (route.includes("/drafts")) return { category: "draft_mutation", limit: 30, windowMs: 60_000, dimensions: ["ip", "user", "mailbox"] };
  if (route.includes("/threads/") && (route.endsWith("/archive") || route.endsWith("/mark-unread"))) return { category: "gmail_mutation", limit: 30, windowMs: 60_000, dimensions: ["ip", "user", "mailbox"] };
  if (method === "DELETE" || route.includes("/permissions/write/start") || route === "/v1/auth/logout") return { category: "sensitive_mutation", limit: 20, windowMs: 60_000, dimensions: ["ip", "user", "mailbox"] };
  return null;
}
