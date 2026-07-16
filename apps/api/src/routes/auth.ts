import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@aio/config";
import type { Pool } from "pg";
import { authenticatedUser } from "../route-helpers/session.js";
import { cookieOptions, csrfCookieOptions, hash, requireCsrf } from "../route-helpers/security.js";
type AuthDependencies = { config: AppConfig; pool: Pool };
export function registerAuthRoutes(app: FastifyInstance<any, any, any, any>, { config, pool }: AuthDependencies) { app.post("/v1/auth/logout", async (request, reply) => { const user = await authenticatedUser(request, pool); if (!user) return reply.code(204).clearCookie("aio_session", cookieOptions(config)).clearCookie("aio_csrf", csrfCookieOptions(config)).send(); if (!requireCsrf(request)) return reply.code(403).send({ code: "csrf_failed", message: "Refresh the page and try again." }); const signed = request.unsignCookie(request.cookies.aio_session ?? ""); await pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [hash(signed.value!)]); return reply.code(204).clearCookie("aio_session", cookieOptions(config)).clearCookie("aio_csrf", csrfCookieOptions(config)).send(); }); }
