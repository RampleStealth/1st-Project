import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./thread-list.js";
import { ThreadReader } from "./thread-reader.js";
import { focusFirstThreadRow, focusThreadRow } from "./workspace-focus.js";

const page = { source: "gmail" as const, fetchedAt: new Date().toISOString(), nextCursor: null, items: [
  { id: "a", providerThreadId: "thread-a", subject: "We&#39;re &amp; ready", latestSender: "A very long sender name that will truncate", preview: "&lt;preview&gt; &amp; more", lastMessageAt: null, unreadCount: 2, messageCount: 2, hasAttachments: true, hasDraft: false, labels: ["INBOX", "UNREAD"] },
  { id: "b", providerThreadId: "thread-b", subject: "Other", latestSender: "B", preview: "two", lastMessageAt: null, unreadCount: 0, messageCount: 1, hasAttachments: false, hasDraft: false, labels: ["INBOX"] }
] };
const thread = { id: "thread-a", messages: [{ id: "message-a", from: "A&#39;s sender", to: ["Team &amp; friends"], subject: "We&#39;re &amp; ready", sentAt: null, attachments: [], plainText: "Plain text", sanitizedHtml: null, renderingState: "ready" as const }] };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => Promise.resolve({ ok: true, json: async () => init?.method === "POST" ? { id: "command", status: "pending" } : url.includes("/threads?") ? page : thread })));
  vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
});

describe("thread presentation", () => {
  it("conveys selected and unread state, preserves truncation structure, and decodes display entities", async () => {
    render(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" selectedThreadId="thread-a" /></MemoryRouter>);
    const selected = await screen.findByRole("button", { name: /We're & ready from/i });
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(selected.classList.contains("thread-row--selected")).toBe(true);
    expect(selected.classList.contains("thread-row--unread")).toBe(true);
    expect(selected.querySelector(".thread-row__preview")?.textContent).toBe("<preview> & more");
    expect(selected.querySelector(".thread-row__subject span")?.getAttribute("title")).toBe("We're & ready");
  });

  it("presents a reader toolbar and prevents duplicate actions while Gmail confirmation is pending", async () => {
    render(<ThreadReader mailboxId="mailbox" threadId="thread-a" view="inbox" />);
    expect(await screen.findByRole("heading", { name: "We're & ready" })).toBeTruthy();
    const archive = screen.getByRole("button", { name: "Archive" });
    const unread = screen.getByRole("button", { name: "Mark unread" });
    fireEvent.click(archive);
    await waitFor(() => expect(archive.disabled).toBe(true));
    expect(unread.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Waiting for Gmail confirmation");
  });

  it("provides a clear empty reader state", () => {
    render(<ThreadReader mailboxId="mailbox" />);
    expect(screen.getByRole("heading", { name: "Select a conversation" })).toBeTruthy();
  });

  it("restores focus to a selected thread or the next available thread after the reader closes", () => {
    document.body.innerHTML = '<button id="thread-row-thread-a" data-thread-row>Thread A</button><button id="thread-row-thread-b" data-thread-row>Thread B</button>';
    focusThreadRow("thread-a");
    expect(document.activeElement).toBe(document.getElementById("thread-row-thread-a"));
    focusFirstThreadRow();
    expect(document.activeElement).toBe(document.getElementById("thread-row-thread-a"));
  });
});
