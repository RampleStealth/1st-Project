import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authenticatedUser } from "../route-helpers/session.js";
type Deps={pool:Pool};
export function registerMailboxWorkspaceRoutes(app:FastifyInstance<any,any,any,any>,{pool}:Deps){app.get("/v1/mailboxes",async(request,reply)=>{const user=await authenticatedUser(request,pool);if(!user)return reply.code(401).send({code:"unauthenticated",message:"Sign in to manage your connection."});const result=await pool.query("SELECT m.id,m.email_address,m.status,m.last_synced_at,m.last_sync_error,m.watch_expires_at,m.created_at,COALESCE(p.write_capability,'read_only') AS write_capability FROM mailbox_accounts m LEFT JOIN mailbox_permission_state p ON p.mailbox_account_id=m.id WHERE m.user_id=$1 AND m.status <> 'disconnected' ORDER BY m.created_at DESC",[user.id]);return result.rows;});}
