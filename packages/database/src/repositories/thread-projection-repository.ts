import type { PoolClient } from "pg";
import type { ThreadListItem } from "@aio/contracts";

type ProviderHeader = { name?: string | null; value?: string | null };
type ProviderMessage = { id?: string | null; internalDate?: string | null; labelIds?: string[] | null; snippet?: string | null; payload?: { headers?: ProviderHeader[] | null } | null };
export type ProviderThreadMetadata = { id?: string | null; messages?: ProviderMessage[] | null };

function header(message: ProviderMessage | undefined, name: string) {
  return message?.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function timestamp(value: string | null | undefined) {
  return value ? new Date(Number(value)) : null;
}

function labels(messages: ProviderMessage[]) {
  return [...new Set(messages.flatMap((message) => message.labelIds ?? []))];
}

export async function upsertThreadProjection(client: PoolClient, mailboxAccountId: string, providerThread: ProviderThreadMetadata): Promise<ThreadListItem | null> {
  if (!providerThread.id) return null;
  const messages = providerThread.messages ?? [];
  const latest = messages.at(-1);
  const providerLabels = labels(messages);
  const latestSender = header(latest, "From");
  const thread = await client.query<ThreadListItem>(
    `WITH upsert AS (
       INSERT INTO threads(mailbox_account_id,provider_thread_id,subject_normalized,participant_summary,last_message_at,unread_count,provider_labels,latest_provider_message_id,latest_sender_display,latest_sender_address,latest_snippet,message_count,has_draft,last_provider_updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT(mailbox_account_id,provider_thread_id) DO UPDATE SET
       subject_normalized=EXCLUDED.subject_normalized,participant_summary=EXCLUDED.participant_summary,last_message_at=EXCLUDED.last_message_at,unread_count=EXCLUDED.unread_count,provider_labels=EXCLUDED.provider_labels,latest_provider_message_id=EXCLUDED.latest_provider_message_id,latest_sender_display=EXCLUDED.latest_sender_display,latest_sender_address=EXCLUDED.latest_sender_address,latest_snippet=EXCLUDED.latest_snippet,message_count=EXCLUDED.message_count,has_draft=EXCLUDED.has_draft,last_provider_updated_at=EXCLUDED.last_provider_updated_at,sync_version=threads.sync_version+1,updated_at=now()
     WHERE (threads.subject_normalized,threads.participant_summary,threads.last_message_at,threads.unread_count,threads.provider_labels,threads.latest_provider_message_id,threads.latest_sender_display,threads.latest_sender_address,threads.latest_snippet,threads.message_count,threads.has_draft,threads.last_provider_updated_at)
       IS DISTINCT FROM
       (EXCLUDED.subject_normalized,EXCLUDED.participant_summary,EXCLUDED.last_message_at,EXCLUDED.unread_count,EXCLUDED.provider_labels,EXCLUDED.latest_provider_message_id,EXCLUDED.latest_sender_display,EXCLUDED.latest_sender_address,EXCLUDED.latest_snippet,EXCLUDED.message_count,EXCLUDED.has_draft,EXCLUDED.last_provider_updated_at)
     RETURNING id,provider_thread_id,subject_normalized,latest_sender_display,latest_snippet,last_message_at,unread_count,message_count,has_attachments,has_draft,provider_labels
     )
     SELECT id,provider_thread_id AS "providerThreadId",subject_normalized AS subject,latest_sender_display AS "latestSender",latest_snippet AS preview,last_message_at AS "lastMessageAt",unread_count AS "unreadCount",message_count AS "messageCount",has_attachments AS "hasAttachments",has_draft AS "hasDraft",provider_labels AS labels FROM upsert
     UNION ALL
     SELECT id,provider_thread_id AS "providerThreadId",subject_normalized AS subject,latest_sender_display AS "latestSender",latest_snippet AS preview,last_message_at AS "lastMessageAt",unread_count AS "unreadCount",message_count AS "messageCount",has_attachments AS "hasAttachments",has_draft AS "hasDraft",provider_labels AS labels
     FROM threads WHERE mailbox_account_id=$1 AND provider_thread_id=$2 AND NOT EXISTS (SELECT 1 FROM upsert)`,
    [mailboxAccountId, providerThread.id, header(latest, "Subject"), latestSender, timestamp(latest?.internalDate), messages.filter((message) => message.labelIds?.includes("UNREAD")).length, providerLabels, latest?.id ?? null, latestSender, latestSender, latest?.snippet ?? null, messages.length, providerLabels.includes("DRAFT"), timestamp(latest?.internalDate)]
  );
  for (const message of messages) {
    if (!message.id || !message.internalDate) continue;
    await client.query(
      `INSERT INTO messages(thread_id,provider_message_id,internal_timestamp,sent_at,from_address,snippet,provider_labels,subject,to_address_summary,cc_address_summary)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(thread_id,provider_message_id) DO UPDATE SET provider_labels=EXCLUDED.provider_labels,subject=EXCLUDED.subject,to_address_summary=EXCLUDED.to_address_summary,cc_address_summary=EXCLUDED.cc_address_summary,snippet=EXCLUDED.snippet
       WHERE (messages.provider_labels,messages.subject,messages.to_address_summary,messages.cc_address_summary,messages.snippet)
         IS DISTINCT FROM
         (EXCLUDED.provider_labels,EXCLUDED.subject,EXCLUDED.to_address_summary,EXCLUDED.cc_address_summary,EXCLUDED.snippet)`,
      [thread.rows[0].id, message.id, timestamp(message.internalDate), null, header(message, "From"), message.snippet ?? null, [...new Set(message.labelIds ?? [])], header(message, "Subject"), header(message, "To"), header(message, "Cc")]
    );
  }
  return thread.rows[0];
}
