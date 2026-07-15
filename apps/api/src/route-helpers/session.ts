import type { FastifyRequest } from "fastify";
import { hash } from "./security.js";
type SessionDatabase = { query<T>(text: string, values: unknown[]): Promise<{ rows: T[] }> };
export async function authenticatedUser(request: FastifyRequest, db: SessionDatabase) { const signed = request.unsignCookie(request.cookies.aio_session ?? ""); if (!signed.valid || !signed.value) return null; const result = await db.query<{ id: string }>("SELECT user_id AS id FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()", [hash(signed.value)]); return result.rows[0] ?? null; }
