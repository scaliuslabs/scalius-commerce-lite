// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { inboxMessages } from "~/i18n/inbox";

const sdk = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  read: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, params: _params, search: _search, ...props }: { to: string; children: ReactNode; params?: unknown; search?: unknown }) =>
    <a href={to} {...props}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminConversations: sdk.list,
  getApiV1AdminConversationsById: sdk.get,
  getApiV1AdminConversationsOrderByOrderId: vi.fn(),
  getApiV1AdminConversationsSummary: vi.fn(),
  patchApiV1AdminConversationsById: sdk.patch,
  postApiV1AdminConversationsByIdMessages: sdk.post,
  postApiV1AdminConversationsByIdRead: sdk.read,
  postApiV1AdminConversationsOrderByOrderIdMessages: vi.fn(),
}));

import { ConversationComposer } from "./ConversationComposer";
import { ConversationMessages } from "./ConversationMessages";
import { ConversationPane } from "./ConversationPane";
import { InboxList } from "./InboxList";
import type { StaffThread } from "./inbox-api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = inboxMessages.en;
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: new Response() });

const thread: StaffThread = {
  id: "cnv_thread0000001",
  subjectType: "order",
  subject: null,
  status: "open",
  orderId: "ord_1",
  orderNumber: "#1057",
  customerId: null,
  customerName: "Rahim Uddin",
  assigneeUserId: null,
  assigneeName: null,
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

  const render = async (node: ReactNode, permissions: string[] = ["conversations.view", "conversations.reply"]) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <PermissionProvider permissions={permissions}>{node}</PermissionProvider>
      </QueryClientProvider>,
    ));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    sdk.read.mockImplementation(() => ok({ ok: true }));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("lists conversations with who wrote, the order, a preview and the unread count", async () => {
    sdk.list.mockImplementation(() => ok({ items: [thread], nextCursor: null }));
    await render(<InboxList search={{}} selectedId={null} onSearchChange={vi.fn()} />);
    expect(sdk.list).toHaveBeenCalledWith({ query: expect.objectContaining({ status: "open" }) });
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
    await render(<InboxList search={{ q: "nothing" }} selectedId={null} onSearchChange={onSearchChange} />);
    expect(host.textContent).toContain(en["empty.filtered"]);
    await act(async () => button(en.clearFilters)!.click());
    expect(onSearchChange).toHaveBeenCalledWith({ q: undefined, assignee: undefined });
  });

  it("shows the customer's words and images, colleagues' notes marked internal, and case events", async () => {
    await render(<ConversationMessages thread={thread} currentUserId="u1" />);
    const items = [...host.querySelectorAll("ol > li")].map((item) => item.textContent ?? "");
    expect(items[0]).toContain("submitted");
    expect(items[1]).toContain("Rahim Uddin");
    expect(items[1]).toContain("The strap broke");
    expect(items[2]).toContain(en.internalNote);
    expect(items[2]).toContain("Nadia");
    expect(items[3]).toContain(en.you);
    expect(host.querySelector("img")?.getAttribute("src")).toContain("/api/v1/admin/conversations/cnv_thread0000001/attachments/att_photo0000001");
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
    const noteTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === en.note) as HTMLElement;
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

  it("marks the thread read, closes it with its version, and hides replies from read-only staff", async () => {
    sdk.get.mockImplementation(() => ok({ conversation: thread }));
    sdk.patch.mockImplementation(() => ok({ conversation: { ...thread, status: "closed", version: 5 } }));
    await render(<ConversationPane conversationId={thread.id} currentUserId="u1" search={{}} />);
    expect(sdk.read).toHaveBeenCalledWith({ path: { id: thread.id }, body: { seq: 4 } });
    await act(async () => button(en.close)!.click());
    expect(sdk.patch).toHaveBeenCalledWith({ path: { id: thread.id }, body: { version: 4, status: "closed" } });

    act(() => root.unmount());
    root = createRoot(host);
    await render(<ConversationPane conversationId={thread.id} currentUserId="u1" search={{}} />, ["conversations.view"]);
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain(en.readOnly);
    expect(button(en.close)).toBeUndefined();
  });
});
