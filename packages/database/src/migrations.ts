import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Migration = { name: string; checksum: string; sql: string };
export type MigrationRecord = { name: string; checksum: string | null; applied_at: Date };
export type MigrationClient = { query: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }> };
const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationName = /^\d{3}_[a-z0-9_]+\.sql$/;
// Retired before checksum tracking. They are recognized solely to upgrade existing local/CI history;
// new installations never see them and every other unknown record remains an integrity failure.
const retiredLegacyMigrationNames = new Set(["003_reset_legacy_sync_watermarks.sql", "003_reset_untrusted_legacy_watermarks.sql"]);

export class MigrationIntegrityError extends Error {}

export async function loadMigrationManifest(directoryPath = directory): Promise<Migration[]> {
  const names = (await readdir(directoryPath)).filter((name) => name.endsWith(".sql")).sort();
  const seen = new Set<string>();
  for (const name of names) {
    if (!migrationName.test(name) || seen.has(name)) throw new MigrationIntegrityError(`Invalid or duplicate migration name: ${name}`);
    seen.add(name);
  }
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(directoryPath, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") };
  }));
}

async function ensureMetadata(client: MigrationClient) {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT NULL");
}

export async function migrationStatus(client: MigrationClient, manifest?: Migration[]) {
  manifest ??= await loadMigrationManifest();
  await ensureMetadata(client);
  const applied = await client.query<MigrationRecord>("SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name");
  const records = new Map(applied.rows.map((row) => [row.name, row]));
  const unknown = applied.rows.filter((row) => !retiredLegacyMigrationNames.has(row.name) && !manifest.some((migration) => migration.name === row.name));
  if (unknown.length) throw new MigrationIntegrityError(`Database contains unknown migration records: ${unknown.map((row) => row.name).join(", ")}`);
  const migrations = manifest.map((migration) => {
    const record = records.get(migration.name);
    return { name: migration.name, checksum: migration.checksum, applied: Boolean(record), checksumMatches: !record?.checksum || record.checksum === migration.checksum };
  });
  const mismatched = migrations.filter((migration) => migration.applied && !migration.checksumMatches);
  if (mismatched.length) throw new MigrationIntegrityError(`Migration checksum mismatch: ${mismatched.map((migration) => migration.name).join(", ")}`);
  return { migrations, current: migrations.filter((migration) => migration.applied).at(-1)?.name ?? null, pending: migrations.filter((migration) => !migration.applied).map((migration) => migration.name) };
}

/** Serializes migration ownership with a transaction-scoped PostgreSQL advisory lock. */
export async function migrateDatabase(client: MigrationClient, manifest?: Migration[]) {
  manifest ??= await loadMigrationManifest();
  await client.query("SELECT pg_advisory_lock(hashtext('aio-schema-migrations-v1'))");
  try {
    const status = await migrationStatus(client, manifest);
    for (const migration of manifest.filter((candidate) => status.pending.includes(candidate.name))) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)", [migration.name, migration.checksum]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
    // Legacy records predate checksums. Backfill only after every committed file has passed integrity checks.
    for (const migration of manifest) await client.query("UPDATE schema_migrations SET checksum=$2 WHERE name=$1 AND checksum IS NULL", [migration.name, migration.checksum]);
    return migrationStatus(client, manifest);
  } finally { await client.query("SELECT pg_advisory_unlock(hashtext('aio-schema-migrations-v1'))"); }
}

export async function verifySchemaCompatibility(client: MigrationClient) {
  const status = await migrationStatus(client);
  if (status.pending.length) throw new MigrationIntegrityError(`Database schema is behind this release: ${status.pending.join(", ")}`);
  return status.current;
}
