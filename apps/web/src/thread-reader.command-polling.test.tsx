import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./thread-list.js";
import { mergePolledCommandStatus, ThreadReader } from "./thread-reader.js";

const thread = (id: string) => ({ id, messages: [{ id: `${id}-message`, from: "Sender", to: [], subject: id, sentAt: null, attachments: [], plainText: "Body", sanitizedHtml: null, renderingState: "ready" as const }] });
const threadPage = { source: "gmail" as const, fetchedAt: new Date().toISOString(), nextCursor: null, items: [{ id: "projection-a", providerThreadId: "thread-a", subject: "thread-a", latestSender: "Sender", preview: "Preview", lastMessageAt: null, unreadCount: 0, messageCount: 1, hasAttachments: false, hasDraft: false, labels: ["INBOX"] }] };
const pendingCommand = { id: "command-id", status: "pending", action: "mark-unread" as const, threadId: "thread-a" };

beforeEach(() => {
  document.cookie = "aio_csrf=test";
  vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
});
afterEach(() => vi.unstubAllGlobals());

describe("thread command polling", () => {
  it("keeps confirmed statuses monotonic when a delayed pending response arrives", () => {
    const succeeded = mergePolledCommandStatus(pendingCommand, "succeeded");
    expect(succeeded.status).toBe("succeeded");
    expect(mergePolledCommandStatus(succeeded, "pending").status).toBe("succeeded");
    expect(mergePolledCommandStatus(succeeded, "succeeded")).toBe(succeeded);
    expect(mergePolledCommandStatus({ ...pendingCommand, status: "running" }, "pending").status).toBe("running");
  });

  it("emits one confirmed unread event and stops polling after success", async () => {
    let statusRequests = 0;
    const confirmations: Array<{ threadId: string; action: string }> = [];
    const record = (event: Event) => confirmations.push((event as CustomEvent<{ threadId: string; action: string }>).detail);
    window.addEventListener("aio:thread-command-confirmed", record);
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve({ ok: true, status: 202, json: async () => ({ id: "command-id", status: "pending" }) });
      if (input.includes("/provider-commands/")) { statusRequests += 1; return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: "command-id", commandType: "mark_thread_unread", status: "succeeded", failureCode: null }) }); }
      if (input.includes("/threads?")) return Promise.resolve({ ok: true, status: 200, json: async () => threadPage });
      return Promise.resolve({ ok: true, status: 200, json: async () => thread("thread-a") });
    }));
    render(<MemoryRouter><ThreadList mailboxId="mailbox" view="inbox" selectedThreadId="thread-a" /><ThreadReader mailboxId="mailbox" threadId="thread-a" view="inbox" /></MemoryRouter>);

    await screen.findByRole("heading", { name: "thread-a" });
    await screen.findByLabelText("thread-a from Sender");
    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    await waitFor(() => expect(confirmations).toEqual([{ threadId: "thread-a", action: "mark-unread" }]), { timeout: 2_500 });
    expect(screen.getByLabelText("1 unread messages")).toBeTruthy();
    expect(screen.queryByText("Waiting for Gmail confirmation…")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(statusRequests).toBe(1);
    window.removeEventListener("aio:thread-command-confirmed", record);
  });

  it("cancels a poll when selection changes so a result cannot replay against another thread", async () => {
    let resolveStatus: ((value: { ok: boolean; status: number; json: () => Promise<object> }) => void) | undefined;
    const confirmations: Array<{ threadId: string; action: string }> = [];
    const record = (event: Event) => confirmations.push((event as CustomEvent<{ threadId: string; action: string }>).detail);
    window.addEventListener("aio:thread-command-confirmed", record);
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve({ ok: true, status: 202, json: async () => ({ id: "command-id", status: "pending" }) });
      if (input.includes("/provider-commands/")) return new Promise<{ ok: boolean; status: number; json: () => Promise<object> }>((resolve) => { resolveStatus = resolve; });
      return Promise.resolve({ ok: true, status: 200, json: async () => thread(input.endsWith("thread-b") ? "thread-b" : "thread-a") });
    }));
    const rendered = render(<ThreadReader mailboxId="mailbox" threadId="thread-a" view="inbox" />);

    await screen.findByRole("heading", { name: "thread-a" });
    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    await waitFor(() => expect(resolveStatus).toBeTruthy(), { timeout: 2_500 });
    rendered.rerender(<ThreadReader mailboxId="mailbox" threadId="thread-b" view="inbox" />);
    await screen.findByRole("heading", { name: "thread-b" });
    resolveStatus?.({ ok: true, status: 200, json: async () => ({ id: "command-id", commandType: "mark_thread_unread", status: "succeeded", failureCode: null }) });
    await act(async () => { await Promise.resolve(); });

    expect(confirmations).toEqual([]);
    window.removeEventListener("aio:thread-command-confirmed", record);
  });
});
