import type { Pool, PoolClient } from "pg";
import { pool } from "../index.js";

export type WorkerHeartbeat = {
  workerId: string;
  serviceRole: "combined";
  release: string;
  status: "starting" | "running" | "draining" | "stopped";
  syncConsumerStatus: "starting" | "running" | "stopped";
  commandConsumerStatus: "starting" | "running" | "stopped";
  startedAt: Date;
  lastHeartbeatAt: Date;
  shuttingDownAt: Date | null;
  stoppedAt: Date | null;
};

type WorkerDatabase = Pick<Pool, "query"> | Pick<PoolClient, "query">;
const columns = `worker_id AS "workerId",service_role AS "serviceRole",release,status,sync_consumer_status AS "syncConsumerStatus",command_consumer_status AS "commandConsumerStatus",started_at AS "startedAt",last_heartbeat_at AS "lastHeartbeatAt",shutting_down_at AS "shuttingDownAt",stopped_at AS "stoppedAt"`;

export async function recordWorkerStarted(input: { workerId: string; release: string }, database: WorkerDatabase = pool): Promise<WorkerHeartbeat> {
  const result = await database.query<WorkerHeartbeat>(
    `INSERT INTO worker_heartbeats(worker_id,service_role,release,status,sync_consumer_status,command_consumer_status,started_at,last_heartbeat_at,metadata)
     VALUES($1,'combined',$2,'starting','starting','starting',now(),now(),'{}'::jsonb)
     ON CONFLICT(worker_id) DO UPDATE SET release=EXCLUDED.release,status='starting',sync_consumer_status='starting',command_consumer_status='starting',started_at=now(),last_heartbeat_at=now(),shutting_down_at=NULL,stopped_at=NULL,metadata='{}'::jsonb
     RETURNING ${columns}`,
    [input.workerId, input.release]
  );
  return result.rows[0];
}

export async function recordWorkerHeartbeat(input: { workerId: string; syncRunning: boolean; commandRunning: boolean }, database: WorkerDatabase = pool): Promise<boolean> {
  const result = await database.query(
    `UPDATE worker_heartbeats
     SET status=CASE WHEN $2::boolean AND $3::boolean THEN 'running' ELSE status END,
         sync_consumer_status=CASE WHEN $2::boolean THEN 'running' ELSE 'stopped' END,
         command_consumer_status=CASE WHEN $3::boolean THEN 'running' ELSE 'stopped' END,
         last_heartbeat_at=now()
     WHERE worker_id=$1 AND status IN ('starting','running')`,
    [input.workerId, input.syncRunning, input.commandRunning]
  );
  return result.rowCount === 1;
}

export async function markWorkerDraining(workerId: string, database: WorkerDatabase = pool): Promise<boolean> {
  const result = await database.query(
    "UPDATE worker_heartbeats SET status='draining',shutting_down_at=COALESCE(shutting_down_at,now()),last_heartbeat_at=now() WHERE worker_id=$1 AND status IN ('starting','running','draining')",
    [workerId]
  );
  return result.rowCount === 1;
}

export async function markWorkerStopped(workerId: string, database: WorkerDatabase = pool): Promise<boolean> {
  const result = await database.query(
    "UPDATE worker_heartbeats SET status='stopped',sync_consumer_status='stopped',command_consumer_status='stopped',stopped_at=COALESCE(stopped_at,now()),last_heartbeat_at=now() WHERE worker_id=$1 AND status <> 'stopped'",
    [workerId]
  );
  return result.rowCount === 1;
}

export async function findStaleWorkerHeartbeats(staleSeconds: number, database: WorkerDatabase = pool): Promise<WorkerHeartbeat[]> {
  const result = await database.query<WorkerHeartbeat>(
    `SELECT ${columns} FROM worker_heartbeats
     WHERE status IN ('starting','running','draining')
       AND last_heartbeat_at < now() - ($1::text || ' seconds')::interval
     ORDER BY last_heartbeat_at ASC`,
    [staleSeconds]
  );
  return result.rows;
}

export type WorkerDatabaseDiagnostics = {
  unpublishedOutboxCount: number;
  oldestUnpublishedOutboxAgeMs: number | null;
  dueReconciliationCount: number;
  staleRunningCommandCount: number;
  recoveryRequiredCommandCount: number;
};

export async function getWorkerDatabaseDiagnostics(database: WorkerDatabase = pool): Promise<WorkerDatabaseDiagnostics> {
  const result = await database.query<{
    unpublished_outbox_count: string;
    oldest_unpublished_outbox_age_ms: string | null;
    due_reconciliation_count: string;
    stale_running_command_count: string;
    recovery_required_command_count: string;
  }>(`SELECT
      (SELECT count(*) FROM outbox_events WHERE published_at IS NULL) AS unpublished_outbox_count,
      (SELECT floor(extract(epoch FROM now() - min(created_at)) * 1000)::bigint FROM outbox_events WHERE published_at IS NULL) AS oldest_unpublished_outbox_age_ms,
      (SELECT count(*) FROM mailbox_sync_state state JOIN mailbox_accounts account ON account.id=state.mailbox_account_id WHERE account.status='active' AND state.reconciliation_due_at <= now()) AS due_reconciliation_count,
      (SELECT count(*) FROM provider_commands WHERE status='running' AND lease_expires_at < now()) AS stale_running_command_count,
      (SELECT count(*) FROM provider_commands WHERE status='recovery_required') AS recovery_required_command_count`);
  const row = result.rows[0];
  return {
    unpublishedOutboxCount: Number(row.unpublished_outbox_count),
    oldestUnpublishedOutboxAgeMs: row.oldest_unpublished_outbox_age_ms === null ? null : Number(row.oldest_unpublished_outbox_age_ms),
    dueReconciliationCount: Number(row.due_reconciliation_count),
    staleRunningCommandCount: Number(row.stale_running_command_count),
    recoveryRequiredCommandCount: Number(row.recovery_required_command_count)
  };
}

/** Conservatively surface impossible active draft states without inferring provider success or retrying Gmail. */
export async function repairInconsistentDraftStates(limit = 100, database: WorkerDatabase = pool): Promise<string[]> {
  const result = await database.query<{ id: string }>(
    `WITH candidates AS (
       SELECT d.id FROM drafts d
       WHERE d.status IN ('creating','updating','sending')
         AND NOT EXISTS (
           SELECT 1 FROM provider_commands c
           WHERE c.id=d.last_command_id
             AND c.command_type=CASE d.status WHEN 'creating' THEN 'create_draft' WHEN 'updating' THEN 'update_draft' ELSE 'send_draft' END
             AND c.status IN ('pending','running','retryable','recovery_required')
         )
       ORDER BY d.updated_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ), repaired AS (
       UPDATE drafts d SET status='recovery_required',provider_checked_at=now(),updated_at=now()
       FROM candidates c WHERE d.id=c.id RETURNING d.id
     )
     INSERT INTO audit_events(actor_type,event_type,object_type,object_id,correlation_id,metadata)
     SELECT 'system','draft.runtime_inconsistency_repaired','draft',id,gen_random_uuid(),'{}'::jsonb FROM repaired
     RETURNING object_id AS id`,
    [limit]
  );
  return result.rows.map((row) => row.id);
}
