import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { connectionHealth, type MailboxSummary } from "./mailbox-health.js";
import { ThreadList } from "./thread-list.js";
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

function Sidebar({ mailbox, selectedView }: { mailbox: MailboxSummary; selectedView: string }) {
  return <aside className="sidebar" aria-label="Mailbox navigation">
    <div className="brand"><span aria-hidden="true">✦</span> AI Email Organizer</div>
    <div className="mailbox-identity"><span className="avatar" aria-hidden="true">{mailbox.email_address.slice(0, 1).toUpperCase()}</span><span>{mailbox.email_address}</span></div>
    <nav aria-label="Mailbox views"><p className="nav-label">Mailbox</p>{views.map(([key, label]) => <NavLink key={key} className={({ isActive }) => `nav-link ${isActive || selectedView === key ? "nav-link--active" : ""}`} to={`/mail/${mailbox.id}/${key}`}>{label}</NavLink>)}</nav>
    <div className="sidebar-footer"><span className="status-dot" aria-hidden="true" /> Gmail connected</div>
  </aside>;
}

function Workspace({ mailbox }: { mailbox: MailboxSummary }) {
  const { view = "inbox" } = useParams();
  const selectedView = views.some(([key]) => key === view) ? view : "inbox";
  return <div className="workspace"><a className="skip-link" href="#workspace-main">Skip to workspace</a><Sidebar mailbox={mailbox} selectedView={selectedView} /><main id="workspace-main" className="workspace-main"><ConnectionBanner mailbox={mailbox} /><div className="mail-layout"><section className="thread-column"><ThreadList mailboxId={mailbox.id} view={selectedView} /></section><aside className="reader-column" aria-label="Thread reader"><div className="reader-empty"><span aria-hidden="true">⌁</span><h2>Select a conversation</h2><p>Choose a thread from the list to read it.</p></div></aside></div></main></div>;
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
  return <Routes><Route path="/mail/:mailboxId/:view" element={<Workspace mailbox={mailbox} />} /><Route path="/mail/:mailboxId/:view/:threadId" element={<Workspace mailbox={mailbox} />} /><Route path="*" element={<Navigate to={`/mail/${mailbox.id}/inbox`} replace />} /></Routes>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
