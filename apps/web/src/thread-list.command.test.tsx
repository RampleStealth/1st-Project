import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./thread-list.js";

const page = { source:"gmail" as const, fetchedAt:new Date().toISOString(), nextCursor:null, items:[
  {id:"a",providerThreadId:"thread-a",subject:"A",latestSender:"A",preview:"one",lastMessageAt:null,unreadCount:0,messageCount:1,hasAttachments:false,hasDraft:false,labels:["INBOX","STARRED"]},
  {id:"b",providerThreadId:"thread-b",subject:"B",latestSender:"B",preview:"two",lastMessageAt:null,unreadCount:0,messageCount:1,hasAttachments:false,hasDraft:false,labels:["INBOX"]}
]};
function renderList(view:string){ return render(<MemoryRouter><ThreadList mailboxId="mailbox" view={view} selectedThreadId="thread-a" /></MemoryRouter>); }
beforeEach(()=>{ vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>page})); });
describe("confirmed thread command UI",()=>{
  it.each(["inbox","all","sent","drafts"])("archive confirmation is scoped in %s",async view=>{renderList(view);await screen.findByLabelText("A from A");window.dispatchEvent(new CustomEvent("aio:thread-command-confirmed",{detail:{threadId:"thread-a",action:"archive"}}));if(view==="inbox")await waitFor(()=>expect(screen.queryByLabelText("A from A")).toBeNull());else expect(screen.getByLabelText("A from A")).toBeTruthy();});
  it("updates only the confirmed unread row",async()=>{renderList("inbox");await screen.findByLabelText("A from A");window.dispatchEvent(new CustomEvent("aio:thread-command-confirmed",{detail:{threadId:"thread-a",action:"mark-unread"}}));await waitFor(()=>expect(screen.getByLabelText("1 unread messages")).toBeTruthy());expect(screen.getByLabelText("B from B")).toBeTruthy();});
  it("frontend list calls only the application threads endpoint",async()=>{renderList("inbox");await screen.findByLabelText("A from A");expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringMatching(/^\/v1\/mailboxes\/mailbox\/threads\?/),expect.any(Object));});
});
