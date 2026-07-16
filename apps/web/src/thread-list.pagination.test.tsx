import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./thread-list.js";

const firstPage = {
  source: "gmail" as const,
  fetchedAt: new Date().toISOString(),
  nextCursor: "next-page",
  items: [{ id: "first", providerThreadId: "thread-first", subject: "First", latestSender: "Sender", preview: "Preview", lastMessageAt: null, unreadCount: 0, messageCount: 1, hasAttachments: false, hasDraft: false, labels: ["INBOX"] }]
};
const secondPage = { ...firstPage, nextCursor: null, items: [{ ...firstPage.items[0], id: "second", providerThreadId: "thread-second", subject: "Second" }] };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string) => ({ ok: true, json: async () => input.includes("cursor=next-page") ? secondPage : firstPage })));
});

describe("thread pagination placement", () => {
  it("remains attached to the thread list while moving between Gmail pages", async () => {
    render(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" /></MemoryRouter>);

    await screen.findByLabelText("First from Sender");
    const threads = screen.getByLabelText("Threads");
    const pagination = screen.getByLabelText("Thread pagination");
    expect(pagination.parentElement).toBe(threads);
    expect(pagination.previousElementSibling?.classList.contains("thread-list__rows")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByLabelText("Second from Sender")).toBeTruthy());
    expect(screen.getByLabelText("Thread pagination").parentElement).toBe(threads);
  });
});
