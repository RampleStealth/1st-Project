import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ThreadRow, type ThreadItem } from "./thread-list.js";

type SearchPage = { items: ThreadItem[]; nextCursor: string | null; source: "gmail_search"; fetchedAt: string };
type Owned<T> = { owner: string; value: T };

export function normalizeSearchOwnershipQuery(value: string) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function MailboxSearch({ mailboxId, query, selectedThreadId }: { mailboxId: string; query: string; selectedThreadId?: string }) {
  const navigate = useNavigate();
  const normalizedQuery = normalizeSearchOwnershipQuery(query);
  const owner = `${mailboxId}:search:${normalizedQuery}`;
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const [input, setInput] = useState(query);
  const [ownedPage, setOwnedPage] = useState<Owned<SearchPage> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [ownedLoading, setOwnedLoading] = useState<Owned<boolean>>({ owner, value: Boolean(normalizedQuery) });
  const [ownedError, setOwnedError] = useState<Owned<string | null>>({ owner, value: null });
  const page = ownedPage?.owner === owner ? ownedPage.value : null;
  const loading = ownedLoading.owner === owner ? ownedLoading.value : Boolean(normalizedQuery);
  const error = ownedError.owner === owner ? ownedError.value : null;

  useEffect(() => setInput(query), [query]);

  const searchPath = (threadId?: string) => {
    const params = new URLSearchParams({ q: normalizedQuery });
    return `/mail/${mailboxId}/search${threadId ? `/${encodeURIComponent(threadId)}` : ""}?${params}`;
  };

  const load = async (requestedCursor: string | null) => {
    if (!normalizedQuery) return;
    const requestOwner = owner;
    const generation = ++requestGeneration.current;
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    const ownsRequest = () => !controller.signal.aborted && ownerRef.current === requestOwner && requestGeneration.current === generation;
    setOwnedLoading({ owner: requestOwner, value: true }); setOwnedError({ owner: requestOwner, value: null });
    try {
      const params = new URLSearchParams({ query: normalizedQuery, limit: "10" });
      if (requestedCursor) params.set("cursor", requestedCursor);
      const response = await fetch(`/v1/mailboxes/${mailboxId}/search?${params}`, { credentials: "include", signal: controller.signal });
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(problem?.message ?? "We could not search Gmail.");
      }
      const nextPage = await response.json() as SearchPage;
      if (ownsRequest()) setOwnedPage({ owner: requestOwner, value: nextPage });
    } catch (cause) {
      if (ownsRequest()) setOwnedError({ owner: requestOwner, value: cause instanceof Error ? cause.message : "We could not search Gmail." });
    } finally {
      if (ownsRequest()) { setOwnedLoading({ owner: requestOwner, value: false }); activeRequest.current = null; }
    }
  };

  useEffect(() => {
    activeRequest.current?.abort(); requestGeneration.current += 1;
    setCursor(null); setHistory([]); setOwnedPage(null); setOwnedError({ owner, value: null }); setOwnedLoading({ owner, value: Boolean(normalizedQuery) });
    if (normalizedQuery) void load(null);
    return () => { activeRequest.current?.abort(); requestGeneration.current += 1; };
  }, [mailboxId, normalizedQuery]);

  useEffect(() => {
    const confirmed = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; action: "archive" | "mark-unread" }>).detail;
      if (!detail || detail.action !== "mark-unread") return;
      setOwnedPage((current) => current?.owner === owner ? { ...current, value: { ...current.value, items: current.value.items.map((item) => item.providerThreadId === detail.threadId ? { ...item, unreadCount: Math.max(1, item.unreadCount), labels: [...new Set([...item.labels, "UNREAD"])] } : item) } } : current);
    };
    window.addEventListener("aio:thread-command-confirmed", confirmed);
    return () => window.removeEventListener("aio:thread-command-confirmed", confirmed);
  }, [owner]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextQuery = normalizeSearchOwnershipQuery(input);
    if (!nextQuery) return;
    navigate(`/mail/${mailboxId}/search?${new URLSearchParams({ q: nextQuery })}`);
  };
  const next = () => { if (!page?.nextCursor) return; setHistory((previous) => [...previous, cursor]); setCursor(page.nextCursor); void load(page.nextCursor); };
  const previous = () => { if (!history.length) return; const prior = history.at(-1) ?? null; setHistory((items) => items.slice(0, -1)); setCursor(prior); void load(prior); };

  const form = <form className="search-form" role="search" onSubmit={submit}><label className="sr-only" htmlFor="mailbox-search-query">Search Gmail</label><input id="mailbox-search-query" type="search" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Search keywords or “quoted phrases”" maxLength={200} autoComplete="off" /><button className="button" type="submit" disabled={!normalizeSearchOwnershipQuery(input)}>Search</button></form>;
  if (!normalizedQuery) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state"><div><h1>Search your mailbox</h1><p>Enter plain keywords or a quoted phrase. Gmail remains the source of these results.</p></div></div></div></section>;
  if (loading && !page) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state" aria-live="polite"><div className="thread-skeleton" /><div className="thread-skeleton" /><span>Searching Gmail…</span></div></div></section>;
  if (error && !page) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state"><div><h1>We could not search Gmail</h1><p>{error}</p><button className="button" type="button" onClick={() => void load(cursor)}>Try again</button></div></div></div></section>;
  return <section className="mailbox-search"><div className="search-panel">{form}<section className="thread-list" aria-label="Search results"><div className="thread-list__header"><span>Search results</span><span>From Gmail</span></div>{error && <div className="thread-list__retry" role="status">{error}<button type="button" onClick={() => void load(cursor)}>Retry</button></div>}{!page?.items.length ? <div className="thread-list-state"><div><h1>No matching conversations</h1><p>Gmail found no threads for “{normalizedQuery}”.</p></div></div> : <div className="thread-list__rows" aria-label="Search result threads" aria-busy={loading}>{page.items.map((thread) => <ThreadRow key={thread.id} thread={thread} selected={thread.providerThreadId === selectedThreadId} onSelect={() => navigate(searchPath(thread.providerThreadId))} />)}</div>}<nav className="thread-list__footer pagination" aria-label="Search pagination"><div className="thread-list__pagination-start">{history.length > 0 && <button type="button" onClick={previous} disabled={loading}>Previous</button>}</div><span aria-live="polite">{loading ? "Loading page…" : "Gmail results"}</span><div className="thread-list__pagination-end">{page?.nextCursor && <button type="button" onClick={next} disabled={loading}>Next</button>}</div></nav></section></div></section>;
}
