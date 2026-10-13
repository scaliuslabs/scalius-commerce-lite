// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { setLocale } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
const sdk = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), patch: vi.fn(), people: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminConversationsSavedReplies: sdk.list,
  getApiV1AdminConversationsSavedRepliesByReplyId: sdk.get,
  postApiV1AdminConversationsSavedReplies: sdk.create,
  patchApiV1AdminConversationsSavedRepliesByReplyId: sdk.patch,
  getApiV1AdminConversationsAssignees: sdk.people,
}));
vi.mock("./inbox-api", () => ({ newRequestKey: () => "reply_request_1" }));
import { SavedRepliesDialog } from "./SavedRepliesDialog";
import { ConversationAssigneeDialog } from "./ConversationAssigneeDialog";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = inboxMessages.en;
const reply = { id: "reply_1", title: "Shipping", body: "Old answer", mode: "reply", createdBy: "staff_1", updatedBy: "staff_1", archivedAt: null, createdAt: 1, updatedAt: 1, version: 1 };
const ok = <T,>(data: T) => ({ data: { success: true, data }, response: new Response() });
let host: HTMLDivElement, root: Root, client: QueryClient;
const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const render = async (node: ReactNode) => { await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)); await settle(); };
const button = (name: string, parent: ParentNode = document) => [...parent.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name)!;
const enter = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
beforeEach(() => {
  vi.clearAllMocks(); setLocale("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sdk.list.mockResolvedValue(ok({ items: [reply], nextCursor: null }));
  sdk.get.mockResolvedValue(ok(reply));
  sdk.patch.mockResolvedValue(ok(reply));
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.restoreAllMocks(); });

it("rechecks a saved reply before insertion and cannot insert an archived cached row", async () => {
  const insert = vi.fn(), close = vi.fn();
  await render(<SavedRepliesDialog open mode="public" onOpenChange={close} onInsert={insert} />);
  sdk.get.mockResolvedValueOnce(ok({ ...reply, archivedAt: 2 }));
  await act(async () => button("Shipping").click()); await settle();
  expect(insert).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.savedReplyChanged);
  sdk.get.mockResolvedValueOnce(ok({ ...reply, body: "Current answer", version: 2 }));
  await act(async () => button("Shipping").click());
  expect(insert).toHaveBeenCalledWith("Current answer");
  expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.patch).not.toHaveBeenCalled();
});

it("keeps edited text after a CAS conflict and uses the fresh version only on another explicit Save", async () => {
  await render(<SavedRepliesDialog open mode="public" onOpenChange={vi.fn()} onInsert={vi.fn()} />);
  await act(async () => button(en.editSavedReply).click());
  await enter(document.querySelector("textarea")!, "My answer");
  sdk.patch.mockRejectedValueOnce(new AdminApiResponseError("Changed", 409));
  sdk.get.mockResolvedValueOnce(ok({ ...reply, body: "Their answer", version: 2 }));
  await act(async () => button(en.saveReply).click()); await settle();
  expect(document.querySelector("textarea")!.value).toBe("My answer");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.savedReplyConflict);
  expect(sdk.patch).toHaveBeenCalledTimes(1);
  await act(async () => button(en.saveReply).click());
  expect(sdk.patch).toHaveBeenLastCalledWith({ path: { replyId: "reply_1" }, body: { version: 2, title: "Shipping", body: "My answer" } });
});

it("closes archive confirmation on failure and exposes the error above a refreshed list", async () => {
  await render(<SavedRepliesDialog open mode="public" onOpenChange={vi.fn()} onInsert={vi.fn()} />);
  await act(async () => button(en.archiveSavedReply).click());
  sdk.patch.mockRejectedValueOnce(new AdminApiResponseError("Changed elsewhere", 409));
  await act(async () => button(en.archiveSavedReply, document.querySelector('[role="alertdialog"]')!).click()); await settle();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Changed elsewhere");
  expect(sdk.list.mock.calls.length).toBeGreaterThan(1);
});

it("cannot choose a previously eligible cached teammate while reopening revalidates the page", async () => {
  const choose = vi.fn();
  sdk.people.mockResolvedValueOnce(ok({ items: [{ id: "staff_2", name: "Teammate" }], nextCursor: null }));
  const draw = (open: boolean) => render(<ConversationAssigneeDialog open={open} selectedId={null} currentUserId={null} onOpenChange={vi.fn()} onSelect={choose} />);
  await draw(true); expect(button("Teammate").disabled).toBe(false);
  await draw(false);
  let resolve!: (value: ReturnType<typeof ok>) => void;
  sdk.people.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await draw(true);
  expect(button("Teammate").disabled).toBe(true);
  await act(async () => button("Teammate").click());
  expect(choose).not.toHaveBeenCalled();
  await act(async () => resolve(ok({ items: [], nextCursor: null }))); await settle();
  expect(button("Teammate")).toBeUndefined();
});
