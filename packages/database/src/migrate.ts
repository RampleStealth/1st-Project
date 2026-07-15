import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./index.js";

import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".sql"))
  .sort();
await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
for (const name of files) {
  const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
  if (applied.rowCount) continue;
  const sql = await readFile(join(directory, name), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    await pool.query("COMMIT");
  } catch (error) { await pool.query("ROLLBACK"); throw error; }
}
await pool.end();
