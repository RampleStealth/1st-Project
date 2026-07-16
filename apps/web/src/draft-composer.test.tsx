import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftComposer } from "./draft-composer.js";

beforeEach(() => { document.cookie = "aio_csrf=test"; vi.stubGlobal("fetch", vi.fn()); });
function openComposer() { render(<DraftComposer mailboxId="mailbox" onPermissionRequired={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: "New draft" })); fireEvent.change(screen.getByLabelText("To"), { target: { value: "recipient@example.test" } }); fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Subject" } }); fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Body" } }); }
const readyDraft = { id: "draft", status: "ready", revision: 1, confirmedRevision: 1, to: ["recipient@example.test"], cc: [], bcc: [], subject: "Subject", plainText: "Body", html: null };

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
});
