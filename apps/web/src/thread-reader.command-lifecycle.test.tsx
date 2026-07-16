import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./thread-list.js";
import { ThreadReader } from "./thread-reader.js";

const inbox = { source: "gmail" as const, fetchedAt: new Date().toISOString(), nextCursor: null, items: [
  { id: "a", providerThreadId: "thread-a", subject: "Archived", latestSender: "A", preview: "one", lastMessageAt: null, unreadCount: 0, messageCount: 1, hasAttachments: false, hasDraft: false, labels: ["INBOX"] },
  { id: "b", providerThreadId: "thread-b", subject: "Inbox thread", latestSender: "B", preview: "two", lastMessageAt: null, unreadCount: 0, messageCount: 1, hasAttachments: false, hasDraft: false, labels: ["INBOX"] }
] };
const allMail = { ...inbox, items: [...inbox.items] };
const message = (threadId: string) => ({ id: threadId, messages: [{ id: `${threadId}-message`, from: "Sender", to: [], subject: threadId === "thread-b" ? "Inbox thread" : "Archived", sentAt: null, attachments: [], plainText: "Body", sanitizedHtml: null, renderingState: "ready" as const }] });

function WorkspaceFixture({ view, threadId }: { view: "inbox" | "all"; threadId?: string }) {
  return <MemoryRouter><ThreadList mailboxId="mailbox" view={view} selectedThreadId={threadId} /><ThreadReader mailboxId="mailbox" view={view} threadId={threadId} /></MemoryRouter>;
}

describe("thread command lifecycle across view changes", () => {
  let postCalls = 0;
  beforeEach(() => {
    postCalls = 0;
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (init?.method === "POST") { postCalls += 1; return Promise.resolve({ ok: true, status: 202, json: async () => ({ id: "archive-command", status: "succeeded" }) }); }
      if (input.includes("/threads?")) return Promise.resolve({ ok: true, json: async () => new URL(input, "http://app.test").searchParams.get("view") === "all" ? allMail : inbox });
      return Promise.resolve({ ok: true, json: async () => message(input.endsWith("thread-b") ? "thread-b" : "thread-a") });
    }));
  });

  it("does not replay a confirmed archive against an Inbox row opened after All Mail", async () => {
    const confirmations: Array<{ threadId: string; action: string }> = [];
    const record = (event: Event) => confirmations.push((event as CustomEvent<{ threadId: string; action: string }>).detail);
    window.addEventListener("aio:thread-command-confirmed", record);
    const rendered = render(<WorkspaceFixture view="inbox" threadId="thread-a" />);
    await screen.findByRole("button", { name: "Archived from A" });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(confirmations).toEqual([{ threadId: "thread-a", action: "archive" }]));

    rendered.rerender(<WorkspaceFixture view="all" />);
    await screen.findByRole("button", { name: "Inbox thread from B" });
    rendered.rerender(<WorkspaceFixture view="inbox" />);
    const inboxRow = await screen.findByRole("button", { name: "Inbox thread from B" });
    const confirmationsBeforeOpen = confirmations.length;
    fireEvent.click(inboxRow);
    rendered.rerender(<WorkspaceFixture view="inbox" threadId="thread-b" />);

    await screen.findByRole("heading", { name: "Inbox thread" });
    expect(screen.getByRole("button", { name: "Inbox thread from B" })).toBeTruthy();
    expect(confirmations).toHaveLength(confirmationsBeforeOpen);
    expect(postCalls).toBe(1);
    window.removeEventListener("aio:thread-command-confirmed", record);
  });

  it("cleans up view-specific confirmation listeners instead of accumulating them", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const rendered = render(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" /></MemoryRouter>);
    await screen.findByRole("button", { name: "Archived from A" });
    rendered.rerender(<MemoryRouter><ThreadList mailboxId="mailbox" view="all" /></MemoryRouter>);
    rendered.rerender(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" /></MemoryRouter>);
    rendered.unmount();
    const adds = add.mock.calls.filter(([name]) => name === "aio:thread-command-confirmed").length;
    const removes = remove.mock.calls.filter(([name]) => name === "aio:thread-command-confirmed").length;
    expect(adds).toBe(removes);
    add.mockRestore(); remove.mockRestore();
  });
});
