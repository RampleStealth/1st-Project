import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftComposer } from "./draft-composer.js";

beforeEach(() => { document.cookie = "aio_csrf=test"; vi.stubGlobal("fetch", vi.fn()); });
function openComposer() { render(<DraftComposer mailboxId="mailbox" onPermissionRequired={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: "New draft" })); fireEvent.change(screen.getByLabelText("To"), { target: { value: "recipient@example.test" } }); fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Subject" } }); fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Body" } }); }

describe("draft composer", () => {
  it("creates through the application API, displays pending, then reads the confirmed draft", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "command", draftId: "draft", status: "pending" }) } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Creating draft…")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/v1/mailboxes/mailbox/drafts", expect.objectContaining({ method: "POST" }));
  });
  it("shows a confirmed draft only after the command has succeeded", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ id: "command", draftId: "draft", status: "succeeded" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "draft", status: "ready", to: ["recipient@example.test"], subject: "Subject", plainText: "Body" }) } as Response);
    openComposer(); fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Draft ready")).toBeTruthy(); expect(screen.getByText("Subject")).toBeTruthy();
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
});
