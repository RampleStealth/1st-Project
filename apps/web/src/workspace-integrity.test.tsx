import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThreadList } from "./thread-list.js";
import { ThreadReader } from "./thread-reader.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function page(view: "inbox" | "drafts", nextCursor: string | null = null) {
  const name = view === "inbox" ? "Inbox message" : "Application draft";
  return { source: "gmail" as const, fetchedAt: new Date().toISOString(), nextCursor, items: [{ id: `${view}-id`, providerThreadId: `${view}-thread`, subject: name, latestSender: view, preview: name, lastMessageAt: null, unreadCount: 0, messageCount: 1, hasAttachments: false, hasDraft: view === "drafts", labels: [view === "drafts" ? "DRAFT" : "INBOX"] }] };
}

const thread = (id: string) => ({ id, messages: [{ id: `${id}-message`, from: "Sender", to: [], subject: id, sentAt: null, attachments: [], plainText: id, sanitizedHtml: null, renderingState: "ready" }] });
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value } as Response);
const list = (view: string) => <MemoryRouter><ThreadList mailboxId="mailbox" view={view} /></MemoryRouter>;

function RoutedWorkspace() {
  const { view = "inbox", threadId } = useParams();
  const navigate = useNavigate();
  const owner = `mailbox:${view}`;
  return <><button onClick={() => navigate(-1)}>History back</button><button onClick={() => navigate(1)}>History forward</button><ThreadList key={owner} mailboxId="mailbox" view={view} selectedThreadId={threadId} /><ThreadReader key={`${owner}:${threadId ?? "none"}`} mailboxId="mailbox" view={view} threadId={threadId} /></>;
}

function routed(initialEntries: string[], initialIndex = 0) {
  return <MemoryRouter initialEntries={initialEntries} initialIndex={initialIndex}><Routes><Route path="/mail/:mailboxId/:view/:threadId?" element={<RoutedWorkspace />} /></Routes></MemoryRouter>;
}

describe("workspace identity integrity", () => {
  it("initializes a hard-refreshed Drafts route with Draft-owned list, selection, and toolbar", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/threads?")) return Promise.resolve(response(page(url.includes("view=drafts") ? "drafts" : "inbox")));
      if (url.includes("draft-edit-eligibility")) return Promise.resolve(response({ editable: false }));
      return Promise.resolve(response(thread("drafts-thread")));
    }));
    render(routed(["/mail/mailbox/drafts/drafts-thread"]));
    expect(await screen.findByLabelText("Application draft from drafts")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "drafts-thread" })).toBeTruthy();
    expect(screen.queryByLabelText("Inbox message from inbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark unread" })).toBeNull();
  });

  it("browser back and forward restore the list, selection, and toolbar for the route-owned workspace", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/threads?")) return Promise.resolve(response(page(url.includes("view=drafts") ? "drafts" : "inbox")));
      if (url.includes("draft-edit-eligibility")) return Promise.resolve(response({ editable: false }));
      return Promise.resolve(response(thread("drafts-thread")));
    }));
    render(routed(["/mail/mailbox/inbox", "/mail/mailbox/drafts/drafts-thread"], 1));
    expect(await screen.findByLabelText("Application draft from drafts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    expect(await screen.findByLabelText("Inbox message from inbox")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Select a conversation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "History forward" }));
    expect(await screen.findByLabelText("Application draft from drafts")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "drafts-thread" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("ignores an Inbox response that completes after Drafts owns the list", async () => {
    const inbox = deferred<Response>(); const drafts = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("view=drafts") ? drafts.promise : inbox.promise));
    const rendered = render(list("inbox"));
    rendered.rerender(list("drafts"));
    await act(async () => drafts.resolve(response(page("drafts"))));
    expect(await screen.findByLabelText("Application draft from drafts")).toBeTruthy();
    await act(async () => inbox.resolve(response(page("inbox"))));
    expect(screen.getByLabelText("Application draft from drafts")).toBeTruthy();
    expect(screen.queryByLabelText("Inbox message from inbox")).toBeNull();
  });

  it("ignores a Drafts response that completes after Inbox owns the list", async () => {
    const inbox = deferred<Response>(); const drafts = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("view=drafts") ? drafts.promise : inbox.promise));
    const rendered = render(list("drafts"));
    rendered.rerender(list("inbox"));
    await act(async () => inbox.resolve(response(page("inbox"))));
    expect(await screen.findByLabelText("Inbox message from inbox")).toBeTruthy();
    await act(async () => drafts.resolve(response(page("drafts"))));
    expect(screen.getByLabelText("Inbox message from inbox")).toBeTruthy();
    expect(screen.queryByLabelText("Application draft from drafts")).toBeNull();
  });

  it("clears rows, pagination, and errors immediately when workspace ownership changes", async () => {
    const drafts = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("view=drafts") ? drafts.promise : Promise.resolve(response(page("inbox", "next")))));
    const rendered = render(list("inbox"));
    expect(await screen.findByLabelText("Inbox message from inbox")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    rendered.rerender(list("drafts"));
    expect(screen.queryByLabelText("Inbox message from inbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByText("Loading Gmail threads…")).toBeTruthy();
    await act(async () => drafts.resolve(response(page("drafts"))));
  });

  it("derives toolbar actions from the current workspace and never carries Draft eligibility across views", async () => {
    const eligibility = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("draft-edit-eligibility") ? eligibility.promise : Promise.resolve(response(thread("shared-thread")))));
    const rendered = render(<ThreadReader mailboxId="mailbox" threadId="shared-thread" view="inbox" />);
    expect(await screen.findByRole("button", { name: "Archive" })).toBeTruthy();
    rendered.rerender(<ThreadReader mailboxId="mailbox" threadId="shared-thread" view="drafts" />);
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark unread" })).toBeNull();
    await act(async () => eligibility.resolve(response({ editable: true, draftId: "local-draft", writeGranted: true })));
    expect(await screen.findByRole("button", { name: "Edit draft" })).toBeTruthy();
    rendered.rerender(<ThreadReader mailboxId="mailbox" threadId="shared-thread" view="inbox" />);
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Archive" })).toBeTruthy();
  });

  it("does not render a late reader or eligibility result for a newly selected thread", async () => {
    const firstThread = deferred<Response>(); const firstEligibility = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("first/draft-edit")) return firstEligibility.promise;
      if (url.endsWith("/first")) return firstThread.promise;
      if (url.includes("draft-edit-eligibility")) return Promise.resolve(response({ editable: false }));
      return Promise.resolve(response(thread("second")));
    }));
    const rendered = render(<ThreadReader mailboxId="mailbox" threadId="first" view="drafts" />);
    rendered.rerender(<ThreadReader mailboxId="mailbox" threadId="second" view="drafts" />);
    expect(await screen.findByRole("heading", { name: "second" })).toBeTruthy();
    await act(async () => { firstThread.resolve(response(thread("first"))); firstEligibility.resolve(response({ editable: true, draftId: "wrong", writeGranted: true })); });
    expect(screen.getByRole("heading", { name: "second" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "first" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
  });
});
