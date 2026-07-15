import { describe, expect, it } from "vitest";
import { connectionHealth, type MailboxSummary } from "./mailbox-health";

const mailbox: MailboxSummary = { id: "mailbox", email_address: "person@example.com", status: "active", last_synced_at: "2026-07-15T12:00:00.000Z", last_sync_error: null, watch_expires_at: null };

describe("connectionHealth", () => {
  it("reports a successful connection", () => {
    expect(connectionHealth(mailbox).tone).toBe("healthy");
  });

  it("prioritizes reauthorization over stale synchronization details", () => {
    expect(connectionHealth({ ...mailbox, status: "reauthorization_required", last_sync_error: "transient_provider_failure" })).toMatchObject({ tone: "attention", title: "Gmail needs reconnecting" });
  });

  it("explains a first synchronization", () => {
    expect(connectionHealth({ ...mailbox, last_synced_at: null })).toMatchObject({ tone: "recovering", title: "Syncing your mailbox" });
  });
});
