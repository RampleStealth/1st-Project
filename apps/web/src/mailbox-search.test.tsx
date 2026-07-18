import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MailboxSearch } from "./mailbox-search.js";
import { ThreadReader } from "./thread-reader.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function item(id: string, labels = ["INBOX"], unreadCount = 0) { return { id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`, providerThreadId: `thread-${id}`, subject: `Subject ${id}`, latestSender: `Sender ${id}`, preview: `Preview ${id}`, lastMessageAt: null, unreadCount, messageCount: 1, hasAttachments: false, hasDraft: labels.includes("DRAFT"), labels }; }
function page(items: ReturnType<typeof item>[], nextCursor: string | null = null) { return { items, nextCursor, source: "gmail_search" as const, fetchedAt: new Date().toISOString() }; }
function response(value: unknown, ok = true, status = 200) { return { ok, status, json: async () => value } as Response; }
function thread(id: string, labels = ["INBOX"]) { return { id, messages: [{ id: `${id}-message`, from: "Sender", to: [], cc: [], bcc: [], labels, subject: `Subject ${id.replace("thread-", "")}`, sentAt: null, attachments: [], plainText: "Body", sanitizedHtml: null, renderingState: "ready" }] }; }

function SearchRoute() {
  const { threadId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const query = params.get("q") ?? "";
  return <><button type="button" onClick={() => navigate(-1)}>Back</button><button type="button" onClick={() => navigate(1)}>Forward</button><MailboxSearch mailboxId="mailbox" query={query} selectedThreadId={threadId} />{threadId && <ThreadReader mailboxId="mailbox" threadId={threadId} view="search" />}</>;
}
function routed(initialEntries = ["/mail/mailbox/search"]) { return <MemoryRouter initialEntries={initialEntries}><Routes><Route path="/mail/:mailboxId/search" element={<SearchRoute />} /><Route path="/mail/:mailboxId/search/:threadId" element={<SearchRoute />} /></Routes></MemoryRouter>; }

describe("provider-backed mailbox search", () => {
  it("does not call Gmail or the application API until an explicit search is submitted", async () => {
    const fetch = vi.fn(async () => response(page([])));
    vi.stubGlobal("fetch", fetch);
    render(routed());
    expect(screen.getByRole("heading", { name: "Search your mailbox" })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Gmail" }), { target: { value: "invoice" } });
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("heading", { name: "No matching conversations" })).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/^\/v1\/mailboxes\/mailbox\/search\?/);
    expect(String(fetch.mock.calls[0][0])).not.toContain("googleapis.com");
  });

  it("hard-refreshes into Search, keeps the row while opening it, and preserves the query", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return url.includes("/search?") ? response(page([item("1")])) : response(thread("thread-1"));
    }));
    render(routed(["/mail/mailbox/search?q=unique-token"]));
    const row = await screen.findByLabelText("Subject 1 from Sender 1");
    fireEvent.click(row);
    expect(await screen.findByRole("heading", { name: "Subject 1" })).toBeTruthy();
    expect(screen.getByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search Gmail" })).toHaveProperty("value", "unique-token");
    expect(urls.every((url) => url.startsWith("/v1/"))).toBe(true);
  });

  it("rejects a late result from an older query after ownership changes", async () => {
    const alpha = deferred<Response>(); const beta = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("query=alpha") ? alpha.promise : beta.promise));
    const rendered = render(<MemoryRouter><MailboxSearch mailboxId="mailbox" query="alpha" /></MemoryRouter>);
    rendered.rerender(<MemoryRouter><MailboxSearch mailboxId="mailbox" query="beta" /></MemoryRouter>);
    await act(async () => beta.resolve(response(page([item("2")]))));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    await act(async () => alpha.resolve(response(page([item("1")]))));
    expect(screen.getByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    expect(screen.queryByLabelText("Subject 1 from Sender 1")).toBeNull();
  });

  it("keeps cursor history inside the current query and disables controls while loading", async () => {
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("cursor=next") ? second.promise : Promise.resolve(response(page([item("1")], "next")))));
    render(<MemoryRouter><MailboxSearch mailboxId="mailbox" query="invoice" /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Next" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
    await act(async () => second.resolve(response(page([item("2")]))));
    expect(await screen.findByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
  });

  it("preserves archived Search rows and applies confirmed unread only to the matching result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page([item("1", ["INBOX", "STARRED"]), item("2", ["INBOX"])]))));
    render(<MemoryRouter><MailboxSearch mailboxId="mailbox" query="invoice" /></MemoryRouter>);
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    act(() => window.dispatchEvent(new CustomEvent("aio:thread-command-confirmed", { detail: { threadId: "thread-1", action: "archive" } })));
    expect(screen.getByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    act(() => window.dispatchEvent(new CustomEvent("aio:thread-command-confirmed", { detail: { threadId: "thread-1", action: "mark-unread" } })));
    expect(screen.getByLabelText("1 unread messages")).toBeTruthy();
    expect(screen.getAllByLabelText(/unread messages/)).toHaveLength(1);
  });

  it("restores query ownership through browser history without replaying prior results", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(page([url.includes("query=alpha") ? item("1") : item("2")]))));
    render(routed(["/mail/mailbox/search?q=alpha"]));
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Gmail" }), { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
  });

  it("derives Search toolbar capabilities from provider labels", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(thread("inbox-thread", ["INBOX"]))));
    const rendered = render(<ThreadReader mailboxId="mailbox" threadId="inbox-thread" view="search" />);
    expect(await screen.findByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark unread" })).toBeTruthy();
    vi.stubGlobal("fetch", vi.fn(async () => response(thread("draft-thread", ["DRAFT"]))));
    rendered.rerender(<ThreadReader mailboxId="mailbox" threadId="draft-thread" view="search" />);
    expect(await screen.findByRole("heading", { name: "Subject draft-thread" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark unread" })).toBeNull();
  });
});
