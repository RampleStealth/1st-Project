import assert from "node:assert/strict";
import test from "node:test";
import { MigrationIntegrityError, migrateDatabase, migrationStatus, type Migration, type MigrationClient } from "@aio/database/migrations";

function client(records: Array<{ name: string; checksum: string | null }> = []) {
  const calls: string[] = [];
  const fake: MigrationClient = { query: (async (sql, values) => {
    calls.push(sql);
    if (sql.startsWith("SELECT name,checksum")) return { rows: records.map((record) => ({ ...record, applied_at: new Date() })), rowCount: records.length };
    if (sql.startsWith("INSERT INTO schema_migrations")) { records.push({ name: values![0] as string, checksum: values![1] as string }); }
    if (sql.startsWith("UPDATE schema_migrations") && values?.[0]) { const record = records.find((item) => item.name === values[0]); if (record && !record.checksum) record.checksum = values[1] as string; }
    return { rows: [], rowCount: 0 };
  }) as MigrationClient["query"] };
  return { fake, calls, records };
}
const manifest: Migration[] = [{ name: "001_example.sql", checksum: "a", sql: "SELECT 1" }, { name: "002_example.sql", checksum: "b", sql: "SELECT 2" }];

test("migration runner locks, orders, checksums, and records metadata atomically", async () => {
  const { fake, calls, records } = client();
  const status = await migrateDatabase(fake, manifest);
  assert.deepEqual(status.pending, []); assert.deepEqual(records, [{ name: "001_example.sql", checksum: "a" }, { name: "002_example.sql", checksum: "b" }]);
  assert.match(calls[0], /pg_advisory_lock/); assert.ok(calls.some((sql) => /pg_advisory_unlock/.test(sql)));
  assert.ok(calls.indexOf("BEGIN") < calls.indexOf("COMMIT"));
});

test("migration status rejects checksum mismatches without applying anything", async () => {
  const { fake, calls } = client([{ name: "001_example.sql", checksum: "tampered" }]);
  await assert.rejects(() => migrationStatus(fake, manifest), MigrationIntegrityError);
  assert.equal(calls.some((sql) => sql === "BEGIN"), false);
});
