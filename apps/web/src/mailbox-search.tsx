import { type FormEvent, useEffect, useRef, useState } from "react";
import type { MailboxSearchScope } from "@aio/contracts";
import { useNavigate } from "react-router-dom";
import { ThreadRow, type ThreadItem } from "./thread-list.js";

type SearchPage = { items: ThreadItem[]; nextCursor: string | null; source: "gmail_search"; fetchedAt: string };
type Owned<T> = { owner: string; value: T };
export type SearchFormCriteria = {
  query: string;
  scope: MailboxSearchScope;
  from: string;
  to: string;
  subject: string;
  after: string;
  before: string;
  unread: boolean;
  hasAttachment: boolean;
};

export function normalizeSearchOwnershipQuery(value: string) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function normalizeLiteral(value: string) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function searchCriteriaFromParams(params: URLSearchParams): SearchFormCriteria {
  const scope = params.get("scope");
  return {
    query: normalizeSearchOwnershipQuery(params.get("q") ?? ""),
    scope: scope === "inbox" || scope === "sent" || scope === "drafts" ? scope : "all",
    from: normalizeLiteral(params.get("from") ?? ""),
    to: normalizeLiteral(params.get("to") ?? ""),
    subject: normalizeLiteral(params.get("subject") ?? ""),
    after: params.get("after")?.trim() ?? "",
    before: params.get("before")?.trim() ?? "",
    unread: params.get("unread") === "true",
    hasAttachment: params.get("hasAttachment") === "true"
  };
}

export function normalizeSearchCriteria(criteria: SearchFormCriteria): SearchFormCriteria {
  return {
    query: normalizeSearchOwnershipQuery(criteria.query),
    scope: criteria.scope,
    from: normalizeLiteral(criteria.from),
    to: normalizeLiteral(criteria.to),
    subject: normalizeLiteral(criteria.subject),
    after: criteria.after.trim(),
    before: criteria.before.trim(),
    unread: criteria.unread,
    hasAttachment: criteria.hasAttachment
  };
}

export function hasEffectiveSearch(criteria: SearchFormCriteria) {
  const value = normalizeSearchCriteria(criteria);
  return Boolean(value.query || value.scope !== "all" || value.from || value.to || value.subject || value.after || value.before || value.unread || value.hasAttachment);
}

function browserSearchParams(criteria: SearchFormCriteria) {
  const value = normalizeSearchCriteria(criteria);
  const params = new URLSearchParams();
  if (value.query) params.set("q", value.query);
  if (value.scope !== "all") params.set("scope", value.scope);
  if (value.from) params.set("from", value.from);
  if (value.to) params.set("to", value.to);
  if (value.subject) params.set("subject", value.subject);
  if (value.after) params.set("after", value.after);
  if (value.before) params.set("before", value.before);
  if (value.unread) params.set("unread", "true");
  if (value.hasAttachment) params.set("hasAttachment", "true");
  return params;
}

function apiSearchParams(criteria: SearchFormCriteria, cursor?: string | null) {
  const browser = browserSearchParams(criteria);
  const params = new URLSearchParams();
  const query = browser.get("q");
  if (query) params.set("query", query);
  for (const key of ["scope", "from", "to", "subject", "after", "before", "unread", "hasAttachment"] as const) {
    const value = browser.get(key);
    if (value) params.set(key, value);
  }
  params.set("limit", "10");
  if (cursor) params.set("cursor", cursor);
  return params;
}

export function searchCriteriaOwnershipKey(criteria: SearchFormCriteria) {
  return browserSearchParams(criteria).toString();
}

export function searchBrowserPath(mailboxId: string, criteria: SearchFormCriteria, threadId?: string) {
  const params = browserSearchParams(criteria).toString();
  return `/mail/${mailboxId}/search${threadId ? `/${encodeURIComponent(threadId)}` : ""}${params ? `?${params}` : ""}`;
}

function activeFilterCount(criteria: SearchFormCriteria) {
  return Number(criteria.scope !== "all") + [criteria.from, criteria.to, criteria.subject, criteria.after, criteria.before].filter(Boolean).length + Number(criteria.unread) + Number(criteria.hasAttachment);
}

function criteriaSummary(criteria: SearchFormCriteria) {
  const values = [
    criteria.scope !== "all" ? ({ inbox: "Inbox", sent: "Sent", drafts: "Drafts" } as const)[criteria.scope] : null,
    criteria.from ? `From ${criteria.from}` : null,
    criteria.to ? `To ${criteria.to}` : null,
    criteria.subject ? `Subject ${criteria.subject}` : null,
    criteria.after ? `After ${criteria.after}` : null,
    criteria.before ? `Before ${criteria.before}` : null,
    criteria.unread ? "Unread" : null,
    criteria.hasAttachment ? "Has attachment" : null
  ].filter((value): value is string => Boolean(value));
  return values.join(" · ");
}

export function MailboxSearch({ mailboxId, criteria, selectedThreadId }: { mailboxId: string; criteria: SearchFormCriteria; selectedThreadId?: string }) {
  const navigate = useNavigate();
  const normalizedCriteria = normalizeSearchCriteria(criteria);
  const criteriaKey = searchCriteriaOwnershipKey(normalizedCriteria);
  const owner = `${mailboxId}:search:${criteriaKey}`;
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const [draftCriteria, setDraftCriteria] = useState(normalizedCriteria);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ownedPage, setOwnedPage] = useState<Owned<SearchPage> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [ownedLoading, setOwnedLoading] = useState<Owned<boolean>>({ owner, value: hasEffectiveSearch(normalizedCriteria) });
  const [ownedError, setOwnedError] = useState<Owned<string | null>>({ owner, value: null });
  const page = ownedPage?.owner === owner ? ownedPage.value : null;
  const loading = ownedLoading.owner === owner ? ownedLoading.value : hasEffectiveSearch(normalizedCriteria);
  const error = ownedError.owner === owner ? ownedError.value : null;

  useEffect(() => setDraftCriteria(normalizedCriteria), [criteriaKey]);

  const load = async (requestedCursor: string | null) => {
    if (!hasEffectiveSearch(normalizedCriteria)) return;
    const requestOwner = owner;
    const generation = ++requestGeneration.current;
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    const ownsRequest = () => !controller.signal.aborted && ownerRef.current === requestOwner && requestGeneration.current === generation;
    setOwnedLoading({ owner: requestOwner, value: true }); setOwnedError({ owner: requestOwner, value: null });
    try {
      const params = apiSearchParams(normalizedCriteria, requestedCursor);
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
    setCursor(null); setHistory([]); setOwnedPage(null); setOwnedError({ owner, value: null }); setOwnedLoading({ owner, value: hasEffectiveSearch(normalizedCriteria) });
    if (hasEffectiveSearch(normalizedCriteria)) void load(null);
    return () => { activeRequest.current?.abort(); requestGeneration.current += 1; };
  }, [mailboxId, criteriaKey]);

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
    const nextCriteria = normalizeSearchCriteria(draftCriteria);
    if (!hasEffectiveSearch(nextCriteria)) return;
    navigate(searchBrowserPath(mailboxId, nextCriteria));
  };
  const next = () => { if (!page?.nextCursor) return; setHistory((previous) => [...previous, cursor]); setCursor(page.nextCursor); void load(page.nextCursor); };
  const previous = () => { if (!history.length) return; const prior = history.at(-1) ?? null; setHistory((items) => items.slice(0, -1)); setCursor(prior); void load(prior); };
  const setField = <K extends keyof SearchFormCriteria>(field: K, value: SearchFormCriteria[K]) => setDraftCriteria((current) => ({ ...current, [field]: value }));
  const filterCount = activeFilterCount(draftCriteria);
  const summary = criteriaSummary(normalizedCriteria);

  const form = <form className="search-form" role="search" onSubmit={submit}>
    <div className="search-form__primary">
      <label className="sr-only" htmlFor="mailbox-search-query">Search Gmail</label>
      <input id="mailbox-search-query" type="search" value={draftCriteria.query} onChange={(event) => setField("query", event.target.value)} placeholder="Search keywords or quoted phrases" maxLength={200} autoComplete="off" />
      <label className="sr-only" htmlFor="mailbox-search-scope">Search scope</label>
      <select id="mailbox-search-scope" value={draftCriteria.scope} onChange={(event) => setField("scope", event.target.value as MailboxSearchScope)}><option value="all">All mail</option><option value="inbox">Inbox</option><option value="sent">Sent</option><option value="drafts">Drafts</option></select>
      <button className="button button--secondary" type="button" aria-expanded={filtersOpen} aria-controls="mailbox-search-filters" onClick={() => setFiltersOpen((open) => !open)}>Filters{filterCount ? ` (${filterCount})` : ""}</button>
      <button className="button" type="submit" disabled={!hasEffectiveSearch(draftCriteria)}>Search</button>
    </div>
    <div id="mailbox-search-filters" className="search-filters" hidden={!filtersOpen}>
      <label>From<input value={draftCriteria.from} onChange={(event) => setField("from", event.target.value)} maxLength={254} autoComplete="off" /></label>
      <label>To<input value={draftCriteria.to} onChange={(event) => setField("to", event.target.value)} maxLength={254} autoComplete="off" /></label>
      <label>Subject<input value={draftCriteria.subject} onChange={(event) => setField("subject", event.target.value)} maxLength={200} autoComplete="off" /></label>
      <label>After<input type="date" value={draftCriteria.after} onChange={(event) => setField("after", event.target.value)} /></label>
      <label>Before<input type="date" value={draftCriteria.before} onChange={(event) => setField("before", event.target.value)} /></label>
      <label className="search-filter-check"><input type="checkbox" checked={draftCriteria.unread} onChange={(event) => setField("unread", event.target.checked)} />Unread</label>
      <label className="search-filter-check"><input type="checkbox" checked={draftCriteria.hasAttachment} onChange={(event) => setField("hasAttachment", event.target.checked)} />Has attachment</label>
      <button type="button" className="button button--secondary" onClick={() => setDraftCriteria((current) => ({ ...current, scope: "all", from: "", to: "", subject: "", after: "", before: "", unread: false, hasAttachment: false }))}>Clear filters</button>
      <p className="search-date-note">Gmail interprets these dates from midnight Pacific time.</p>
    </div>
    {summary && <p className="search-summary" aria-label="Active search filters">{summary}</p>}
  </form>;
  if (!hasEffectiveSearch(normalizedCriteria)) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state"><div><h1>Search your mailbox</h1><p>Enter keywords or choose one or more filters. Gmail remains the source of these results.</p></div></div></div></section>;
  if (loading && !page) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state" aria-live="polite"><div className="thread-skeleton" /><div className="thread-skeleton" /><span>Searching Gmail…</span></div></div></section>;
  if (error && !page) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state"><div><h1>We could not search Gmail</h1><p>{error}</p><button className="button" type="button" onClick={() => void load(cursor)}>Try again</button></div></div></div></section>;
  return <section className="mailbox-search"><div className="search-panel">{form}<section className="thread-list" aria-label="Search results"><div className="thread-list__header"><span>Search results</span><span>From Gmail</span></div>{error && <div className="thread-list__retry" role="status">{error}<button type="button" onClick={() => void load(cursor)}>Retry</button></div>}{!page?.items.length ? <div className="thread-list-state"><div><h1>No matching conversations</h1><p>Gmail found no threads for this search.</p></div></div> : <div className="thread-list__rows" aria-label="Search result threads" aria-busy={loading}>{page.items.map((thread) => <ThreadRow key={thread.id} thread={thread} selected={thread.providerThreadId === selectedThreadId} onSelect={() => navigate(searchBrowserPath(mailboxId, normalizedCriteria, thread.providerThreadId))} />)}</div>}<nav className="thread-list__footer pagination" aria-label="Search pagination"><div className="thread-list__pagination-start">{history.length > 0 && <button type="button" onClick={previous} disabled={loading}>Previous</button>}</div><span aria-live="polite">{loading ? "Loading page…" : "Gmail results"}</span><div className="thread-list__pagination-end">{page?.nextCursor && <button type="button" onClick={next} disabled={loading}>Next</button>}</div></nav></section></div></section>;
}
