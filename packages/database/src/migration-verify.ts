import { pool } from "./index.js";
import { verifySchemaCompatibility } from "./migrations.js";
try { console.log(JSON.stringify({ schema: await verifySchemaCompatibility(pool), compatible: true })); } finally { await pool.end(); }
