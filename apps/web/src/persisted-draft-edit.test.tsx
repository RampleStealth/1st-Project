import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadReader } from "./thread-reader.js";
import { localDraftEditPath } from "./draft-navigation.js";

const thread = { id: "provider-thread", messages: [{ id: "message", from: "sender@example.test", to: ["owner@example.test"], subject: "Draft subject", sentAt: "2026-07-18T12:00:00.000Z", attachments: [], plainText: "Draft body", sanitizedHtml: null, renderingState: "ready" }] };

function response(value: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: async () => value } as Response;
}

describe("persisted draft edit affordance", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("exposes the exact owner-resolved local draft and never treats the provider thread as its ID", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => String(input).includes("draft-edit-eligibility")
      ? response({ editable: true, draftId: "local-draft", writeGranted: true })
      : response(thread));
    const edit = vi.fn();
    render(<ThreadReader mailboxId="mailbox" threadId="provider-thread" view="drafts" onEditDraft={edit} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    expect(edit).toHaveBeenCalledWith("local-draft");
    expect(localDraftEditPath("mailbox", edit.mock.calls[0][0])).toBe("/mail/mailbox/drafts/local/local-draft");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/v1/mailboxes/mailbox/threads/provider-thread/draft-edit-eligibility", expect.objectContaining({ credentials: "include" }));
  });

  it("keeps unmatched or ambiguous provider drafts readable without exposing Edit", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => String(input).includes("draft-edit-eligibility") ? response({ editable: false }) : response(thread));
    render(<ThreadReader mailboxId="mailbox" threadId="provider-thread" view="drafts" />);
    expect(await screen.findByText("Draft body")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
  });

  it("routes an eligible read-only mailbox through the existing permission upgrade action", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => String(input).includes("draft-edit-eligibility")
      ? response({ editable: true, draftId: "local-draft", writeGranted: false })
      : response(thread));
    const permission = vi.fn();
    render(<ThreadReader mailboxId="mailbox" threadId="provider-thread" view="drafts" onPermissionRequired={permission} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable editing" }));
    expect(permission).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
  });

  it("does not request edit eligibility outside the Drafts view", async () => {
    vi.mocked(fetch).mockResolvedValue(response(thread));
    render(<ThreadReader mailboxId="mailbox" threadId="provider-thread" view="inbox" />);
    expect(await screen.findByText("Draft body")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("draft-edit-eligibility"))).toBe(false);
  });
});
