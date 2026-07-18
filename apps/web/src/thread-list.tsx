import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { decodeDisplayEntities } from "./display-text.js";

type ThreadItem = { id: string; providerThreadId: string; subject: string | null; latestSender: string | null; preview: string | null; lastMessageAt: string | null; unreadCount: number; messageCount: number; hasAttachments: boolean | null; hasDraft: boolean; labels: string[]; };
type Page = { items: ThreadItem[]; nextCursor: string | null; source: "gmail"; fetchedAt: string };
type Owned<T> = { owner: string; value: T };

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)) : "";
}

function ThreadRow({ thread, selected, onSelect }: { thread: ThreadItem; selected: boolean; onSelect: () => void }) {
  const unread = thread.unreadCount > 0;
  const sender = decodeDisplayEntities(thread.latestSender) || "Unknown sender";
  const subject = decodeDisplayEntities(thread.subject) || "(No subject)";
  const preview = decodeDisplayEntities(thread.preview) || "No preview available.";
  const className = `thread-row${unread ? " thread-row--unread" : ""}${selected ? " thread-row--selected" : ""}`;
  return <button id={`thread-row-${thread.providerThreadId}`} data-thread-row type="button" className={className} onClick={onSelect} aria-current={selected ? "true" : undefined} aria-label={`${subject} from ${sender}`}>
    <span className="thread-row__top"><strong title={sender}>{sender}</strong><time dateTime={thread.lastMessageAt ?? undefined}>{formatDate(thread.lastMessageAt)}</time></span>
    <span className="thread-row__subject"><span title={subject}>{subject}</span>{thread.hasAttachments === true && <span className="thread-row__attachment" aria-label="Has attachment">Attachment</span>}</span>
    <span className="thread-row__preview" title={preview}>{preview}</span>
    {unread && <span className="unread-count" aria-label={`${thread.unreadCount} unread messages`}>{thread.unreadCount}</span>}
  </button>;
}

export function ThreadList({ mailboxId, view, selectedThreadId }: { mailboxId: string; view: string; selectedThreadId?: string }) {
  const navigate = useNavigate();
  const owner = `${mailboxId}:${view}`;
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const [ownedPage, setOwnedPage] = useState<Owned<Page> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [ownedLoading, setOwnedLoading] = useState<Owned<boolean>>({ owner, value: true });
  const [ownedError, setOwnedError] = useState<Owned<string | null>>({ owner, value: null });
  const page = ownedPage?.owner === owner ? ownedPage.value : null;
  const loading = ownedLoading.owner === owner ? ownedLoading.value : true;
  const error = ownedError.owner === owner ? ownedError.value : null;
  const load = async (requestedCursor: string | null) => {
    const requestOwner = owner;
    const generation = ++requestGeneration.current;
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    const ownsRequest = () => !controller.signal.aborted && ownerRef.current === requestOwner && requestGeneration.current === generation;
    setOwnedLoading({ owner: requestOwner, value: true }); setOwnedError({ owner: requestOwner, value: null });
    try {
      const params = new URLSearchParams({ view, limit: "25" });
      if (requestedCursor) params.set("cursor", requestedCursor);
      const response = await fetch(`/v1/mailboxes/${mailboxId}/threads?${params}`, { credentials: "include", signal: controller.signal });
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(problem?.message ?? "We could not load this Gmail view.");
      }
      const nextPage = await response.json() as Page;
      if (ownsRequest()) setOwnedPage({ owner: requestOwner, value: nextPage });
    } catch (cause) {
      if (ownsRequest()) setOwnedError({ owner: requestOwner, value: cause instanceof Error ? cause.message : "We could not load this Gmail view." });
    } finally {
      if (ownsRequest()) { setOwnedLoading({ owner: requestOwner, value: false }); activeRequest.current = null; }
    }
  };
  useEffect(() => {
    activeRequest.current?.abort(); requestGeneration.current += 1;
    setCursor(null); setHistory([]); setOwnedPage(null); setOwnedError({ owner, value: null }); setOwnedLoading({ owner, value: true });
    void load(null);
    return () => { activeRequest.current?.abort(); requestGeneration.current += 1; };
  }, [mailboxId, view]);
  useEffect(() => {
    const confirmed = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; action: "archive" | "mark-unread" }>).detail;
      if (!detail) return;
      setOwnedPage((current) => {
        if (!current || current.owner !== owner) return current;
        if (detail.action === "archive" && view === "inbox") return { ...current, value: { ...current.value, items: current.value.items.filter((item) => item.providerThreadId !== detail.threadId) } };
        if (detail.action === "mark-unread") return { ...current, value: { ...current.value, items: current.value.items.map((item) => item.providerThreadId === detail.threadId ? { ...item, unreadCount: Math.max(1, item.unreadCount), labels: [...new Set([...item.labels, "UNREAD"])] } : item) } };
        return current;
      });
    };
    window.addEventListener("aio:thread-command-confirmed", confirmed);
    return () => window.removeEventListener("aio:thread-command-confirmed", confirmed);
  }, [owner, view]);
  const next = () => { if (!page?.nextCursor) return; setHistory((previous) => [...previous, cursor]); setCursor(page.nextCursor); void load(page.nextCursor); };
  const previous = () => { if (!history.length) return; const prior = history.at(-1) ?? null; setHistory((items) => items.slice(0, -1)); setCursor(prior); void load(prior); };
  if (loading && !page) return <section className="thread-list-state" aria-live="polite"><div className="thread-skeleton" /><div className="thread-skeleton" /><div className="thread-skeleton" /><span>Loading Gmail threads…</span></section>;
  if (error && !page) return <section className="thread-list-state"><div><h1>We could not load this view</h1><p>{error}</p><button className="button" onClick={() => void load(cursor)} type="button">Try again</button></div></section>;
  if (!page || page.items.length === 0) return <section className="thread-list-state"><div><h1>No threads in {view === "all" ? "All Mail" : view}</h1><p>Gmail returned no conversations for this view.</p></div></section>;
  return <section className="thread-list" aria-label="Threads"><div className="thread-list__header"><span>{view === "all" ? "All Mail" : view}</span><span>From Gmail</span></div>{error && <div className="thread-list__retry" role="status">{error}<button type="button" onClick={() => void load(cursor)}>Retry</button></div>}<div className="thread-list__rows" aria-label="Thread results" aria-busy={loading}>{page.items.map((thread) => <ThreadRow key={thread.id} thread={thread} selected={thread.providerThreadId === selectedThreadId} onSelect={() => navigate(`/mail/${mailboxId}/${view}/${thread.providerThreadId}`)} />)}</div><nav className="thread-list__footer pagination" aria-label="Thread pagination"><div className="thread-list__pagination-start">{history.length > 0 && <button type="button" onClick={previous} disabled={loading}>Previous</button>}</div><span aria-live="polite">{loading ? "Loading page…" : "Gmail results"}</span><div className="thread-list__pagination-end">{page.nextCursor && <button type="button" onClick={next} disabled={loading}>Next</button>}</div></nav></section>;
}
