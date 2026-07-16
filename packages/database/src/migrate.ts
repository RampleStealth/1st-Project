import { pool } from "./index.js";
import { migrateDatabase } from "./migrations.js";
try { await migrateDatabase(pool); } finally { await pool.end(); }
