import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./thread-list.js";

function page(subject: string, nextCursor: string | null) {
  return {
    source: "gmail" as const,
    fetchedAt: new Date().toISOString(),
    nextCursor,
    items: [{ id: `id-${subject}`, providerThreadId: `thread-${subject}`, subject, latestSender: "Sender", preview: "Preview", lastMessageAt: null, unreadCount: 0, messageCount: 1, hasAttachments: false, hasDraft: false, labels: ["INBOX"] }]
  };
}

const firstPage = page("First", "next-page");
const middlePage = page("Middle", "final-page");
const finalPage = page("Final", null);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string) => ({ ok: true, json: async () => input.includes("cursor=final-page") ? finalPage : input.includes("cursor=next-page") ? middlePage : firstPage })));
});

describe("thread pagination footer", () => {
  it("uses a dedicated footer outside the scrollable rows and remains visible on row hover", async () => {
    render(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" selectedThreadId="thread-First" /></MemoryRouter>);

    const row = await screen.findByLabelText("First from Sender");
    const threads = screen.getByLabelText("Threads");
    const rows = screen.getByLabelText("Thread results");
    const footer = screen.getByLabelText("Thread pagination");
    expect(footer.parentElement).toBe(threads);
    expect(footer.previousElementSibling).toBe(rows);
    expect(footer.classList.contains("thread-list__footer")).toBe(true);
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();

    const next = screen.getByRole("button", { name: "Next" });
    fireEvent.mouseEnter(row);
    expect(screen.getByRole("button", { name: "Next" })).toBe(next);
    expect(next.parentElement?.classList.contains("thread-list__pagination-end")).toBe(true);
  });

  it("renders no controls for a single Gmail page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => page("Only", null) }));
    render(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" /></MemoryRouter>);

    await screen.findByLabelText("Only from Sender");
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByLabelText("Thread pagination")).toBeTruthy();
  });

  it("shows only available controls and preserves Gmail cursor history", async () => {
    render(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" /></MemoryRouter>);

    await screen.findByLabelText("First from Sender");
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText("Middle from Sender");
    expect(screen.getByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText("Final from Sender");
    expect(screen.getByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(screen.getByLabelText("Middle from Sender")).toBeTruthy());
  });

  it("disables available controls only while a page is loading", async () => {
    let resolveNext: ((response: { ok: boolean; json: () => Promise<typeof middlePage> }) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string) => {
      if (!input.includes("cursor=next-page")) return Promise.resolve({ ok: true, json: async () => firstPage });
      return new Promise((resolve) => { resolveNext = resolve; });
    }));
    render(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" /></MemoryRouter>);

    await screen.findByLabelText("First from Sender");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    });
    resolveNext?.({ ok: true, json: async () => middlePage });
    await screen.findByLabelText("Middle from Sender");
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  });
});
