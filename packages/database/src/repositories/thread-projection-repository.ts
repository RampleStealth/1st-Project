import type { PoolClient } from "pg";
import type { NormalizedMailboxAddress, ThreadListItem, ThreadProjectionInput, ThreadProjectionMessage } from "@aio/contracts";

function timestamp(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function orderedMessages(messages: ThreadProjectionMessage[]) {
  return [...messages].sort((left, right) => {
    if (left.internalTimestamp === null && right.internalTimestamp !== null) return -1;
    if (left.internalTimestamp !== null && right.internalTimestamp === null) return 1;
    const byTimestamp = (left.internalTimestamp ?? "").localeCompare(right.internalTimestamp ?? "");
    return byTimestamp || left.providerMessageId.localeCompare(right.providerMessageId);
  });
}

function labels(messages: ThreadProjectionMessage[]) {
  return [...new Set(messages.flatMap((message) => message.labels))].sort();
}

function addressLabel(mailbox: NormalizedMailboxAddress) {
  return mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address;
}

function addressSummary(addresses: NormalizedMailboxAddress[]) {
  return addresses.map(addressLabel).join(", ") || null;
}

function participantSummary(messages: ThreadProjectionMessage[]) {
  const participants = new Map<string, NormalizedMailboxAddress>();
  for (const mailbox of messages.flatMap((message) => [message.from, ...message.to, ...message.cc]).filter((value): value is NormalizedMailboxAddress => Boolean(value))) {
    const previous = participants.get(mailbox.address);
    if (!previous || !previous.displayName && mailbox.displayName) participants.set(mailbox.address, mailbox);
  }
  const ordered = [...participants.values()].sort((left, right) => left.address.localeCompare(right.address));
  const visible = ordered.slice(0, 5).map(addressLabel);
  return visible.length ? `${visible.join(", ")}${ordered.length > visible.length ? ` +${ordered.length - visible.length}` : ""}` : null;
}

export async function upsertThreadProjection(client: PoolClient, mailboxAccountId: string, providerThread: ThreadProjectionInput): Promise<ThreadListItem | null> {
  if (!providerThread.providerThreadId) return null;
  const messages = orderedMessages(providerThread.messages);
  const latest = messages.at(-1);
  const providerLabels = labels(messages);
  const latestTimestamp = timestamp(latest?.internalTimestamp ?? null);
  const latestSenderDisplay = latest?.from?.displayName ?? latest?.from?.address ?? null;
  const threadHasAttachments = messages.some((message) => message.hasAttachments);
  const thread = await client.query<ThreadListItem>(
    `WITH upsert AS (
       INSERT INTO threads(mailbox_account_id,provider_thread_id,subject_normalized,participant_summary,last_message_at,unread_count,provider_labels,latest_provider_message_id,latest_sender_display,latest_sender_address,latest_snippet,message_count,has_attachments,has_draft,last_provider_updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(mailbox_account_id,provider_thread_id) DO UPDATE SET
         subject_normalized=EXCLUDED.subject_normalized,participant_summary=EXCLUDED.participant_summary,last_message_at=EXCLUDED.last_message_at,unread_count=EXCLUDED.unread_count,provider_labels=EXCLUDED.provider_labels,latest_provider_message_id=EXCLUDED.latest_provider_message_id,latest_sender_display=EXCLUDED.latest_sender_display,latest_sender_address=EXCLUDED.latest_sender_address,latest_snippet=EXCLUDED.latest_snippet,message_count=EXCLUDED.message_count,has_attachments=EXCLUDED.has_attachments,has_draft=EXCLUDED.has_draft,last_provider_updated_at=EXCLUDED.last_provider_updated_at,sync_version=threads.sync_version+1,updated_at=now()
       WHERE (threads.subject_normalized,threads.participant_summary,threads.last_message_at,threads.unread_count,threads.provider_labels,threads.latest_provider_message_id,threads.latest_sender_display,threads.latest_sender_address,threads.latest_snippet,threads.message_count,threads.has_attachments,threads.has_draft,threads.last_provider_updated_at)
         IS DISTINCT FROM
         (EXCLUDED.subject_normalized,EXCLUDED.participant_summary,EXCLUDED.last_message_at,EXCLUDED.unread_count,EXCLUDED.provider_labels,EXCLUDED.latest_provider_message_id,EXCLUDED.latest_sender_display,EXCLUDED.latest_sender_address,EXCLUDED.latest_snippet,EXCLUDED.message_count,EXCLUDED.has_attachments,EXCLUDED.has_draft,EXCLUDED.last_provider_updated_at)
       RETURNING id,provider_thread_id,subject_normalized,latest_sender_display,latest_snippet,last_message_at,unread_count,message_count,has_attachments,has_draft,provider_labels
     )
     SELECT id,provider_thread_id AS "providerThreadId",subject_normalized AS subject,latest_sender_display AS "latestSender",latest_snippet AS preview,last_message_at AS "lastMessageAt",unread_count AS "unreadCount",message_count AS "messageCount",has_attachments AS "hasAttachments",has_draft AS "hasDraft",provider_labels AS labels FROM upsert
     UNION ALL
     SELECT id,provider_thread_id AS "providerThreadId",subject_normalized AS subject,latest_sender_display AS "latestSender",latest_snippet AS preview,last_message_at AS "lastMessageAt",unread_count AS "unreadCount",message_count AS "messageCount",has_attachments AS "hasAttachments",has_draft AS "hasDraft",provider_labels AS labels
     FROM threads WHERE mailbox_account_id=$1 AND provider_thread_id=$2 AND NOT EXISTS (SELECT 1 FROM upsert)`,
    [mailboxAccountId, providerThread.providerThreadId, latest?.subject ?? null, participantSummary(messages), latestTimestamp, messages.filter((message) => message.labels.includes("UNREAD")).length, providerLabels, latest?.providerMessageId ?? null, latestSenderDisplay, latest?.from?.address ?? null, latest?.snippet ?? null, messages.length, threadHasAttachments, providerLabels.includes("DRAFT"), latestTimestamp]
  );
  for (const message of messages) {
    await client.query(
      `INSERT INTO messages(thread_id,provider_message_id,internal_timestamp,sent_at,from_address,snippet,provider_labels,subject,to_address_summary,cc_address_summary,has_attachments,from_display_name,to_addresses,cc_addresses)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)
       ON CONFLICT(thread_id,provider_message_id) DO UPDATE SET
         internal_timestamp=EXCLUDED.internal_timestamp,from_address=EXCLUDED.from_address,from_display_name=EXCLUDED.from_display_name,
         provider_labels=EXCLUDED.provider_labels,subject=EXCLUDED.subject,to_address_summary=EXCLUDED.to_address_summary,cc_address_summary=EXCLUDED.cc_address_summary,
         to_addresses=EXCLUDED.to_addresses,cc_addresses=EXCLUDED.cc_addresses,has_attachments=EXCLUDED.has_attachments,snippet=EXCLUDED.snippet
       WHERE (messages.internal_timestamp,messages.from_address,messages.from_display_name,messages.provider_labels,messages.subject,messages.to_address_summary,messages.cc_address_summary,messages.to_addresses,messages.cc_addresses,messages.has_attachments,messages.snippet)
         IS DISTINCT FROM
         (EXCLUDED.internal_timestamp,EXCLUDED.from_address,EXCLUDED.from_display_name,EXCLUDED.provider_labels,EXCLUDED.subject,EXCLUDED.to_address_summary,EXCLUDED.cc_address_summary,EXCLUDED.to_addresses,EXCLUDED.cc_addresses,EXCLUDED.has_attachments,EXCLUDED.snippet)`,
      [thread.rows[0].id, message.providerMessageId, timestamp(message.internalTimestamp), null, message.from?.address ?? null, message.snippet, message.labels, message.subject, addressSummary(message.to), addressSummary(message.cc), message.hasAttachments, message.from?.displayName ?? null, JSON.stringify(message.to), JSON.stringify(message.cc)]
    );
  }
  return thread.rows[0];
}
