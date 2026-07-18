import { useEffect, useRef, useState } from "react";

type Command = { id: string; status: "pending" | "running" | "succeeded" | "retryable" | "failed" | "recovery_required"; draftId: string; action: "create" | "update" | "send"; failureCode?: string | null };
type Draft = { id: string; status: string; revision: number; confirmedRevision: number | null; to: string[]; cc: string[]; bcc: string[]; subject: string; plainText: string; html: string | null; editable?: boolean; writeGranted?: boolean; canVerifySend?: boolean };
type State = "idle" | "editing" | "creating" | "saving" | "sending" | "verifying" | "loading" | "ready" | "sent" | "failed" | "permission" | "reauth" | "stale" | "conflict" | "recovery";
const csrf = () => document.cookie.split("; ").find((item) => item.startsWith("aio_csrf="))?.slice(9) ?? "";
const addresses = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

export function DraftComposer({ mailboxId, draftId: persistedDraftId, onPermissionRequired }: { mailboxId: string; draftId?: string; onPermissionRequired?: () => void }) {
  const [state, setState] = useState<State>(persistedDraftId ? "loading" : "idle"); const [command, setCommand] = useState<Command | null>(null); const [draft, setDraft] = useState<Draft | null>(null);
  const [to, setTo] = useState(""); const [cc, setCc] = useState(""); const [bcc, setBcc] = useState(""); const [subject, setSubject] = useState(""); const [plainText, setPlainText] = useState(""); const [html, setHtml] = useState("");
  const [confirmedEditorValue, setConfirmedEditorValue] = useState("");
  const loadGeneration = useRef(0);
  const activeCommandId = useRef<string | null>(null);
  const sentCommandIds = useRef(new Set<string>());
  const sentTerminal = useRef(false);
  const loadDraft = async (draftId: string) => {
    const generation = ++loadGeneration.current;
    setState("loading");
    try {
      const response = await fetch(`/v1/mailboxes/${mailboxId}/drafts/${draftId}`, { credentials: "include" });
      const value = response.ok ? await response.json() as Draft : null;
      if (generation !== loadGeneration.current || sentTerminal.current) return;
      if (!value) { setState("failed"); return; }
      setDraft(value); setTo(value.to.join(", ")); setCc(value.cc.join(", ")); setBcc(value.bcc.join(", ")); setSubject(value.subject); setPlainText(value.plainText); setHtml(value.html ?? ""); setConfirmedEditorValue(JSON.stringify([value.to, value.cc, value.bcc, value.subject, value.plainText, value.html ?? ""])); setCommand(null);
      activeCommandId.current = null;
      if (value.status === "sent") { sentTerminal.current = true; setState("sent"); return; }
      if (persistedDraftId && value.editable !== true) { setState("failed"); return; }
      if (persistedDraftId && value.writeGranted === false) { setState("permission"); return; }
      setState(value.status === "sent" ? "sent" : value.status === "conflict" ? "conflict" : value.status === "recovery_required" ? "recovery" : value.status === "ready" ? "ready" : "failed");
    } catch {
      if (generation === loadGeneration.current) setState("failed");
    }
  };
  useEffect(() => {
    if (!persistedDraftId) return;
    void loadDraft(persistedDraftId);
    return () => { loadGeneration.current += 1; };
  }, [mailboxId, persistedDraftId]);
  useEffect(() => { if (!command || !["pending", "running", "retryable"].includes(command.status)) return; const commandId = command.id; const timer = setTimeout(() => void Promise.resolve(fetch(`/v1/mailboxes/${mailboxId}/provider-commands/${commandId}`, { credentials: "include" })).then((response) => response?.ok ? response.json() : null).then((value) => { if (activeCommandId.current !== commandId || sentTerminal.current) return; if (!value) { setState("failed"); return; } if (["failed", "recovery_required"].includes(value.status) && value.failureCode === "write_scope_required") { setCommand((current) => current?.id === commandId ? { ...current, status: value.status, failureCode: value.failureCode } : current); setState("permission"); return; } if (["failed", "recovery_required"].includes(value.status) && value.failureCode === "reauthorization_required") { setCommand((current) => current?.id === commandId ? { ...current, status: value.status, failureCode: value.failureCode } : current); setState("reauth"); return; } if (value.status === "recovery_required") { setCommand((current) => current?.id === commandId ? { ...current, status: value.status, failureCode: value.failureCode } : current); setState("recovery"); return; } if (value.status === "failed" && value.failureCode === "external_draft_conflict") { setCommand((current) => current?.id === commandId ? { ...current, status: value.status, failureCode: value.failureCode } : current); setState("conflict"); return; } setCommand((current) => current?.id === commandId ? { ...current, status: value.status, failureCode: value.failureCode } : current); }).catch(() => { if (activeCommandId.current === commandId && !sentTerminal.current) setState("failed"); }), 800); return () => clearTimeout(timer); }, [command, mailboxId]);
  useEffect(() => {
    if (!command || command.status !== "succeeded") return;
    if (command.action === "send") {
      if (sentCommandIds.current.has(command.id)) return;
      sentCommandIds.current.add(command.id);
      sentTerminal.current = true;
      activeCommandId.current = null;
      loadGeneration.current += 1;
      setDraft((current) => current ? { ...current, status: "sent" } : current);
      setCommand(null);
      setState("sent");
      return;
    }
    void loadDraft(command.draftId);
  }, [command, mailboxId]);
  const setActiveCommand = (next: Command) => { activeCommandId.current = next.id; setCommand(next); };
  const create = async () => { if (state !== "editing" || command) return; setState("creating"); const response = await fetch(`/v1/mailboxes/${mailboxId}/drafts`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf(), "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ to: addresses(to), cc: addresses(cc), bcc: addresses(bcc), subject, plainText, html: html || null }) }); const body = await response.json().catch(() => null); if (response.status === 409 && body?.code === "permission_required") { setState("permission"); return; } if (response.status === 409 && body?.code === "provider_reauthentication_required") { setState("reauth"); return; } if (!response.ok || !body?.id || !body?.draftId) { setState("failed"); return; } setActiveCommand({ id: body.id, draftId: body.draftId, status: body.status, action: "create" }); };
  const save = async () => { if (!draft || state !== "ready" || command) return; setState("saving"); const response = await fetch(`/v1/mailboxes/${mailboxId}/drafts/${draft.id}`, { method: "PUT", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf(), "idempotency-key": crypto.randomUUID(), "if-match": `"${draft.revision}"` }, body: JSON.stringify({ to: addresses(to), cc: addresses(cc), bcc: addresses(bcc), subject, plainText, html: html || null }) }); const body = await response.json().catch(() => null); if (response.status === 409 && body?.code === "permission_required") { setState("permission"); return; } if (response.status === 409 && body?.code === "provider_reauthentication_required") { setState("reauth"); return; } if (response.status === 409 && body?.code === "draft_revision_conflict") { setState("stale"); return; } if (!response.ok || !body?.id || !body?.draftId) { setState("failed"); return; } setActiveCommand({ id: body.id, draftId: body.draftId, status: body.status, action: "update" }); };
  const send = async () => { if (!draft || state !== "ready" || command || dirty || draft.status !== "ready" || draft.revision !== draft.confirmedRevision) return; setState("sending"); const response = await fetch(`/v1/mailboxes/${mailboxId}/drafts/${draft.id}/send`, { method: "POST", credentials: "include", headers: { "x-csrf-token": csrf(), "idempotency-key": crypto.randomUUID(), "if-match": `"${draft.revision}"` } }); const body = await response.json().catch(() => null); if (response.status === 409 && body?.code === "permission_required") { setState("permission"); return; } if (response.status === 409 && body?.code === "provider_reauthentication_required") { setState("reauth"); return; } if (response.status === 409 && body?.code === "external_draft_conflict") { setState("conflict"); return; } if (!response.ok || !body?.id || !body?.draftId) { setState("failed"); return; } setActiveCommand({ id: body.id, draftId: body.draftId, status: body.status, action: "send" }); };
  const verifySend = async () => { if (!draft || (!draft.canVerifySend && command?.action !== "send")) return; setState("verifying"); const response = await fetch(`/v1/mailboxes/${mailboxId}/drafts/${draft.id}/send-verification`, { method: "POST", credentials: "include", headers: { "x-csrf-token": csrf() } }); const body = await response.json().catch(() => null); if (!response.ok || !body?.id) { setState("recovery"); return; } setActiveCommand({ id: body.id, draftId: draft.id, status: "running", action: "send" }); };
  const dirty = Boolean(draft) && JSON.stringify([addresses(to), addresses(cc), addresses(bcc), subject, plainText, html]) !== confirmedEditorValue;
  const editor = (saving: boolean) => <section className="draft-composer" aria-label="Draft editor">{draft && !saving && <p role="status">Draft ready</p>}<label>To<input value={to} onChange={(event) => setTo(event.target.value)} /></label><label>Cc<input value={cc} onChange={(event) => setCc(event.target.value)} /></label><label>Bcc<input value={bcc} onChange={(event) => setBcc(event.target.value)} /></label><label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label>Message<textarea value={plainText} onChange={(event) => setPlainText(event.target.value)} /></label><label>HTML (optional)<textarea value={html} onChange={(event) => setHtml(event.target.value)} /></label><button className="button" disabled={saving} type="button" onClick={() => void (draft ? save() : create())}>{saving ? "Saving draft..." : draft ? "Save draft" : "Create draft"}</button>{draft && <button className="button" disabled={saving || dirty || draft.status !== "ready" || draft.revision !== draft.confirmedRevision} type="button" onClick={() => void send()}>Send</button>}</section>;
  if (state === "idle" && persistedDraftId) return <section className="draft-composer" role="status"><p>This draft is unavailable for editing.</p><button type="button" onClick={() => void loadDraft(persistedDraftId)}>Try again</button></section>;
  if (state === "idle") return <section className="draft-composer"><button data-new-draft className="button" type="button" onClick={() => setState("editing")}>New draft</button><p>Drafts are created in Gmail before they are shown here.</p></section>;
  if (state === "permission") return <section className="draft-composer" role="status"><p>Gmail write permission is required to save this draft.</p><button className="button" type="button" onClick={onPermissionRequired}>Enable Gmail actions</button></section>;
  if (state === "reauth") return <section className="draft-composer" role="status"><p>Reconnect Gmail before saving this draft.</p><form action="/v1/auth/google/start" method="post"><button className="button" type="submit">Reconnect Gmail</button></form></section>;
  if (state === "stale") return <section className="draft-composer" role="status"><p>This draft changed before it could be saved. Reload it before trying again.</p><button type="button" onClick={() => draft && void loadDraft(draft.id)}>Reload draft</button></section>;
  if (state === "conflict") return <section className="draft-composer" role="status"><p>This draft changed in Gmail. We did not overwrite it.</p><button type="button" onClick={() => draft && void loadDraft(draft.id)}>Reload draft</button></section>;
  if (state === "recovery") return <section className="draft-composer" role="status"><p>Gmail needs verification before this {command?.action === "send" || draft?.canVerifySend ? "send" : "save"} can be confirmed. It will not be resent automatically.</p>{(command?.action === "send" || draft?.canVerifySend) && <button type="button" onClick={() => void verifySend()}>Check Gmail status</button>}<button type="button" onClick={() => setCommand(null)}>Dismiss</button></section>;
  if (state === "sent") return <section className="draft-composer" role="status"><p>Sent</p></section>;
  if (state === "failed" || command?.status === "failed") return <section className="draft-composer" role="status"><p>{persistedDraftId && !draft ? "We could not load this draft safely." : "We could not save this draft. Your last confirmed version is unchanged."}</p><button type="button" onClick={() => { setCommand(null); if (persistedDraftId && !draft) void loadDraft(persistedDraftId); else setState(draft ? "ready" : "idle"); }}>{persistedDraftId && !draft ? "Try again" : "Dismiss"}</button></section>;
  if (command && ["pending", "running", "retryable"].includes(command.status)) return <section className="draft-composer" aria-live="polite"><p>{command.status === "retryable" ? `${command.action === "send" ? "Sending" : "Saving draft"} will retry...` : command.action === "send" ? "Sending..." : command.action === "update" ? "Saving draft..." : "Creating draft..."}</p></section>;
  if (state === "editing") return editor(false);
  if (state === "ready" && draft) return editor(false);
  if (state === "saving") return editor(true);
  return <section className="draft-composer" aria-live="polite"><p>{state === "verifying" ? "Checking Gmail status..." : command?.action === "send" ? "Sending..." : command?.action === "update" ? "Saving draft..." : "Creating draft..."}</p></section>;
}
