import { google, gmail_v1 } from "googleapis";
import type { AppConfig } from "@aio/config";
import { decryptSecret } from "@aio/security";

const gmailScopes = ["https://www.googleapis.com/auth/gmail.readonly"];

export function createOAuthClient(config: AppConfig) {
  return new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI);
}

export function authorizationUrl(config: AppConfig, state: string, codeChallenge: string) {
  return createOAuthClient(config).generateAuthUrl({
    access_type: "offline",
    scope: gmailScopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
    include_granted_scopes: false
  });
}

export async function exchangeCode(config: AppConfig, code: string, codeVerifier: string) {
  const client = createOAuthClient(config);
  const { tokens } = await client.getToken({ code, codeVerifier });
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token; reconnect with consent");
  client.setCredentials(tokens);
  const profile = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
  return { tokens, profile: profile.data };
}

export function gmailForMailbox(config: AppConfig, encryptedRefreshToken: string): gmail_v1.Gmail {
  const client = createOAuthClient(config);
  client.setCredentials({ refresh_token: decryptSecret(encryptedRefreshToken, config.TOKEN_ENCRYPTION_KEY_BASE64) });
  return google.gmail({ version: "v1", auth: client });
}

export async function initialThreadIds(gmail: gmail_v1.Gmail, maxResults = 500): Promise<string[]> {
  const response = await gmail.users.threads.list({ userId: "me", maxResults, includeSpamTrash: false });
  return response.data.threads?.flatMap((thread) => thread.id ? [thread.id] : []) ?? [];
}

export async function changedMessageIds(gmail: gmail_v1.Gmail, startHistoryId: string): Promise<{ messageIds: string[]; deletedMessageIds: string[]; latestHistoryId?: string }> {
  const ids = new Set<string>();
  const deletedIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;
  do {
    const response = await gmail.users.history.list({ userId: "me", startHistoryId, pageToken, historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] });
    latestHistoryId = response.data.historyId ?? latestHistoryId;
    for (const history of response.data.history ?? []) {
      for (const entry of [...(history.messagesAdded ?? []), ...(history.labelsAdded ?? []), ...(history.labelsRemoved ?? [])]) {
        if (entry.message?.id) ids.add(entry.message.id);
      }
      for (const entry of history.messagesDeleted ?? []) if (entry.message?.id) deletedIds.add(entry.message.id);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  for (const id of deletedIds) ids.delete(id);
  return { messageIds: [...ids], deletedMessageIds: [...deletedIds], latestHistoryId };
}

export async function getMessage(gmail: gmail_v1.Gmail, id: string) {
  return (await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] })).data;
}

export async function getThread(gmail: gmail_v1.Gmail, id: string) {
  return (await gmail.users.threads.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] })).data;
}

export async function currentHistoryId(gmail: gmail_v1.Gmail): Promise<string> {
  const profile = await gmail.users.getProfile({ userId: "me" });
  if (!profile.data.historyId) throw new Error("Gmail profile did not include history ID");
  return profile.data.historyId;
}

export async function watchMailbox(gmail: gmail_v1.Gmail, topicName: string) {
  return (await gmail.users.watch({ userId: "me", requestBody: { topicName } })).data;
}

export async function stopWatch(gmail: gmail_v1.Gmail) {
  await gmail.users.stop({ userId: "me" });
}
