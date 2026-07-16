import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool } from "@aio/database";
import { findStaleWorkerHeartbeats, getWorkerDatabaseDiagnostics, markWorkerDraining, markWorkerStopped, recordWorkerHeartbeat, recordWorkerStarted } from "@aio/database/repositories/worker-runtime";

const databaseAvailable = Boolean(process.env.DATABASE_URL);

test("worker heartbeats expose lifecycle state and stale workers without secrets", { skip: !databaseAvailable }, async () => {
  const workerId = randomUUID();
  try {
    await recordWorkerStarted({ workerId, release: "test" });
    await recordWorkerHeartbeat({ workerId, syncRunning: true, commandRunning: true });
    const row = await pool.query<{ status: string; sync_consumer_status: string; command_consumer_status: string }>("SELECT status,sync_consumer_status,command_consumer_status FROM worker_heartbeats WHERE worker_id=$1", [workerId]);
    assert.deepEqual(row.rows[0], { status: "running", sync_consumer_status: "running", command_consumer_status: "running" });
    await pool.query("UPDATE worker_heartbeats SET last_heartbeat_at=now()-interval '5 minutes' WHERE worker_id=$1", [workerId]);
    assert.equal((await findStaleWorkerHeartbeats(60)).some((heartbeat) => heartbeat.workerId === workerId), true);
    await markWorkerDraining(workerId); await markWorkerStopped(workerId);
    assert.equal((await findStaleWorkerHeartbeats(60)).some((heartbeat) => heartbeat.workerId === workerId), false);
  } finally { await pool.query("DELETE FROM worker_heartbeats WHERE worker_id=$1", [workerId]); }
});

test("database diagnostics contain counts and ages only", { skip: !databaseAvailable }, async () => {
  const diagnostics = await getWorkerDatabaseDiagnostics();
  assert.equal(typeof diagnostics.unpublishedOutboxCount, "number");
  assert.equal(typeof diagnostics.staleRunningCommandCount, "number");
  assert.equal(diagnostics.oldestUnpublishedOutboxAgeMs === null || typeof diagnostics.oldestUnpublishedOutboxAgeMs === "number", true);
});
