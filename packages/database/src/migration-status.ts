import { pool } from "./index.js";
import { migrationStatus } from "./migrations.js";
try { const status = await migrationStatus(pool); console.log(JSON.stringify({ current: status.current, pending: status.pending, migrations: status.migrations.map(({ name, applied, checksumMatches }) => ({ name, applied, checksumMatches })) })); } finally { await pool.end(); }
