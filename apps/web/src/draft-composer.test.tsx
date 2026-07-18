import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftComposer } from "./draft-composer.js";

beforeEach(() => { document.cookie = "aio_csrf=test"; vi.stubGlobal("fetch", vi.fn()); });
function openComposer() { render(<DraftComposer mailboxId="mailbox" onPermissionRequired={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: "New draft" })); fireEvent.change(screen.getByLabelText("To"), { target: { value: "recipient@example.test" } }); fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Subject" } }); fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Body" } }); }
const readyDraft = { id: "draft", status: "ready", revision: 1, confirmedRevision: 1, to: ["recipient@example.test"], cc: [], bcc: [], subject: "Subject", plainText: "Body", html: null, editable: true, writeGranted: true };

describe("draft composer", () => {
  it("creates through the application API and displays pending", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "command", draftId: "draft", status: "pending" }) } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Creating draft...")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/v1/mailboxes/mailbox/drafts", expect.objectContaining({ method: "POST" }));
  });
  it("allows editing only after provider-confirmed draft creation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "command", draftId: "draft", status: "succeeded" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => readyDraft } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByRole("button", { name: "Save draft" })).toBeTruthy(); expect(screen.getByDisplayValue("Subject")).toBeTruthy();
  });
  it("loads and updates a persisted draft without creating a new draft", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => readyDraft } as Response)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "update", draftId: "draft", status: "pending", revision: 2 }) } as Response);
    render(<DraftComposer mailboxId="mailbox" draftId="draft" onPermissionRequired={vi.fn()} />);
    expect(await screen.findByDisplayValue("Subject")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenNthCalledWith(1, "/v1/mailboxes/mailbox/drafts/draft", { credentials: "include" });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Persisted update" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Saving draft...")).toBeTruthy();
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url, options]) => url === "/v1/mailboxes/mailbox/drafts" && options?.method === "POST")).toBe(false);
    expect(calls.at(-1)).toEqual(["/v1/mailboxes/mailbox/drafts/draft", expect.objectContaining({ method: "PUT", headers: expect.objectContaining({ "if-match": "\"1\"" }) })]);
  });
  it("does not turn a failed persisted-draft load into a new-draft flow", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404, json: async () => ({ code: "draft_not_found" }) } as Response);
    render(<DraftComposer mailboxId="mailbox" draftId="missing" />);
    expect(await screen.findByText("We could not load this draft safely.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New draft" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === "/v1/mailboxes/mailbox/drafts/missing")).toBe(true);
  });
  it("does not allow a persisted read-only draft to be saved and exposes permission upgrade", async () => {
    const permission = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...readyDraft, writeGranted: false }) } as Response);
    render(<DraftComposer mailboxId="mailbox" draftId="draft" onPermissionRequired={permission} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable Gmail actions" }));
    expect(permission).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
  it("ignores a stale persisted-draft response after navigation selects another draft", async () => {
    let resolveFirst!: (value: Response) => void;
    vi.mocked(fetch)
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...readyDraft, id: "second", subject: "Second draft" }) } as Response);
    const rendered = render(<DraftComposer mailboxId="mailbox" draftId="first" />);
    rendered.rerender(<DraftComposer mailboxId="mailbox" draftId="second" />);
    expect(await screen.findByDisplayValue("Second draft")).toBeTruthy();
    await act(async () => resolveFirst({ ok: true, status: 200, json: async () => ({ ...readyDraft, id: "first", subject: "Stale first draft" }) } as Response));
    expect(screen.getByDisplayValue("Second draft")).toBeTruthy();
    expect(screen.queryByDisplayValue("Stale first draft")).toBeNull();
  });
  it("shows permission and reconnect boundaries without provider calls", async () => {
    const permission = vi.fn(); vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: "permission_required" }) } as Response);
    render(<DraftComposer mailboxId="mailbox" onPermissionRequired={permission} />); fireEvent.click(screen.getByRole("button", { name: "New draft" })); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByText(/write permission is required/i); fireEvent.click(screen.getByRole("button", { name: "Enable Gmail actions" })); expect(permission).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("gmail.googleapis.com");
  });
  it("uses a reconnect action when the mailbox requires reauthorization", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: "provider_reauthentication_required" }) } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" })); await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect Gmail" })).toBeTruthy());
  });
  it("saves explicitly with If-Match, keeps pending distinct from ready, and never calls Gmail", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "create", draftId: "draft", status: "succeeded" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => readyDraft } as Response)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "update", draftId: "draft", status: "pending", revision: 2 }) } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByRole("button", { name: "Save draft" });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Saving draft...")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenLastCalledWith("/v1/mailboxes/mailbox/drafts/draft", expect.objectContaining({ method: "PUT", headers: expect.objectContaining({ "if-match": "\"1\"" }) }));
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("gmail.googleapis.com");
  });
  it("sends only the confirmed, clean draft and never presents pending as sent", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "create", draftId: "draft", status: "succeeded" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => readyDraft } as Response)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "send", draftId: "draft", status: "pending" }) } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByRole("button", { name: "Send" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sending...")).toBeTruthy();
    expect(screen.queryByText("Sent")).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenLastCalledWith("/v1/mailboxes/mailbox/drafts/draft/send", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "if-match": "\"1\"" }) }));
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("gmail.googleapis.com");
  });
  it("disables Send for dirty browser edits", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "create", draftId: "draft", status: "succeeded" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => readyDraft } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    const send = await screen.findByRole("button", { name: "Send" }); expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Unsaved" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps a reloaded recovered send out of the ready state and offers only verification", async () => {
    const recovered = { ...readyDraft, status: "recovery_required", canVerifySend: true };
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "create", draftId: "draft", status: "succeeded" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => recovered } as Response)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "send-recovery", status: "verification_pending" }) } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText(/will not be resent automatically/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check Gmail status" }));
    expect(await screen.findByText("Checking Gmail status...")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenLastCalledWith("/v1/mailboxes/mailbox/drafts/draft/send-verification", expect.objectContaining({ method: "POST" }));
  });
});
