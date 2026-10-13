// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { inboxMessages } from "~/i18n/inbox";

const sdk = vi.hoisted(() => ({
  userId: "u1",
  navigate: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  getOrder: vi.fn(),
  post: vi.fn(),
  postOrder: vi.fn(),
  patch: vi.fn(),
  read: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouteContext: () => sdk.userId,
  useNavigate: () => sdk.navigate,
  Link: ({ to, children, params: _params, search: _search, ...props }: { to: string; children: ReactNode; params?: unknown; search?: unknown }) =>
    <a href={to} {...props}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminConversations: sdk.list,
  postApiV1AdminConversationsQuery: sdk.list,
  getApiV1AdminConversationsAssignees: vi.fn(),
  getApiV1AdminConversationsSavedReplies: vi.fn(),
  getApiV1AdminConversationsSavedRepliesByReplyId: vi.fn(),
  postApiV1AdminConversationsSavedReplies: vi.fn(),
  patchApiV1AdminConversationsSavedRepliesByReplyId: vi.fn(),
  postApiV1AdminConversationsByIdSearch: vi.fn(),
  getApiV1AdminConversationsById: sdk.get,
  getApiV1AdminConversationsOrderByOrderId: sdk.getOrder,
  getApiV1AdminConversationsSummary: vi.fn(),
  patchApiV1AdminConversationsById: sdk.patch,
  postApiV1AdminConversationsByIdMessages: sdk.post,
  postApiV1AdminConversationsByIdRead: sdk.read,
  postApiV1AdminConversationsOrderByOrderIdMessages: sdk.postOrder,
}));

vi.mock("~/lib/realtime/store", () => ({ PresenceSlot: () => null, presenceKey: (kind: string, id: string) => `${kind}:${id}` }));

import { clearInboxDrafts } from "~/lib/inbox-drafts";
import { useMarkRead } from "./inbox-api";
import { inboxKeys } from "~/lib/api-query-options/inbox";
import { ConversationComposer } from "./ConversationComposer";
import { OrderConversationCard } from "../orderview/OrderConversationCard";
import type { Order } from "../orderview/types";
import { ConversationMessages } from "./ConversationMessages";
import { ConversationPane } from "./ConversationPane";
import { InboxList } from "./InboxList";
import { validateInboxSearch } from "./inbox-search";
import type { StaffThread } from "~/lib/api-query-options/inbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = inboxMessages.en;
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: new Response() });

const thread: StaffThread = {
  id: "cnv_thread0000001",
  subjectType: "order",
  subjectId: null,
  subject: null,
  status: "open",
  orderId: "ord_1",
  orderNumber: "#1057",
  customerId: null,
  customerName: "Rahim Uddin",
  assigneeUserId: null,
  assigneeName: null,
  assigneeEligible: false,
  lastMessageVisibility: "public",
  lastMessageAt: 1_780_000_300,
  lastAuthorType: "customer",
  preview: "Any update?",
  unread: 1,
  version: 4,
  lastSeq: 4,
  staffReadSeq: 3,
  customerReadSeq: 4,
  hasMore: false,
  order: null,
  cases: [],
  messages: [
    { id: "m1", seq: 1, kind: "event", visibility: "public", authorType: "system", authorUserId: null, authorName: null, body: null,
      eventKind: "support_request_submitted", eventData: { type: "return" }, createdAt: 1_780_000_000, attachments: [] },
    { id: "m2", seq: 2, kind: "message", visibility: "public", authorType: "guest_receipt", authorUserId: null, authorName: null,
      body: "The strap broke", eventKind: null, eventData: null, createdAt: 1_780_000_100,
      attachments: [{ id: "att_photo0000001", mediaType: "image/webp", sizeBytes: 100, width: 10, height: 10 }] },
    { id: "m3", seq: 3, kind: "message", visibility: "internal", authorType: "staff", authorUserId: "u2", authorName: "Nadia",
      body: "Check the batch", eventKind: null, eventData: null, createdAt: 1_780_000_200, attachments: [] },
    { id: "m4", seq: 4, kind: "message", visibility: "public", authorType: "staff", authorUserId: "u1", authorName: "Me",
      body: "Sorry! A new one is on its way.", eventKind: null, eventData: null, createdAt: 1_780_000_300, attachments: [] },
  ],
};

describe("dashboard inbox", () => {
  let host: HTMLDivElement;
  let root: Root;
  const intersections: Array<{ emit: () => void }> = [];
  const showTail = async () => act(async () => intersections.at(-1)!.emit());

  const render = async (node: ReactNode, permissions: string[] = ["conversations.view", "conversations.reply"]) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <PermissionProvider permissions={permissions}>{node}</PermissionProvider>
      </QueryClientProvider>,
    ));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    return client;
  };
  const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    clearInboxDrafts();
    sdk.userId = "u1";
    intersections.length = 0;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("IntersectionObserver", class {
      target!: Element;
      constructor(readonly callback: IntersectionObserverCallback) { intersections.push(this); }
      observe(target: Element) { this.target = target; }
      disconnect() {}
      emit() { this.callback([{ target: this.target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    sdk.read.mockImplementation(() => ok({ ok: true }));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists conversations with who wrote, the order, a preview and the unread count", async () => {
    sdk.list.mockImplementation(() => ok({ items: [thread], nextCursor: null }));
    await render(<InboxList search={{}} selectedId={null} onSearchChange={vi.fn()} />);
    expect(sdk.list).toHaveBeenCalledWith({ body: expect.objectContaining({ status: "open" }) });
    const row = host.querySelector("li a")!;
    expect(row.textContent).toContain("Rahim Uddin");
    expect(row.textContent).toContain("Order #1057");
    expect(row.textContent).toContain("Any update?");
    expect(row.textContent).toContain(en.unread.replace("{count}", "1"));
  });

  it("says why a list is empty, and offers to clear a filter", async () => {
    sdk.list.mockImplementation(() => ok({ items: [], nextCursor: null }));
    const onSearchChange = vi.fn();
    await render(<InboxList search={{ status: "pending" }} selectedId={null} onSearchChange={onSearchChange} />);
    expect(host.textContent).toContain(en["empty.pending"]);

    act(() => root.unmount());
    root = createRoot(host);
    await render(<InboxList search={{}} query="nothing" selectedId={null} onSearchChange={onSearchChange} />);
    expect(host.textContent).toContain(en["empty.filtered"]);
    await act(async () => button(en.clearFilters)!.click());
    expect(onSearchChange).toHaveBeenCalledWith({ assignee: undefined, subject: undefined, unread: undefined, sort: undefined });
  });

  it("filters by what the conversation is about, and counts that filter when the list is empty", async () => {
    sdk.list.mockImplementation(() => ok({ items: [], nextCursor: null }));
    const onSearchChange = vi.fn();
    await render(<InboxList search={{ subject: "warranty_claim" }} selectedId={null} onSearchChange={onSearchChange} />);
    expect(sdk.list).toHaveBeenCalledWith({ body: expect.objectContaining({ subjectType: "warranty_claim" }) });
    expect(host.textContent).toContain(en["empty.filtered"]);

    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${en.filters}"]`)!.click());
    const select = document.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${en.subjectFilter}"]`)!;
    expect(select.textContent).toContain(en["subject.warranty_claim"]);
    await act(async () => select.click());
    const options = () => [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')];
    expect(options().map((option) => option.textContent?.trim())).toEqual([
      en["subject.all"],
      en["subject.order"],
      en["subject.store"],
      en["subject.review"],
      en["subject.warranty_claim"],
    ]);
    await act(async () => options().find((option) => option.textContent?.trim() === en["subject.review"])!.click());
    expect(onSearchChange).toHaveBeenCalledWith({ subject: "review" });
    await act(async () => select.click());
    await act(async () => options().find((option) => option.textContent?.trim() === en["subject.all"])!.click());
    expect(onSearchChange).toHaveBeenCalledWith({ subject: undefined });
  });

  it("keeps only known subjects in the inbox URL", () => {
    expect(validateInboxSearch({ subject: "review" })).toEqual({ subject: "review" });
    expect(validateInboxSearch({ subject: "warranty_claim", status: "closed" })).toEqual({ subject: "warranty_claim", status: "closed" });
    expect(validateInboxSearch({ subject: "gift_card" })).toEqual({});
    expect(validateInboxSearch({ subject: ["order"] })).toEqual({});
  });

  it("shows the customer's words and images, colleagues' notes marked internal, and case events", async () => {
    await render(<ConversationMessages thread={thread} currentUserId="u1" />);
    const items = [...host.querySelectorAll("[data-message-seq]")].map((item) => item.textContent ?? "");
    expect(items[0]).toContain("submitted");
    expect(items[1]).toContain("Rahim Uddin");
    expect(items[1]).toContain("The strap broke");
    expect(items[2]).toContain(en.internalNote);
    expect(items[2]).toContain("Nadia");
    expect(items[3]).toContain(en.you);
    expect(host.querySelector("img")?.getAttribute("src")).toContain("/api/v1/admin/conversations/cnv_thread0000001/attachments/att_photo0000001");
  });

  it("returns focus to More actions when Find closes", async () => {
    sdk.get.mockImplementation(() => ok({ conversation: thread }));
    await render(<ConversationPane conversationId={thread.id} currentUserId="u1" search={{}} />, ["conversations.view"]);
    const more = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.moreActions}"]`)!;
    await act(async () => more.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, ctrlKey: false })));
    const find = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === en.find)!;
    await act(async () => find.click());
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.focus();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("sends a reply with Ctrl+Enter, reuses the draft's key after a failure and renews it after a send", async () => {
    sdk.post.mockImplementationOnce(() => Promise.resolve({ error: { success: false, error: { message: "Network" } }, response: new Response(null, { status: 503 }) }));
    sdk.post.mockImplementation(() => ok({ conversation: thread }));
    await render(<ConversationComposer conversationId={thread.id} />);
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "On its way");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const ctrlEnter = () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await act(async () => { ctrlEnter(); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => { ctrlEnter(); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(sdk.post).toHaveBeenCalledTimes(2);
    const [first, second] = sdk.post.mock.calls.map(([options]) => options.body);
    expect(first).toMatchObject({ body: "On its way", visibility: "public" });
    expect(second.requestKey).toBe(first.requestKey);
    expect(textarea.value).toBe("");
  });

  it("adds an internal note from the note tab", async () => {
    sdk.post.mockImplementation(() => ok({ conversation: thread }));
    await render(<ConversationComposer conversationId={thread.id} />);
    const noteTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.getAttribute("aria-label") === en.note) as HTMLElement;
    await act(async () => {
      noteTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      noteTab.click();
    });
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Refund approved by owner");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(en.addNote)!.click());
    expect(sdk.post.mock.calls[0]![0].body).toMatchObject({ visibility: "internal", body: "Refund approved by owner" });
  });

  it("keeps existing internal notes but leaves new order-editor notes to the timeline", async () => {
    sdk.getOrder.mockImplementation(() => ok({ conversation: thread }));
    sdk.post.mockImplementation(() => ok({ conversation: thread }));
    await render(<OrderConversationCard order={{ id: "ord_1", supportRequests: [] } as unknown as Order} />,
      ["conversations.view", "conversations.reply", "orders.edit"]);
    await act(async () => {
      await import("./ConversationComposer");
      await import("./ConversationMessages");
    });
    expect(host.textContent).toContain("Check the batch");
    expect(host.textContent).toContain(en.internalNote);
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(button(en.addNote)).toBeUndefined();
    const textarea = host.querySelector("textarea")!;
    expect(textarea.placeholder).toBe(en.replyPlaceholder);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Your replacement is on its way");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(en.send)!.click());
    expect(sdk.post.mock.calls[0]![0].body).toMatchObject({ visibility: "public", body: "Your replacement is on its way" });
  });

  it("keeps order conversation notes for support staff who cannot comment in the timeline", async () => {
    sdk.getOrder.mockImplementation(() => ok({ conversation: thread }));
    sdk.post.mockImplementation(() => ok({ conversation: thread }));
    await render(<OrderConversationCard order={{ id: "ord_1", supportRequests: [] } as unknown as Order} />);
    await act(async () => { await import("./ConversationComposer"); });
    const noteTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.getAttribute("aria-label") === en.note) as HTMLElement;
    await act(async () => {
      noteTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      noteTab.click();
    });
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Waiting for the courier's reply");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(en.addNote)!.click());
    expect(sdk.post.mock.calls[0]![0].body).toMatchObject({ visibility: "internal", body: "Waiting for the courier's reply" });
  });

  it("marks the thread read, closes it with its version, and hides replies from read-only staff", async () => {
    sdk.get.mockImplementation(() => ok({ conversation: thread }));
    sdk.patch.mockImplementation(() => ok({ conversation: { ...thread, status: "closed", version: 5 } }));
    await render(<ConversationPane conversationId={thread.id} currentUserId="u1" search={{}} split />);
    expect(sdk.read).not.toHaveBeenCalled();
    await showTail();
    expect(sdk.read).toHaveBeenCalledWith({ path: { id: thread.id }, body: { seq: 4 } });
    await act(async () => button(en.close)!.click());
    expect(sdk.patch).toHaveBeenCalledWith({ path: { id: thread.id }, body: { version: 4, status: "closed" } });

    act(() => root.unmount());
    root = createRoot(host);
    await render(<ConversationPane conversationId={thread.id} currentUserId="u1" search={{}} split />, ["conversations.view"]);
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain(en.readOnly);
    expect(button(en.close)).toBeUndefined();
  });
  it.each(["inbox", "order"] as const)("wires displayed read and explicit successful-send following on the real %s caller", async (caller) => {
    const snapshot = (last: number): StaffThread => ({ ...thread, lastSeq: last + 20, staffReadSeq: 0, unread: last,
      messages: Array.from({ length: 50 }, (_, index) => ({ ...thread.messages[1]!, id: `m${last - 49 + index}`, seq: last - 49 + index, attachments: [] })), hasMore: false });
    const first = snapshot(50);
    sdk.get.mockImplementation(() => ok({ conversation: first }));
    sdk.getOrder.mockImplementation(() => ok({ conversation: first }));
    sdk.post.mockImplementation(() => ok({ conversation: snapshot(52) }));
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.querySelectorAll("[data-message-seq]").length * 20; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    const client = await render(caller === "inbox"
      ? <ConversationPane conversationId={thread.id} currentUserId="u1" search={{}} />
      : <OrderConversationCard order={{ id: "ord_1", supportRequests: [] } as unknown as Order} />);
    await act(async () => { await import("./ConversationMessages"); await import("./ConversationComposer"); });
    expect(sdk.read).not.toHaveBeenCalled();
    await showTail();
    expect(sdk.read).toHaveBeenLastCalledWith({ path: { id: thread.id }, body: { seq: 50 } });
    const scroller = host.querySelector<HTMLElement>('[role="region"]')!;
    await act(async () => { scroller.scrollTop = 200; scroller.dispatchEvent(new Event("scroll")); });
    const stale = intersections.at(-1)!;
    await act(async () => client.setQueryData(caller === "inbox" ? inboxKeys.thread(thread.id) : inboxKeys.order("ord_1"), snapshot(51)));
    await act(async () => stale.emit());
    expect(sdk.read).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(200);
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Local reply");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(en.send)!.click());
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(document.activeElement).toBe(textarea);
    expect(sdk.read).toHaveBeenCalledTimes(1);
    await showTail();
    expect(sdk.read).toHaveBeenLastCalledWith({ path: { id: thread.id }, body: { seq: 52 } });
  });

  it("keeps newer successful read suppression when an older request fails, and retries its own failed frontier", async () => {
    let rejectFirst!: (reason: Error) => void;
    sdk.read.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    sdk.read.mockImplementation(() => ok({ ok: true }));
    let mark!: (seq: number) => void;
    function Marker() {
      const read = useMarkRead();
      mark = (seq) => read({ id: thread.id, staffReadSeq: 3 }, seq);
      return null;
    }
    await render(<Marker />);
    await act(async () => { mark(3); mark(4); mark(5); });
    expect(sdk.read).toHaveBeenCalledTimes(2);
    await act(async () => rejectFirst(new Error("older request failed")));
    await act(async () => mark(5));
    expect(sdk.read).toHaveBeenCalledTimes(2);
    sdk.read.mockRejectedValueOnce(new Error("latest failed"));
    await act(async () => mark(6));
    await act(async () => mark(6));
    expect(sdk.read).toHaveBeenCalledTimes(4);
    expect(sdk.read).toHaveBeenLastCalledWith({ path: { id: thread.id }, body: { seq: 6 } });
  });

  it("does not signal local success from a deferred composer response after A → B → A", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof ok>>) => void;
    sdk.post.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const onPosted = vi.fn();
    await render(<ConversationComposer conversationId={thread.id} onPosted={onPosted} />);
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Deferred reply");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(en.send)!.click());
    await render(<ConversationComposer conversationId="cnv_other0000001" onPosted={onPosted} />);
    await render(<ConversationComposer conversationId={thread.id} onPosted={onPosted} />);
    await act(async () => resolve(await ok({ conversation: thread })));
    expect(onPosted).not.toHaveBeenCalled();
  });

  it("keeps a first order reply's success signal when its newly created conversation enters the cache", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof ok>>) => void;
    sdk.postOrder.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const onPosted = vi.fn();
    await render(<ConversationComposer conversationId={null} orderId="ord_1" onPosted={onPosted} />);
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "First reply");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(en.send)!.click());
    await render(<ConversationComposer conversationId={thread.id} orderId="ord_1" onPosted={onPosted} />);
    await act(async () => resolve(await ok({ conversation: thread })));
    expect(onPosted).toHaveBeenCalledExactlyOnceWith(thread);
    expect(host.querySelector("textarea")?.value).toBe("");
  });

  it("drops a late image response after owner change and releases retained previews on sign-out", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:staged");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const pick = async () => act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "image.png", { type: "image/png" })] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const response = () => new Response(JSON.stringify({ success: true, data: { attachmentId: "att_photo0000001", conversationId: thread.id, width: 10, height: 10 } }), { status: 200 });
    await render(<ConversationComposer conversationId={thread.id} />);
    await pick();
    await render(<ConversationComposer conversationId="cnv_other0000001" />);
    await act(async () => resolve(response()));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(host.querySelector("img")).toBeNull();
    fetch.mockResolvedValueOnce(response());
    await pick();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:staged");
    act(() => root.unmount());
    root = createRoot(host);
    expect(revoke).not.toHaveBeenCalled();
    clearInboxDrafts();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:staged");
  });

  it("preserves text and new images written while a reply is pending, revoking only submitted previews", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof ok>>) => void;
    sdk.post.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const uploaded = (id: string) => new Response(JSON.stringify({ success: true, data: { attachmentId: id, conversationId: thread.id, width: 10, height: 10 } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(uploaded("att_first")).mockResolvedValueOnce(uploaded("att_next")));
    vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:next");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await render(<ConversationComposer conversationId={thread.id} />);
    const type = async (value: string) => act(async () => {
      const field = host.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const pick = async () => act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "image.png", { type: "image/png" })] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type("Submitted reply");
    await pick();
    await act(async () => button(en.send)!.click());
    await type("Next draft");
    await pick();
    await act(async () => resolve(await ok({ conversation: thread })));
    expect(host.querySelector("textarea")?.value).toBe("Next draft");
    expect([...host.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(["blob:next"]);
    expect(revoke.mock.calls).toEqual([["blob:first"]]);
    expect(sdk.post.mock.calls[0]![0].body).toMatchObject({ body: "Submitted reply", attachmentIds: ["att_first"] });
  });

  it("keeps the key for an unchanged failed retry and replaces it when the payload is edited", async () => {
    sdk.post.mockImplementation(() => Promise.resolve({ error: { success: false, error: { message: "Network" } }, response: new Response(null, { status: 503 }) }));
    await render(<ConversationComposer conversationId={thread.id} />);
    const type = async (value: string) => act(async () => {
      const field = host.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("Original reply");
    await act(async () => button(en.send)!.click());
    await act(async () => button(en.send)!.click());
    await type("Edited reply");
    await act(async () => button(en.send)!.click());
    const [first, retry, edited] = sdk.post.mock.calls.map(([options]) => options.body);
    expect(retry.requestKey).toBe(first.requestKey);
    expect(edited.requestKey).not.toBe(first.requestKey);
    expect(edited.body).toBe("Edited reply");
  });

  const typeDraft = async (value: string) => act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const chooseMode = async (label: string) => act(async () => {
    const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => (item.textContent === label || item.getAttribute("aria-label") === label))!;
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); tab.click();
  });
  it("restores independent reply/note drafts after thread navigation, without crossing accounts", async () => {
    await render(<ConversationComposer conversationId={thread.id} />);
    await typeDraft("Public reply");
    await chooseMode(en.note);
    expect(host.querySelector("textarea")!.value).toBe("");
    await typeDraft("Private note");
    await render(<ConversationComposer conversationId="other" />);
    expect(host.querySelector("textarea")!.value).toBe("");
    await render(<ConversationComposer conversationId={thread.id} />);
    expect(host.querySelector("textarea")!.value).toBe("Public reply");
    await chooseMode(en.note);
    expect(host.querySelector("textarea")!.value).toBe("Private note");
    sdk.userId = "another-staff";
    await render(<ConversationComposer conversationId={thread.id} />);
    expect(host.querySelector("textarea")!.value).toBe("");
    sdk.userId = "u1";
    await render(<ConversationComposer conversationId={thread.id} />);
    expect(host.querySelector("textarea")!.value).toBe("");
  });

  it("settles the sent reply after unmount while preserving the private note", async () => {
    let done!: (result: Awaited<ReturnType<typeof ok>>) => void;
    sdk.post.mockImplementationOnce(() => new Promise((resolve) => { done = resolve; }));
    await render(<ConversationComposer conversationId={thread.id} />);
    await typeDraft("Sent reply");
    await act(async () => button(en.send)!.click());
    await chooseMode(en.note);
    await typeDraft("Unsent note");
    await render(<ConversationComposer conversationId="other" />);
    await act(async () => done(await ok({ conversation: thread })));
    await render(<ConversationComposer conversationId={thread.id} />);
    expect(host.querySelector("textarea")!.value).toBe("");
    await chooseMode(en.note);
    expect(host.querySelector("textarea")!.value).toBe("Unsent note");
  });

  it("does not send while composing with an IME", async () => {
    sdk.post.mockImplementation(() => ok({ conversation: thread }));
    await render(<ConversationComposer conversationId={thread.id} />);
    await typeDraft("বাংলা");
    await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true })));
    expect(sdk.post).not.toHaveBeenCalled();
  });

  it("updates transient search without navigation, and never replays stale text after an external clear", async () => {
    sdk.list.mockImplementation(() => ok({ items: [], nextCursor: null }));
    const onQueryChange = vi.fn();
    const onSearchChange = vi.fn();
    await render(<InboxList search={{}} query="before" onQueryChange={onQueryChange} selectedId={null} onSearchChange={onSearchChange} />);
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "private query");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 310)));
    expect(onQueryChange).toHaveBeenLastCalledWith("private query");
    expect(onSearchChange).not.toHaveBeenCalled();
    expect(sdk.navigate).not.toHaveBeenCalled();
    await render(<InboxList search={{ status: "closed" }} query="" onQueryChange={onQueryChange} selectedId={null} onSearchChange={onSearchChange} />);
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("");
    expect(validateInboxSearch({ q: "private query", status: "closed" })).toEqual({ status: "closed" });
  });

  it("offers keyboard browsing to viewers while assignment/status/reply keys stay inert", async () => {
    sdk.get.mockImplementation(() => ok({ conversation: thread }));
    await render(<ConversationPane conversationId={thread.id} currentUserId="u1" search={{}} />, ["conversations.view"]);
    for (const key of ["a", "e", "r", "n"]) await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true })));
    expect(sdk.patch).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")).toBeNull();
  });

});
