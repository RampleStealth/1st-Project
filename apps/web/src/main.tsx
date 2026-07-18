import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { connectionHealth, type MailboxSummary } from "./mailbox-health.js";
import { ThreadList } from "./thread-list.js";
import { ThreadReader } from "./thread-reader.js";
import { DraftComposer } from "./draft-composer.js";
import { localDraftEditPath } from "./draft-navigation.js";
import { focusFirstThreadRow, focusThreadRow } from "./workspace-focus.js";
import { MailboxSearch, searchBrowserPath, searchCriteriaFromParams, searchCriteriaOwnershipKey } from "./mailbox-search.js";
import "./styles.css";

const views = [
  ["inbox", "Inbox"],
  ["all", "All Mail"],
  ["sent", "Sent"],
  ["drafts", "Drafts"]
] as const;

type LoadState = "loading" | "ready" | "disconnected" | "error";

function ConnectMailbox() {
  return <form action="/v1/auth/google/start" method="post"><button className="button" type="submit">Connect Gmail</button></form>;
}

function ConnectionBanner({ mailbox }: { mailbox: MailboxSummary }) {
  const health = connectionHealth(mailbox);
  return <section className={`health health--${health.tone}`} aria-live="polite"><div><strong>{health.title}</strong><p>{health.detail}</p></div>{health.tone === "attention" && <ConnectMailbox />}</section>;
}
function cookieValue(name: string) { return document.cookie.split("; ").find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? ""; }
function WritePermission({ mailbox }: { mailbox: MailboxSummary }) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const start = async () => { setState("loading"); try { const response = await fetch(`/v1/mailboxes/${mailbox.id}/permissions/write/start`, { method: "POST", credentials: "include", headers: { "x-csrf-token": cookieValue("aio_csrf") } }); const body = await response.json() as { authorizationUrl?: string }; if (!response.ok || !body.authorizationUrl) throw new Error(); location.assign(body.authorizationUrl); } catch { setState("failed"); } };
  useEffect(() => { const requested = () => { void start(); }; window.addEventListener("aio:request-write-permission", requested); return () => window.removeEventListener("aio:request-write-permission", requested); });
  if (mailbox.write_capability === "write_granted") return <p className="permission-note">Gmail write permission enabled.</p>;
  return <section className="permission-card"><strong>Enable Gmail actions</strong><p>Allows archive, mark unread, and creating, editing, and sending drafts. Nothing happens until you choose an action.</p>{state === "failed" && <p role="alert">We could not start permission setup. Try again.</p>}<button className="button" disabled={state === "loading"} onClick={() => void start()} type="button">{state === "loading" ? "Opening Google…" : "Review permissions"}</button></section>;
}

function Sidebar({ mailbox, selectedView }: { mailbox: MailboxSummary; selectedView: string }) {
  return <aside className="sidebar" aria-label="Mailbox navigation">
    <div className="brand"><span aria-hidden="true">✦</span> AI Email Organizer</div>
    <div className="mailbox-identity"><span className="avatar" aria-hidden="true">{mailbox.email_address.slice(0, 1).toUpperCase()}</span><span>{mailbox.email_address}</span></div>
    <nav aria-label="Mailbox views"><p className="nav-label">Mailbox</p>{views.map(([key, label]) => <NavLink key={key} className={({ isActive }) => `nav-link ${isActive || selectedView === key ? "nav-link--active" : ""}`} to={`/mail/${mailbox.id}/${key}`}>{label}</NavLink>)}<NavLink className={({ isActive }) => `nav-link ${isActive || selectedView === "search" ? "nav-link--active" : ""}`} to={`/mail/${mailbox.id}/search`}>Search</NavLink></nav>
    <div className="sidebar-footer"><span className="status-dot" aria-hidden="true" /> Gmail connected</div>
  </aside>;
}

export function Workspace({ mailbox, mode = "mailbox" }: { mailbox: MailboxSummary; mode?: "mailbox" | "search" }) {
  const { mailboxId: routeMailboxId, view = "inbox", threadId, draftId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const searchCriteria = searchCriteriaFromParams(searchParams);
  const searchMode = mode === "search";
  const selectedView = draftId ? "drafts" : views.some(([key]) => key === view) ? view : "inbox";
  const searchIdentity = searchCriteriaOwnershipKey(searchCriteria);
  const workspaceIdentity = searchMode ? `${mailbox.id}:search:${searchIdentity}` : `${mailbox.id}:${selectedView}`;
  const workspaceIdentityRef = useRef(workspaceIdentity); workspaceIdentityRef.current = workspaceIdentity;
  const lastSelectedThreadId = useRef<string | null>(null);
  useEffect(() => { if (threadId) lastSelectedThreadId.current = threadId; }, [threadId]);
  const closeReader = useCallback((afterArchive = false) => {
    const priorThreadId = lastSelectedThreadId.current;
    const focusOwner = workspaceIdentity;
    navigate(searchMode ? searchBrowserPath(mailbox.id, searchCriteria) : `/mail/${mailbox.id}/${selectedView}`);
    requestAnimationFrame(() => {
      if (workspaceIdentityRef.current !== focusOwner) return;
      if (afterArchive || !priorThreadId || !focusThreadRow(priorThreadId)) focusFirstThreadRow();
    });
  }, [mailbox.id, navigate, searchIdentity, searchMode, selectedView, workspaceIdentity]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "c" && selectedView === "drafts" && !threadId) { event.preventDefault(); document.querySelector<HTMLButtonElement>("[data-new-draft]")?.click(); }
      if (event.key === "Escape" && (threadId || draftId)) { event.preventDefault(); closeReader(); }
    };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeReader, draftId, mailbox.id, selectedView, threadId]);
  const requestWritePermission = () => window.dispatchEvent(new Event("aio:request-write-permission"));
  if (routeMailboxId !== mailbox.id) return <Navigate to={`/mail/${mailbox.id}/inbox`} replace />;
  return <div className="workspace"><a className="skip-link" href="#workspace-main">Skip to workspace</a><Sidebar mailbox={mailbox} selectedView={searchMode ? "search" : selectedView} /><main id="workspace-main" className="workspace-main"><h1 className="sr-only">Mailbox workspace</h1><ConnectionBanner mailbox={mailbox} /><WritePermission mailbox={mailbox} /><div className={`mail-layout${threadId || draftId ? " mail-layout--reader-open" : ""}`}><section className="thread-column">{searchMode ? <MailboxSearch key={workspaceIdentity} mailboxId={mailbox.id} criteria={searchCriteria} selectedThreadId={threadId} /> : <ThreadList key={workspaceIdentity} mailboxId={mailbox.id} view={selectedView} selectedThreadId={threadId} />}</section><aside className="reader-column" aria-label="Thread reader">{draftId ? <DraftComposer key={`${workspaceIdentity}:local:${draftId}`} mailboxId={mailbox.id} draftId={draftId} onPermissionRequired={requestWritePermission} /> : !searchMode && selectedView === "drafts" && !threadId ? <DraftComposer key={`${workspaceIdentity}:new`} mailboxId={mailbox.id} onPermissionRequired={requestWritePermission} /> : <ThreadReader key={`${workspaceIdentity}:thread:${threadId ?? "none"}`} mailboxId={mailbox.id} threadId={threadId} view={searchMode ? "search" : selectedView} focusOnLoad={searchMode} onArchived={() => closeReader(true)} onUnread={() => undefined} onClose={() => closeReader()} onEditDraft={(localDraftId) => navigate(localDraftEditPath(mailbox.id, localDraftId))} onPermissionRequired={requestWritePermission} />}</aside></div></main></div>;
}

function App() {
  const [state, setState] = useState<LoadState>("loading");
  const [mailbox, setMailbox] = useState<MailboxSummary | null>(null);
  const navigate = useNavigate();
  const load = async () => {
    setState("loading");
    try {
      const response = await fetch("/v1/mailboxes", { credentials: "include" });
      if (response.status === 401) { setMailbox(null); setState("disconnected"); return; }
      if (!response.ok) throw new Error("mailbox_request_failed");
      const mailboxes = await response.json() as MailboxSummary[];
      if (!mailboxes[0]) { setMailbox(null); setState("disconnected"); return; }
      setMailbox(mailboxes[0]);
      setState("ready");
    } catch { setState("error"); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (state === "ready" && mailbox && location.pathname === "/") navigate(`/mail/${mailbox.id}/inbox`, { replace: true }); }, [mailbox, navigate, state]);
  if (state === "loading") return <main className="center-state" aria-live="polite"><div className="loading-mark" aria-hidden="true" /><h1>Loading your workspace</h1><p>Checking your Gmail connection.</p></main>;
  if (state === "error") return <main className="center-state"><div><p className="eyebrow">Connection problem</p><h1>We could not load your mailbox</h1><p>Check your connection and try again.</p><button className="button" type="button" onClick={() => void load()}>Try again</button></div></main>;
  if (state === "disconnected" || !mailbox) return <main className="center-state"><div><p className="eyebrow">Gmail connection</p><h1>Connect Gmail to start</h1><p>Your mailbox workspace appears here after you connect a Gmail account.</p><ConnectMailbox /></div></main>;
  return <Routes><Route path="/mail/:mailboxId/search" element={<Workspace mailbox={mailbox} mode="search" />} /><Route path="/mail/:mailboxId/search/:threadId" element={<Workspace mailbox={mailbox} mode="search" />} /><Route path="/mail/:mailboxId/drafts/local/:draftId" element={<Workspace mailbox={mailbox} />} /><Route path="/mail/:mailboxId/:view" element={<Workspace mailbox={mailbox} />} /><Route path="/mail/:mailboxId/:view/:threadId" element={<Workspace mailbox={mailbox} />} /><Route path="*" element={<Navigate to={`/mail/${mailbox.id}/inbox`} replace />} /></Routes>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
