import { type FormEvent, useEffect, useRef, useState } from "react";
import type { MailboxSearchScope } from "@aio/contracts";
import { useNavigate } from "react-router-dom";
import { ThreadRow, type ThreadItem } from "./thread-list.js";

type SearchPage = { items: ThreadItem[]; nextCursor: string | null; source: "gmail_search"; fetchedAt: string };
type Owned<T> = { owner: string; value: T };
type SearchProblem = { code: string; message: string; field?: string; retryable?: boolean };
type LoadCommit = () => void;

class SearchResponseError extends Error {
  constructor(readonly problem: SearchProblem) {
    super(problem.message);
  }
}

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
  const scope = ({ all: "All mail", inbox: "Inbox", sent: "Sent", drafts: "Drafts" } as const)[criteria.scope];
  const values = [
    scope,
    criteria.query ? `Keywords "${criteria.query}"` : null,
    criteria.from ? `From ${criteria.from}` : null,
    criteria.to ? `To ${criteria.to}` : null,
    criteria.subject ? `Subject ${criteria.subject}` : null,
    criteria.after ? `After ${criteria.after}` : null,
    criteria.before ? `Before ${criteria.before}` : null,
    criteria.unread ? "Unread" : null,
    criteria.hasAttachment ? "Has attachment" : null
  ].filter((value): value is string => Boolean(value));
  return `Applied search: ${values.join("; ")}`;
}

function safeProblem(value: unknown): SearchProblem {
  if (!value || typeof value !== "object") return { code: "search_failed", message: "We could not search Gmail." };
  const problem = value as Record<string, unknown>;
  return {
    code: typeof problem.code === "string" ? problem.code : "search_failed",
    message: typeof problem.message === "string" ? problem.message : "We could not search Gmail.",
    ...(typeof problem.field === "string" ? { field: problem.field } : {}),
    ...(typeof problem.retryable === "boolean" ? { retryable: problem.retryable } : {})
  };
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']"));
}

const filterFieldIds: Record<string, string> = {
  query: "mailbox-search-query",
  scope: "mailbox-search-scope",
  from: "mailbox-search-from",
  to: "mailbox-search-to",
  subject: "mailbox-search-subject",
  after: "mailbox-search-after",
  before: "mailbox-search-before",
  unread: "mailbox-search-unread",
  hasAttachment: "mailbox-search-has-attachment"
};

export function MailboxSearch({ mailboxId, criteria, selectedThreadId }: { mailboxId: string; criteria: SearchFormCriteria; selectedThreadId?: string }) {
  const navigate = useNavigate();
  const normalizedCriteria = normalizeSearchCriteria(criteria);
  const criteriaKey = searchCriteriaOwnershipKey(normalizedCriteria);
  const owner = `${mailboxId}:search:${criteriaKey}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const retryRequest = useRef<(() => void) | null>(null);
  const focusResultsAfterLoad = useRef(false);
  const queryInput = useRef<HTMLInputElement | null>(null);
  const filtersButton = useRef<HTMLButtonElement | null>(null);
  const resultsHeading = useRef<HTMLHeadingElement | null>(null);
  const [draftCriteria, setDraftCriteria] = useState(normalizedCriteria);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ownedPage, setOwnedPage] = useState<Owned<SearchPage> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [ownedLoading, setOwnedLoading] = useState<Owned<boolean>>({ owner, value: hasEffectiveSearch(normalizedCriteria) });
  const [ownedPendingPage, setOwnedPendingPage] = useState<Owned<number | null>>({ owner, value: hasEffectiveSearch(normalizedCriteria) ? 1 : null });
  const [ownedError, setOwnedError] = useState<Owned<SearchProblem | null>>({ owner, value: null });
  const page = ownedPage?.owner === owner ? ownedPage.value : null;
  const loading = ownedLoading.owner === owner ? ownedLoading.value : hasEffectiveSearch(normalizedCriteria);
  const pendingPage = ownedPendingPage.owner === owner ? ownedPendingPage.value : null;
  const error = ownedError.owner === owner ? ownedError.value : null;
  const pageNumber = history.length + 1;
  const normalizedDraft = normalizeSearchCriteria(draftCriteria);
  const draftKey = searchCriteriaOwnershipKey(normalizedDraft);
  const dirty = draftKey !== criteriaKey;

  useEffect(() => setDraftCriteria(normalizedCriteria), [criteriaKey]);

  const focusInvalidField = (problem: SearchProblem, requestOwner: string, generation: number) => {
    if (!problem.field || !filterFieldIds[problem.field]) return;
    if (!(problem.field === "query" || problem.field === "scope")) setFiltersOpen(true);
    requestAnimationFrame(() => {
      if (ownerRef.current === requestOwner && requestGeneration.current === generation) document.getElementById(filterFieldIds[problem.field!])?.focus();
    });
  };

  const load = async (requestedCursor: string | null, requestedPage: number, commit?: LoadCommit, focusResults = false) => {
    if (!hasEffectiveSearch(normalizedCriteria)) return;
    const requestOwner = owner;
    const generation = ++requestGeneration.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const ownsRequest = () => !controller.signal.aborted && ownerRef.current === requestOwner && requestGeneration.current === generation;
    retryRequest.current = () => {
      if (ownerRef.current === requestOwner) void load(requestedCursor, requestedPage, commit, focusResults);
    };
    setOwnedLoading({ owner: requestOwner, value: true });
    setOwnedPendingPage({ owner: requestOwner, value: requestedPage });
    setOwnedError({ owner: requestOwner, value: null });
    try {
      const params = apiSearchParams(normalizedCriteria, requestedCursor);
      const response = await fetch(`/v1/mailboxes/${mailboxId}/search?${params}`, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new SearchResponseError(safeProblem(await response.json().catch(() => null)));
      const nextPage = await response.json() as SearchPage;
      if (ownsRequest()) {
        setOwnedPage({ owner: requestOwner, value: nextPage });
        commit?.();
        focusResultsAfterLoad.current = focusResults;
        retryRequest.current = null;
      }
    } catch (cause) {
      if (ownsRequest()) {
        const problem = cause instanceof SearchResponseError ? cause.problem : { code: "search_failed", message: "We could not search Gmail." };
        setOwnedError({ owner: requestOwner, value: problem });
        focusInvalidField(problem, requestOwner, generation);
      }
    } finally {
      if (ownsRequest()) {
        setOwnedLoading({ owner: requestOwner, value: false });
        setOwnedPendingPage({ owner: requestOwner, value: null });
        activeRequest.current = null;
      }
    }
  };

  useEffect(() => {
    activeRequest.current?.abort();
    requestGeneration.current += 1;
    retryRequest.current = null;
    focusResultsAfterLoad.current = false;
    setCursor(null);
    setHistory([]);
    setOwnedPage(null);
    setOwnedError({ owner, value: null });
    setOwnedLoading({ owner, value: hasEffectiveSearch(normalizedCriteria) });
    setOwnedPendingPage({ owner, value: hasEffectiveSearch(normalizedCriteria) ? 1 : null });
    if (hasEffectiveSearch(normalizedCriteria)) void load(null, 1);
    return () => {
      activeRequest.current?.abort();
      requestGeneration.current += 1;
      retryRequest.current = null;
    };
  }, [mailboxId, criteriaKey]);

  useEffect(() => {
    if (loading || !page || !focusResultsAfterLoad.current) return;
    focusResultsAfterLoad.current = false;
    const focusOwner = owner;
    const generation = requestGeneration.current;
    requestAnimationFrame(() => {
      if (ownerRef.current === focusOwner && requestGeneration.current === generation) resultsHeading.current?.focus();
    });
  }, [loading, owner, page]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && filtersOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setFiltersOpen(false);
        requestAnimationFrame(() => filtersButton.current?.focus());
        return;
      }
      if (event.key === "/" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !isEditableTarget(event.target)) {
        event.preventDefault();
        queryInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtersOpen]);

  useEffect(() => {
    const confirmed = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; action: "archive" | "mark-unread" }>).detail;
      if (!detail || detail.action !== "mark-unread") return;
      setOwnedPage((current) => current?.owner === owner ? {
        ...current,
        value: {
          ...current.value,
          items: current.value.items.map((item) => item.providerThreadId === detail.threadId
            ? { ...item, unreadCount: Math.max(1, item.unreadCount), labels: [...new Set([...item.labels, "UNREAD"])] }
            : item)
        }
      } : current);
    };
    window.addEventListener("aio:thread-command-confirmed", confirmed);
    return () => window.removeEventListener("aio:thread-command-confirmed", confirmed);
  }, [owner]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextCriteria = normalizeSearchCriteria(draftCriteria);
    if (!hasEffectiveSearch(nextCriteria)) return;
    const nextKey = searchCriteriaOwnershipKey(nextCriteria);
    if (nextKey === criteriaKey) {
      if (activeRequest.current) return;
      void load(null, 1, () => {
        setCursor(null);
        setHistory([]);
        if (selectedThreadId) navigate(searchBrowserPath(mailboxId, nextCriteria), { replace: true });
      }, true);
      return;
    }
    navigate(searchBrowserPath(mailboxId, nextCriteria));
  };

  const next = () => {
    if (!page?.nextCursor || loading) return;
    const nextCursor = page.nextCursor;
    const priorCursor = cursor;
    void load(nextCursor, pageNumber + 1, () => {
      setHistory((previous) => [...previous, priorCursor]);
      setCursor(nextCursor);
      if (selectedThreadId) navigate(searchBrowserPath(mailboxId, normalizedCriteria), { replace: true });
    }, true);
  };

  const previous = () => {
    if (!history.length || loading) return;
    const prior = history.at(-1) ?? null;
    void load(prior, Math.max(1, pageNumber - 1), () => {
      setHistory((items) => items.slice(0, -1));
      setCursor(prior);
      if (selectedThreadId) navigate(searchBrowserPath(mailboxId, normalizedCriteria), { replace: true });
    }, true);
  };

  const restart = () => {
    if (loading) return;
    void load(null, 1, () => {
      setCursor(null);
      setHistory([]);
      if (selectedThreadId) navigate(searchBrowserPath(mailboxId, normalizedCriteria), { replace: true });
    }, true);
  };

  const setField = <K extends keyof SearchFormCriteria>(field: K, value: SearchFormCriteria[K]) => setDraftCriteria((current) => ({ ...current, [field]: value }));
  const filterCount = activeFilterCount(normalizedDraft);
  const summary = hasEffectiveSearch(normalizedCriteria) ? criteriaSummary(normalizedCriteria) : null;
  const describedBy = (field: string, base?: string) => [base, error?.field === field ? "mailbox-search-error-detail" : null].filter(Boolean).join(" ") || undefined;
  const announcement = error
    ? ""
    : loading
      ? page ? `Loading page ${pendingPage ?? pageNumber}.` : "Searching Gmail."
      : page
        ? page.items.length === 0 ? "No matching conversations." : `${page.items.length} result${page.items.length === 1 ? "" : "s"} loaded on page ${pageNumber}.`
        : "Search is ready.";

  const errorAction = (problem: SearchProblem) => {
    if (problem.code === "provider_reauthentication_required") {
      return <form action="/v1/auth/google/start" method="post"><button className="button" type="submit">Reconnect Gmail</button></form>;
    }
    if (problem.code === "invalid_cursor") return <button className="button" type="button" onClick={restart}>Restart from first page</button>;
    return <button className="button" type="button" onClick={() => retryRequest.current?.()}>Try again</button>;
  };

  const form = <form className="search-form" role="search" aria-label="Search mailbox" onSubmit={submit}>
    <div className="search-form__primary">
      <label className="sr-only" htmlFor="mailbox-search-query">Search Gmail</label>
      <input ref={queryInput} id="mailbox-search-query" name="query" type="search" value={draftCriteria.query} onChange={(event) => setField("query", event.target.value)} placeholder="Search keywords or quoted phrases" maxLength={200} autoComplete="off" aria-keyshortcuts="/" aria-invalid={error?.field === "query" || undefined} aria-describedby={describedBy("query")} />
      <label className="sr-only" htmlFor="mailbox-search-scope">Search scope</label>
      <select id="mailbox-search-scope" name="scope" value={draftCriteria.scope} onChange={(event) => setField("scope", event.target.value as MailboxSearchScope)} aria-invalid={error?.field === "scope" || undefined} aria-describedby={describedBy("scope")}><option value="all">All mail</option><option value="inbox">Inbox</option><option value="sent">Sent</option><option value="drafts">Drafts</option></select>
      <button ref={filtersButton} className="button button--secondary" type="button" aria-expanded={filtersOpen} aria-controls="mailbox-search-filters" onClick={() => setFiltersOpen((open) => !open)}>Filters{filterCount ? ` (${filterCount})` : ""}</button>
      <button className="button" type="submit" disabled={!hasEffectiveSearch(draftCriteria) || (loading && !dirty)}>Search</button>
    </div>
    <div id="mailbox-search-filters" className="search-filters" hidden={!filtersOpen}>
      <label htmlFor="mailbox-search-from">From<input id="mailbox-search-from" name="from" value={draftCriteria.from} onChange={(event) => setField("from", event.target.value)} maxLength={254} autoComplete="off" aria-invalid={error?.field === "from" || undefined} aria-describedby={describedBy("from")} /></label>
      <label htmlFor="mailbox-search-to">To<input id="mailbox-search-to" name="to" value={draftCriteria.to} onChange={(event) => setField("to", event.target.value)} maxLength={254} autoComplete="off" aria-invalid={error?.field === "to" || undefined} aria-describedby={describedBy("to")} /></label>
      <label htmlFor="mailbox-search-subject">Subject<input id="mailbox-search-subject" name="subject" value={draftCriteria.subject} onChange={(event) => setField("subject", event.target.value)} maxLength={200} autoComplete="off" aria-invalid={error?.field === "subject" || undefined} aria-describedby={describedBy("subject")} /></label>
      <label htmlFor="mailbox-search-after">After<input id="mailbox-search-after" name="after" type="date" value={draftCriteria.after} onChange={(event) => setField("after", event.target.value)} aria-invalid={error?.field === "after" || undefined} aria-describedby={describedBy("after", "mailbox-search-date-note")} /></label>
      <label htmlFor="mailbox-search-before">Before<input id="mailbox-search-before" name="before" type="date" value={draftCriteria.before} onChange={(event) => setField("before", event.target.value)} aria-invalid={error?.field === "before" || undefined} aria-describedby={describedBy("before", "mailbox-search-date-note")} /></label>
      <label className="search-filter-check"><input id="mailbox-search-unread" name="unread" type="checkbox" checked={draftCriteria.unread} onChange={(event) => setField("unread", event.target.checked)} aria-invalid={error?.field === "unread" || undefined} aria-describedby={describedBy("unread")} />Unread</label>
      <label className="search-filter-check"><input id="mailbox-search-has-attachment" name="hasAttachment" type="checkbox" checked={draftCriteria.hasAttachment} onChange={(event) => setField("hasAttachment", event.target.checked)} aria-invalid={error?.field === "hasAttachment" || undefined} aria-describedby={describedBy("hasAttachment")} />Has attachment</label>
      <button type="button" className="button button--secondary" onClick={() => setDraftCriteria((current) => ({ ...current, scope: "all", from: "", to: "", subject: "", after: "", before: "", unread: false, hasAttachment: false }))}>Clear filters</button>
      <p id="mailbox-search-date-note" className="search-date-note">Gmail interprets these dates from midnight Pacific time.</p>
    </div>
    {dirty && <p className="search-summary" role="status">Search criteria changed. Press Search to apply.</p>}
    {summary && <p className="search-summary" aria-label="Applied search criteria">{summary}</p>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
  </form>;

  if (!hasEffectiveSearch(normalizedCriteria)) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state"><div><h2>Search your mailbox</h2><p>Enter keywords or choose one or more filters. Gmail remains the source of these results.</p></div></div></div></section>;
  if (loading && !page) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state"><div className="thread-skeleton" /><div className="thread-skeleton" /><span>Searching Gmail...</span></div></div></section>;
  if (error && !page) return <section className="mailbox-search"><div className="search-panel">{form}<div className="thread-list-state" role="alert"><div><h2>We could not search Gmail</h2><p id="mailbox-search-error-detail">{error.message}</p>{errorAction(error)}</div></div></div></section>;

  return <section className="mailbox-search"><div className="search-panel">{form}<section className="thread-list" aria-labelledby="mailbox-search-results-heading" aria-busy={loading}>
    <div className="thread-list__header"><h2 ref={resultsHeading} id="mailbox-search-results-heading" className="thread-list__heading" tabIndex={-1}>Search results</h2><span>From Gmail</span></div>
    {error && <div className="thread-list__retry" role="status"><span id="mailbox-search-error-detail">{error.message}</span>{errorAction(error)}</div>}
    {!page?.items.length
      ? <div className="thread-list-state"><div><h3>No matching conversations</h3><p>Gmail found no threads for this search.</p></div></div>
      : <div className="thread-list__rows" data-thread-list-rows aria-label="Search result threads">{page.items.map((thread) => <ThreadRow key={thread.id} thread={thread} selected={thread.providerThreadId === selectedThreadId} keyboardNavigation onSelect={() => navigate(searchBrowserPath(mailboxId, normalizedCriteria, thread.providerThreadId))} />)}</div>}
    <nav className="thread-list__footer pagination" aria-label="Search pagination">
      <div className="thread-list__pagination-start">{history.length > 0 && <button type="button" onClick={previous} disabled={loading}>Previous</button>}</div>
      <span>{loading ? `Loading page ${pendingPage ?? pageNumber}...` : `Page ${pageNumber}`}</span>
      <div className="thread-list__pagination-end">{page?.nextCursor && <button type="button" onClick={next} disabled={loading}>Next</button>}</div>
    </nav>
  </section></div></section>;
}
