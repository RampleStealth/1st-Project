import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MailboxSearch, searchCriteriaFromParams, type SearchFormCriteria } from "./mailbox-search.js";
import { ThreadReader } from "./thread-reader.js";
import { focusThreadRow } from "./workspace-focus.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function item(id: string, labels = ["INBOX"], unreadCount = 0) { return { id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`, providerThreadId: `thread-${id}`, subject: `Subject ${id}`, latestSender: `Sender ${id}`, preview: `Preview ${id}`, lastMessageAt: null, unreadCount, messageCount: 1, hasAttachments: false, hasDraft: labels.includes("DRAFT"), labels }; }
function page(items: ReturnType<typeof item>[], nextCursor: string | null = null) { return { items, nextCursor, source: "gmail_search" as const, fetchedAt: new Date().toISOString() }; }
function response(value: unknown, ok = true, status = 200) { return { ok, status, json: async () => value } as Response; }
function thread(id: string, labels = ["INBOX"]) { return { id, messages: [{ id: `${id}-message`, from: "Sender", to: [], cc: [], bcc: [], labels, subject: `Subject ${id.replace("thread-", "")}`, sentAt: null, attachments: [], plainText: "Body", sanitizedHtml: null, renderingState: "ready" }] }; }
function criteria(overrides: Partial<SearchFormCriteria> = {}): SearchFormCriteria { return { query: "invoice", scope: "all", from: "", to: "", subject: "", after: "", before: "", unread: false, hasAttachment: false, ...overrides }; }

function SearchRoute() {
  const { threadId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const searchCriteria = searchCriteriaFromParams(params);
  return <><button type="button" onClick={() => navigate(-1)}>Back</button><button type="button" onClick={() => navigate(1)}>Forward</button><MailboxSearch mailboxId="mailbox" criteria={searchCriteria} selectedThreadId={threadId} />{threadId && <ThreadReader mailboxId="mailbox" threadId={threadId} view="search" focusOnLoad onClose={() => { navigate(-1); requestAnimationFrame(() => focusThreadRow(threadId)); }} />}</>;
}
function routed(initialEntries = ["/mail/mailbox/search"]) { return <MemoryRouter initialEntries={initialEntries}><Routes><Route path="/mail/:mailboxId/search" element={<SearchRoute />} /><Route path="/mail/:mailboxId/search/:threadId" element={<SearchRoute />} /></Routes></MemoryRouter>; }

describe("provider-backed mailbox search", () => {
  it("exposes named Search semantics, an unapplied-criteria state, and the slash focus shortcut", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page([]))));
    render(routed());
    const form = screen.getByRole("search", { name: "Search mailbox" });
    const input = screen.getByRole("searchbox", { name: "Search Gmail" });
    expect(form).toBeTruthy();
    expect(input.getAttribute("aria-keyshortcuts")).toBe("/");
    screen.getByRole("button", { name: "Back" }).focus();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "invoice" } });
    expect(screen.getByText("Search criteria changed. Press Search to apply.").getAttribute("role")).toBe("status");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("closes filters with Escape, restores disclosure focus, and describes Gmail date semantics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page([]))));
    render(routed());
    const filters = screen.getByRole("button", { name: "Filters" });
    fireEvent.click(filters);
    const after = screen.getByLabelText("After");
    expect(after.getAttribute("aria-describedby")).toContain("mailbox-search-date-note");
    after.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(filters.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(filters));
  });

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

  it("submits filters explicitly and supports a filter-only search", async () => {
    const fetch = vi.fn(async () => response(page([])));
    vi.stubGlobal("fetch", fetch);
    render(routed());
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "  Billing   Team " } });
    fireEvent.change(screen.getByLabelText("After"), { target: { value: "2026-07-01" } });
    fireEvent.click(screen.getByLabelText("Unread"));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("Search criteria changed. Press Search to apply.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("heading", { name: "No matching conversations" })).toBeTruthy();
    expect(screen.getByLabelText("Applied search criteria").textContent).toContain("From Billing Team");
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain("from=Billing+Team");
    expect(url).toContain("after=2026-07-01");
    expect(url).toContain("unread=true");
    expect(url).not.toContain("query=");
    expect(url).not.toContain("googleapis.com");
  });

  it("restores structured filters on refresh and preserves them while opening a result", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { urls.push(url); return url.includes("/search?") ? response(page([item("1")])) : response(thread("thread-1")); }));
    render(routed(["/mail/mailbox/search?q=invoice&scope=inbox&from=billing%40example.test&unread=true&hasAttachment=true"]));
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Search scope" })).toHaveProperty("value", "inbox");
    fireEvent.click(screen.getByRole("button", { name: "Filters (4)" }));
    expect(screen.getByLabelText("From")).toHaveProperty("value", "billing@example.test");
    expect(screen.getByLabelText("Unread")).toHaveProperty("checked", true);
    expect(screen.getByLabelText("Has attachment")).toHaveProperty("checked", true);
    fireEvent.click(screen.getByLabelText("Subject 1 from Sender 1"));
    expect(await screen.findByRole("heading", { name: "Subject 1" })).toBeTruthy();
    expect(screen.getByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    expect(urls.every((url) => url.startsWith("/v1/"))).toBe(true);
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
    const rendered = render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria({ query: "alpha" })} /></MemoryRouter>);
    rendered.rerender(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria({ query: "beta" })} /></MemoryRouter>);
    await act(async () => beta.resolve(response(page([item("2")]))));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    await act(async () => alpha.resolve(response(page([item("1")]))));
    expect(screen.getByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    expect(screen.queryByLabelText("Subject 1 from Sender 1")).toBeNull();
  });

  it("rejects a late result after structured filter ownership changes", async () => {
    const inbox = deferred<Response>(); const sent = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("scope=inbox") ? inbox.promise : sent.promise));
    const rendered = render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria({ query: "", scope: "inbox" })} /></MemoryRouter>);
    rendered.rerender(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria({ query: "", scope: "sent" })} /></MemoryRouter>);
    await act(async () => sent.resolve(response(page([item("2", ["SENT"])]))));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    await act(async () => inbox.resolve(response(page([item("1")]))));
    expect(screen.queryByLabelText("Subject 1 from Sender 1")).toBeNull();
  });

  it("keeps cursor history inside the current query and disables controls while loading", async () => {
    const second = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("cursor=next") ? second.promise : Promise.resolve(response(page([item("1")], "next")))));
    render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria()} /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Next" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
    await act(async () => second.resolve(response(page([item("2")]))));
    expect(await screen.findByRole("button", { name: "Previous" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Search results" })));
    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
  });

  it("keeps failed pagination uncommitted and restarts an expired cursor from page one", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(page([item("1")], "expired")))
      .mockResolvedValueOnce(response({ code: "invalid_cursor", message: "This search page is no longer valid. Run the search again." }, false, 400))
      .mockResolvedValueOnce(response(page([item("2")])));
    vi.stubGlobal("fetch", fetch);
    render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("button", { name: "Restart from first page" })).toBeTruthy();
    expect(screen.getByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restart from first page" }));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    expect(String(fetch.mock.calls[2][0])).not.toContain("cursor=");
  });

  it("clears a selected reader only after a new Search page is confirmed", async () => {
    const nextPage = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/threads/thread-1")) return Promise.resolve(response(thread("thread-1")));
      if (url.includes("cursor=next")) return nextPage.promise;
      return Promise.resolve(response(page([item("1")], "next")));
    }));
    render(routed(["/mail/mailbox/search/thread-1?q=invoice"]));
    expect(await screen.findByRole("button", { name: "Back to list" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Back to list" })).toBeTruthy();
    await act(async () => nextPage.resolve(response(page([item("2")]))));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to list" })).toBeNull();
  });

  it("refreshes page one when unchanged criteria are explicitly resubmitted", async () => {
    const refreshed = deferred<Response>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(page([item("1")], "next")))
      .mockImplementationOnce(() => refreshed.promise);
    vi.stubGlobal("fetch", fetch);
    render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria()} /></MemoryRouter>);
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).toHaveProperty("disabled", true));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => refreshed.resolve(response(page([item("2")]))));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    expect(String(fetch.mock.calls[1][0])).not.toContain("cursor=");
  });

  it("supports row-local arrow navigation without opening or submitting a result", async () => {
    const fetch = vi.fn(async () => response(page([item("1"), item("2"), item("3")])));
    vi.stubGlobal("fetch", fetch);
    render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria()} /></MemoryRouter>);
    const first = await screen.findByLabelText("Subject 1 from Sender 1");
    const second = screen.getByLabelText("Subject 2 from Sender 2");
    const third = screen.getByLabelText("Subject 3 from Sender 3");
    expect(screen.getByRole("region", { name: "Search results" }).getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("heading", { name: "Search results" }).tagName).toBe("H2");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "End" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "Home" });
    expect(document.activeElement).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not steal result focus when a superseded page response arrives", async () => {
    const latePage = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("cursor=next") ? latePage.promise : Promise.resolve(response(page([item("1")], "next")))));
    const rendered = render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    rendered.rerender(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria({ query: "replacement" })} /></MemoryRouter>);
    const search = screen.getByRole("searchbox", { name: "Search Gmail" });
    search.focus();
    await act(async () => latePage.resolve(response(page([item("2")]))));
    expect(document.activeElement).toBe(search);
    expect(screen.queryByLabelText("Subject 2 from Sender 2")).toBeNull();
  });

  it("focuses an invalid structured field and exposes a reconnect action without leaking provider details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ code: "invalid_search_request", message: "Check the search terms and filters, then try again.", field: "from" }, false, 400)));
    const invalid = render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria({ from: "bad" })} /></MemoryRouter>);
    await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("From")));
    expect(screen.getByLabelText("From").getAttribute("aria-invalid")).toBe("true");
    invalid.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => response({ code: "provider_reauthentication_required", message: "Reconnect Gmail before searching your mailbox.", retryable: false }, false, 409)));
    render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria()} /></MemoryRouter>);
    const reconnect = await screen.findByRole("button", { name: "Reconnect Gmail" });
    expect(reconnect.closest("form")?.getAttribute("action")).toBe("/v1/auth/google/start");
    expect(document.body.textContent).not.toContain("access_token");
  });

  it("opens a Search reader with owned focus and restores the originating row on close", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/search?") ? response(page([item("1")])) : response(thread("thread-1"))));
    render(routed(["/mail/mailbox/search?q=invoice"]));
    const row = await screen.findByLabelText("Subject 1 from Sender 1");
    fireEvent.click(row);
    const close = await screen.findByRole("button", { name: "Back to list" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Subject 1 from Sender 1")));
  });

  it("preserves archived Search rows and applies confirmed unread only to the matching result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page([item("1", ["INBOX", "STARRED"]), item("2", ["INBOX"])]))));
    render(<MemoryRouter><MailboxSearch mailboxId="mailbox" criteria={criteria()} /></MemoryRouter>);
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    act(() => window.dispatchEvent(new CustomEvent("aio:thread-command-confirmed", { detail: { threadId: "thread-1", action: "archive" } })));
    expect(screen.getByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    act(() => window.dispatchEvent(new CustomEvent("aio:thread-command-confirmed", { detail: { threadId: "thread-1", action: "mark-unread" } })));
    expect(screen.getByLabelText("1 unread messages")).toBeTruthy();
    expect(screen.getAllByLabelText(/unread messages/)).toHaveLength(1);
  });

  it("restores query ownership through browser history without replaying prior results", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(page([url.includes("query=alpha") ? item("1") : item("2")]))));
    render(routed(["/mail/mailbox/search?q=alpha&scope=inbox&unread=true"]));
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Gmail" }), { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByLabelText("Subject 2 from Sender 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByLabelText("Subject 1 from Sender 1")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Search scope" })).toHaveProperty("value", "inbox");
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
