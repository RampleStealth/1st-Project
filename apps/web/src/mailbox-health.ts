export type MailboxSummary = {
  id: string;
  email_address: string;
  status: "active" | "reauthorization_required" | "disconnected" | "sync_failed";
  last_synced_at: string | null;
  last_sync_error: string | null;
  watch_expires_at: string | null;
  write_capability?: "read_only" | "upgrade_pending" | "write_granted" | "upgrade_declined" | "upgrade_failed";
};

export type ConnectionHealth = {
  tone: "healthy" | "attention" | "recovering";
  title: string;
  detail: string;
};

export function connectionHealth(mailbox: MailboxSummary): ConnectionHealth {
  if (mailbox.status === "reauthorization_required") return { tone: "attention", title: "Gmail needs reconnecting", detail: "Your mailbox remains visible, but updates are paused until you reconnect." };
  if (mailbox.status === "sync_failed") return { tone: "attention", title: "Mailbox sync needs attention", detail: "We could not complete the latest synchronization." };
  if (mailbox.last_sync_error === "sync_baseline_required") return { tone: "recovering", title: "Preparing your mailbox", detail: "Gmail is establishing a fresh synchronization baseline." };
  if (mailbox.last_sync_error) return { tone: "recovering", title: "Gmail is recovering", detail: "Your latest mailbox data may take a moment to appear." };
  if (!mailbox.last_synced_at) return { tone: "recovering", title: "Syncing your mailbox", detail: "Your connection is active and the first sync is still running." };
  return { tone: "healthy", title: "Gmail is connected", detail: `Last synchronized ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(mailbox.last_synced_at))}.` };
}
