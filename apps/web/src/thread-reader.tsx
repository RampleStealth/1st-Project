import { useEffect, useMemo, useRef, useState } from "react";
import { decodeDisplayEntities } from "./display-text.js";
import { readerFailureState, type ReaderState } from "./reader-state.js";
import { readerIframePolicy, sandboxedDocument } from "./safe-iframe.js";

type Message = { id: string; from: string | null; to: string[]; subject: string | null; sentAt: string | null; attachments: Array<{ filename: string; mimeType: string; size: number | null }>; plainText: string; sanitizedHtml: string | null; renderingState: "ready" | "fallback" | "failed" };
type Thread = { id: string; messages: Message[] };
type CommandAction = "archive" | "mark-unread";
type Command = { id: string; generation: number; status: string; action: CommandAction; threadId: string };
type CommandLifecycle = {
  generation: number;
  commandId: string | null;
  threadId: string;
  action: CommandAction;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  polling: boolean;
  status: string;
  terminalApplied: boolean;
  confirmedEventEmitted: boolean;
  disposed: boolean;
};
const terminalCommandStatuses = new Set(["succeeded", "failed", "recovery_required", "permission_required", "reauthorization_required"]);

export function mergePolledCommandStatus(command: Command, status: string): Command {
  return terminalCommandStatuses.has(command.status) || command.status === status || (status === "pending" && command.status !== "pending") ? command : { ...command, status };
}

function disposeCommandLifecycle(lifecycle: CommandLifecycle) {
  if (lifecycle.disposed) return;
  lifecycle.disposed = true;
  if (lifecycle.timer) clearTimeout(lifecycle.timer);
  lifecycle.timer = null;
  lifecycle.polling = false;
  lifecycle.controller.abort();
}

function commandMessage(status: string) {
  if (status === "retryable") return "Retrying this Gmail action…";
  if (status === "recovery_required") return "Gmail needs verification before this action can be confirmed.";
  if (status === "permission_required") return "Gmail write permission is required.";
  if (status === "reauthorization_required") return "Reconnect Gmail to continue.";
  if (status === "failed") return "This Gmail action did not complete. Your conversation has not changed.";
  return status === "running" ? "Updating Gmail…" : "Waiting for Gmail confirmation…";
}

function dateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";
}

export function ThreadReader({ mailboxId, threadId, view, onArchived, onUnread, onClose }: { mailboxId: string; threadId?: string; view?: string; onArchived?: () => void; onUnread?: () => void; onClose?: () => void }) {
  const [state, setState] = useState<ReaderState>(threadId ? "loading" : "idle");
  const [thread, setThread] = useState<Thread | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [command, setCommand] = useState<Command | null>(null);
  const lifecycleGeneration = useRef(0);
  const activeLifecycle = useRef<CommandLifecycle | null>(null);
  const subject = useMemo(() => decodeDisplayEntities(thread?.messages[0]?.subject) || "(No subject)", [thread]);
  useEffect(() => () => {
    const lifecycle = activeLifecycle.current;
    if (lifecycle) disposeCommandLifecycle(lifecycle);
    activeLifecycle.current = null;
  }, []);
  useEffect(() => {
    const lifecycle = activeLifecycle.current;
    if (lifecycle && lifecycle.threadId !== threadId) {
      disposeCommandLifecycle(lifecycle);
      activeLifecycle.current = null;
    }
    setCommand((current) => current?.threadId === threadId ? current : null);
  }, [threadId]);
  useEffect(() => {
    const lifecycle = activeLifecycle.current;
    if (!command || !lifecycle || lifecycle.disposed || lifecycle.commandId !== command.id || lifecycle.generation !== command.generation || lifecycle.threadId !== threadId || terminalCommandStatuses.has(lifecycle.status)) return;
    const isCurrent = () => activeLifecycle.current === lifecycle && !lifecycle.disposed && lifecycle.threadId === threadId;
    const schedule = () => {
      if (!isCurrent() || terminalCommandStatuses.has(lifecycle.status)) return;
      lifecycle.timer = setTimeout(() => void poll(), 1_000);
    };
    const poll = async () => {
      lifecycle.timer = null;
      if (!isCurrent() || !lifecycle.commandId) return;
      lifecycle.polling = true;
      try {
        const response = await fetch(`/v1/mailboxes/${mailboxId}/provider-commands/${lifecycle.commandId}`, { credentials: "include", signal: lifecycle.controller.signal });
        const value = response.ok ? await response.json() : null;
        if (!isCurrent() || !value || value.id !== lifecycle.commandId || typeof value.status !== "string") return;
        setCommand((existing) => {
          if (!existing || existing.generation !== lifecycle.generation || existing.id !== lifecycle.commandId || existing.threadId !== lifecycle.threadId) return existing;
          const next = mergePolledCommandStatus(existing, value.status);
          lifecycle.status = next.status;
          return next;
        });
        if (!terminalCommandStatuses.has(value.status)) schedule();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
      } finally {
        lifecycle.polling = false;
      }
    };
    schedule();
    return () => {
      if (lifecycle.timer) clearTimeout(lifecycle.timer);
      lifecycle.timer = null;
      if (activeLifecycle.current === lifecycle && lifecycle.threadId !== threadId) {
        disposeCommandLifecycle(lifecycle);
        activeLifecycle.current = null;
      }
    };
  }, [command?.generation, command?.id, mailboxId, threadId]);
  useEffect(() => {
    if (!command || !terminalCommandStatuses.has(command.status)) return;
    const lifecycle = activeLifecycle.current;
    if (!lifecycle || lifecycle.generation !== command.generation || lifecycle.commandId !== command.id || lifecycle.terminalApplied) return;
    lifecycle.terminalApplied = true;
    if (command.status === "succeeded" && !lifecycle.confirmedEventEmitted) {
      lifecycle.confirmedEventEmitted = true;
      window.dispatchEvent(new CustomEvent("aio:thread-command-confirmed", { detail: { threadId: lifecycle.threadId, action: lifecycle.action } }));
      if (lifecycle.action === "archive" && view === "inbox" && threadId === lifecycle.threadId) onArchived?.();
      if (lifecycle.action === "mark-unread" && threadId === lifecycle.threadId) onUnread?.();
    }
    disposeCommandLifecycle(lifecycle);
    activeLifecycle.current = null;
    if (command.status === "succeeded") setCommand((current) => current?.generation === lifecycle.generation ? null : current);
  }, [command, onArchived, onUnread, threadId, view]);
  const mutate = async (action: CommandAction) => {
    if (!threadId || command || activeLifecycle.current) return;
    const lifecycle: CommandLifecycle = { generation: ++lifecycleGeneration.current, commandId: null, threadId, action, controller: new AbortController(), timer: null, polling: false, status: "pending", terminalApplied: false, confirmedEventEmitted: false, disposed: false };
    activeLifecycle.current = lifecycle;
    setCommand({ id: "", generation: lifecycle.generation, status: "pending", action, threadId });
    const csrf = document.cookie.split("; ").find((value) => value.startsWith("aio_csrf="))?.slice(9) ?? "";
    try {
      const response = await fetch(`/v1/mailboxes/${mailboxId}/threads/${threadId}/${action}`, { method: "POST", credentials: "include", headers: { "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() }, signal: lifecycle.controller.signal });
      const body = await response.json().catch(() => null);
      if (activeLifecycle.current !== lifecycle || lifecycle.disposed) return;
      if (response.status === 409) {
        const status = body?.code === "provider_reauthentication_required" ? "reauthorization_required" : "permission_required";
        lifecycle.commandId = "";
        lifecycle.status = status;
        setCommand({ id: "", generation: lifecycle.generation, action, threadId, status });
        return;
      }
      if (!response.ok || !body?.id || typeof body.status !== "string") {
        disposeCommandLifecycle(lifecycle);
        activeLifecycle.current = null;
        setCommand((current) => current?.generation === lifecycle.generation ? null : current);
        return;
      }
      lifecycle.commandId = body.id;
      lifecycle.status = body.status;
      setCommand({ id: body.id, generation: lifecycle.generation, status: body.status, action, threadId });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        disposeCommandLifecycle(lifecycle);
        if (activeLifecycle.current === lifecycle) activeLifecycle.current = null;
        setCommand((current) => current?.generation === lifecycle.generation ? null : current);
      }
    }
  };
  useEffect(() => {
    if (!threadId) { setState("idle"); setThread(null); return; }
    let active = true; setState("loading"); setThread(null);
    void fetch(`/v1/mailboxes/${mailboxId}/threads/${encodeURIComponent(threadId)}`, { credentials: "include" }).then(async (response) => {
      if (!active) return;
      if (response.ok) { setThread(await response.json() as Thread); setState("ready"); return; }
      const body = await response.json().catch(() => null) as { code?: string } | null;
      setState(readerFailureState(body?.code));
    }).catch(() => active && setState("error"));
    return () => { active = false; };
  }, [attempt, mailboxId, threadId]);
  if (state === "idle") return <div className="reader-empty"><span aria-hidden="true">◌</span><h2>Select a conversation</h2><p>Choose a thread from the list to read it.</p></div>;
  if (state === "loading") return <section className="reader-state" aria-live="polite"><div className="reader-skeleton" /><div className="reader-skeleton" /><span>Loading conversation…</span></section>;
  if (state === "deleted") return <section className="reader-state"><h2>This conversation is no longer available</h2><p>It may have been deleted in Gmail.</p></section>;
  if (state === "disconnected") return <section className="reader-state"><h2>Reconnect Gmail to read this conversation</h2><p>Your connection needs attention before we can load it.</p></section>;
  if (state === "rendering-failure") return <section className="reader-state"><h2>We could not render this conversation safely</h2><p>No unfiltered content was shown.</p><button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></section>;
  if (state === "error" || !thread) return <section className="reader-state"><h2>We could not load this conversation</h2><p>Gmail may be temporarily unavailable.</p><button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></section>;
  return <section className="thread-reader" aria-labelledby="reader-subject"><header className="reader-header"><div><p className="reader-eyebrow">Conversation</p><h1 id="reader-subject">{subject}</h1></div><div className="reader-toolbar" aria-label="Conversation actions"><button className="button button--secondary reader-close" type="button" onClick={onClose}>Back to list</button><button className="button button--secondary" disabled={Boolean(command)} onClick={() => void mutate("archive")} type="button">Archive</button><button className="button button--secondary" disabled={Boolean(command)} onClick={() => void mutate("mark-unread")} type="button">Mark unread</button></div></header>{command && <p className={`command-notice command-notice--${command.status}`} role="status">{commandMessage(command.status)}</p>}<div className="thread-reader__messages">{thread.messages.map((message, index) => {
    const sender = decodeDisplayEntities(message.from) || "Unknown sender";
    const recipients = message.to.map((recipient) => decodeDisplayEntities(recipient)).join(", ");
    return <article className="message" key={message.id} aria-labelledby={`message-${message.id}-sender`}><header><div><strong id={`message-${message.id}-sender`}>{sender}</strong><p>{recipients ? `To: ${recipients}` : ""}</p></div><time dateTime={message.sentAt ?? undefined}>{dateTime(message.sentAt)}</time></header>{index > 0 && <p className="message-subject">{decodeDisplayEntities(message.subject) || "(No subject)"}</p>}{message.attachments.length > 0 && <p className="attachment-note">{message.attachments.length} attachment{message.attachments.length === 1 ? "" : "s"} — downloads are unavailable</p>}{message.renderingState === "failed" && <p className="render-warning">Displayed as safe plain text because rich content could not be rendered.</p>}{message.sanitizedHtml ? <iframe title={`Sanitized message from ${sender}`} className="message-html" {...readerIframePolicy} srcDoc={sandboxedDocument(message.sanitizedHtml)} /> : <pre className="message-plain">{message.plainText}</pre>}</article>;
  })}</div></section>;
}
