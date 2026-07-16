import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

async function main() {
  const runId = process.env.GMAIL_VALIDATION_RUN_ID ?? randomUUID();
  const environment = process.env.NODE_ENV ?? "development";
  const live = process.argv.includes("--confirm-isolated-test-account");
  const report = { runId, environment, releaseVersion: process.env.RELEASE_VERSION ?? "development", generatedAt: new Date().toISOString(), mode: live ? "blocked" : "dry-run", checks: ["oauth_read_only", "write_upgrade", "watch_and_sync", "mailbox_reads", "archive", "mark_unread", "draft_create", "draft_update", "draft_send", "recovery_verification"].map((name) => ({ name, result: live ? "blocked" : "not-run", reasonCode: live ? "live_harness_requires_operator_workflow" : "dry_run_no_provider_calls" })) };
  if (live) throw new Error("Live Gmail validation is intentionally not automated. Follow docs/operations/controlled-gmail-validation.md with an isolated account and record the report manually.");
  const output = process.env.GMAIL_VALIDATION_REPORT ?? `gmail-validation-${runId}.json`;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ runId, mode: report.mode, report: output, providerCalls: 0 }));
}
void main();
