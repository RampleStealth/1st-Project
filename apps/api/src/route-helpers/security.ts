import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "@aio/config";

export function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function challenge(verifier: string) { return createHash("sha256").update(verifier).digest("base64url"); }
export function cookieOptions(config: AppConfig) { return { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax" as const, path: "/", signed: true }; }
export function correlationId(request: FastifyRequest) { return String(request.headers["x-correlation-id"]); }
export function requireCsrf(request: FastifyRequest) { const expected = request.cookies.aio_csrf; const actual = request.headers["x-csrf-token"]; return Boolean(expected && typeof actual === "string" && expected === actual); }
