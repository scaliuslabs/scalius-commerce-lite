// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api/transport", () => ({
  resolveBackendTarget: (path: string) => ({
    url: `https://api.internal${path}`,
    fetch: api.fetch,
    viaServiceBinding: true,
  }),
}));

import {
  markConversationRead,
  proxyConversationAttachment,
  readConversation,
  readInbox,
  type ConversationTarget,
} from "./account-inbox-server";
import { getOrderReceiptCookieName } from "./order-receipt-cookie";
import { POST as postOrderMessage } from "../pages/api/conversations/orders/[orderId]/messages";
import { POST as postThreadMessage } from "../pages/api/conversations/[id]/messages";
import { POST as postStoreThread } from "../pages/api/conversations/store";
import type { BuyerConversationThread } from "./account-inbox";

const ORIGIN = "https://shop.example.test";
const CNV = "cnv_abcdefgh1234";
const ATT = "att_image0000001";
const ORDER = "order_1";
const PROOF = `chk_${"p".repeat(40)}`;
const SESSION = "cs_tok=session-token-value";
const RECEIPT_COOKIE = `${getOrderReceiptCookieName(ORDER)}=${PROOF}`;
const BODY_TEXT = "Where is my parcel? Call 01711000000";

function thread(overrides: Partial<BuyerConversationThread> = {}): BuyerConversationThread {
  return {
    id: CNV,
    subjectType: "order",
    subject: null,
    orderId: ORDER,
    orderNumber: "#1057",
    status: "open",
    lastMessageAt: 1_790_000_000,
    unread: 1,
    lastSeq: 2,
    readSeq: 1,
    hasMore: false,
    messages: [
      { id: "msg_1", seq: 1, kind: "message", from: "buyer", body: "Hi", eventKind: null, eventData: null, createdAt: 1_790_000_000, attachments: [] },
      { id: "msg_2", seq: 2, kind: "message", from: "store", body: "Hello", eventKind: null, eventData: null, createdAt: 1_790_000_100, attachments: [] },
    ],
    ...overrides,
  };
}

function envelope(data: unknown, status = 200): Response {
  return Response.json({ success: true, data }, { status });
}

function request(path: string, init: { method?: string; cookie?: string; body?: BodyInit; accept?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { Origin: ORIGIN, ...init.headers };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.accept) headers.Accept = init.accept;
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

function form(fields: Record<string, string>, files: File[] = []): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  for (const file of files) data.append("images", file);
  return data;
}

function calls() {
  return api.fetch.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit, headers: new Headers((init as RequestInit).headers) }));
}

beforeEach(() => {
  api.fetch.mockReset();
});

describe("reads", () => {
  it("sends only the session cookie, never the buyer's other cookies", async () => {
    api.fetch.mockResolvedValue(envelope({ items: [], nextCursor: null, canStartStoreConversation: true }));
    const result = await readInbox(request("/account/inbox", { cookie: `_ga=1; ${SESSION}; ${RECEIPT_COOKIE}` }), "abc");
    expect(result).toEqual({ ok: true, data: { items: [], nextCursor: null, canStartStoreConversation: true } });
    const [call] = calls();
    expect(call?.url).toBe("https://api.internal/api/v1/customer-auth/conversations?cursor=abc");
    expect(call?.headers.get("Cookie")).toBe(SESSION);
  });

  it("is signed out without a session and never calls the API", async () => {
    await expect(readInbox(request("/account/inbox"))).resolves.toEqual({ ok: false, reason: "signed_out" });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("reads a guest order thread with the receipt proof in a header only", async () => {
    api.fetch.mockResolvedValue(envelope({ conversation: thread() }));
    const target: ConversationTarget = { kind: "order", orderId: ORDER, access: "receipt" };
    const result = await readConversation(request("/order-success", { cookie: RECEIPT_COOKIE }), target);
    expect(result.ok).toBe(true);
    const [call] = calls();
    expect(call?.url).toBe(`https://api.internal/api/v1/orders/receipt/${ORDER}/conversation`);
    expect(call?.url).not.toContain(PROOF);
    expect(call?.headers.get("X-Receipt-Token")).toBe(PROOF);
    expect(call?.headers.has("Cookie")).toBe(false);
  });

  it("hides the panel when the guest has no receipt cookie or no access", async () => {
    const target: ConversationTarget = { kind: "order", orderId: ORDER, access: "receipt" };
    await expect(readConversation(request("/order-success"), target)).resolves.toEqual({ ok: false, reason: "no_access" });
    expect(api.fetch).not.toHaveBeenCalled();
    api.fetch.mockResolvedValue(new Response("{}", { status: 404 }));
    await expect(readConversation(request("/order-success", { cookie: RECEIPT_COOKIE }), target)).resolves.toEqual({ ok: false, reason: "no_access" });
  });

  it("reads null before anyone wrote about the order", async () => {
    api.fetch.mockResolvedValue(envelope({ conversation: null }));
    const target: ConversationTarget = { kind: "order", orderId: ORDER, access: "account" };
    await expect(readConversation(request("/account/orders/order_1", { cookie: SESSION }), target)).resolves.toEqual({ ok: true, data: null });
    expect(calls()[0]?.url).toBe(`https://api.internal/api/v1/customer-auth/orders/${ORDER}/conversation`);
  });

  it("marks read up to the last shown message, through the thread id for account order threads", async () => {
    api.fetch.mockResolvedValue(envelope({ readSeq: 2 }));
    await markConversationRead(request("/account/orders/order_1", { cookie: SESSION }), { kind: "order", orderId: ORDER, access: "account" }, thread());
    const [call] = calls();
    expect(call?.url).toBe(`https://api.internal/api/v1/customer-auth/conversations/${CNV}/read`);
    expect(JSON.parse(String(call?.init.body))).toEqual({ seq: 2 });

    api.fetch.mockClear();
    await markConversationRead(request("/order-success", { cookie: RECEIPT_COOKIE }), { kind: "order", orderId: ORDER, access: "receipt" }, thread());
    expect(calls()[0]?.url).toBe(`https://api.internal/api/v1/orders/receipt/${ORDER}/conversation/read`);
    expect(calls()[0]?.headers.get("X-Receipt-Token")).toBe(PROOF);

    api.fetch.mockClear();
    await markConversationRead(request("/x", { cookie: SESSION }), { kind: "thread", conversationId: CNV }, thread({ readSeq: 2 }));
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe("attachment proxy", () => {
  it("streams WebP with private, no-store and nosniff", async () => {
    api.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/webp", "Content-Length": "3" } }));
    const response = await proxyConversationAttachment(request("/img", { cookie: RECEIPT_COOKIE }), { kind: "order", orderId: ORDER, access: "receipt" }, ATT);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(calls()[0]?.url).toBe(`https://api.internal/api/v1/orders/receipt/${ORDER}/conversation/attachments/${ATT}`);
    expect(calls()[0]?.headers.get("X-Receipt-Token")).toBe(PROOF);
  });

  it("refuses bad ids, missing proof and non-image answers", async () => {
    const target: ConversationTarget = { kind: "thread", conversationId: CNV };
    expect((await proxyConversationAttachment(request("/img", { cookie: SESSION }), target, "../secret")).status).toBe(404);
    expect((await proxyConversationAttachment(request("/img"), target, ATT)).status).toBe(404);
    expect(api.fetch).not.toHaveBeenCalled();
    api.fetch.mockResolvedValue(new Response("<html>", { headers: { "Content-Type": "text/html" } }));
    const response = await proxyConversationAttachment(request("/img", { cookie: SESSION }), target, ATT);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("form posts", () => {
  it("posts a no-JS order message with the receipt proof in a header and redirects with a flag only", async () => {
    api.fetch.mockResolvedValue(envelope({ conversation: thread() }, 201));
    const response = await postOrderMessage({
      request: request(`/api/conversations/orders/${ORDER}/messages`, {
        method: "POST",
        cookie: RECEIPT_COOKIE,
        body: form({ body: BODY_TEXT, clientMessageKey: "cmk_0123456789abcdef", returnTo: `/order-success?orderId=${ORDER}` }),
      }),
      params: { orderId: ORDER },
      url: new URL(`${ORIGIN}/api/conversations/orders/${ORDER}/messages`),
    } as never);

    expect(response.status).toBe(303);
    const location = response.headers.get("Location") ?? "";
    expect(location).toBe(`/order-success?orderId=${ORDER}&conversation=sent#conversation`);
    expect(location).not.toContain("0171");
    expect(location).not.toContain(PROOF);
    const [call] = calls();
    expect(call?.url).toBe(`https://api.internal/api/v1/orders/receipt/${ORDER}/conversation`);
    expect(call?.headers.get("X-Receipt-Token")).toBe(PROOF);
    expect(JSON.parse(String(call?.init.body))).toEqual({ body: BODY_TEXT, clientMessageKey: "cmk_0123456789abcdef" });
  });

  it("posts as the signed-in owner when the panel says access=account", async () => {
    api.fetch.mockResolvedValue(envelope({ conversation: thread() }, 201));
    const response = await postOrderMessage({
      request: request(`/api/conversations/orders/${ORDER}/messages?access=account`, {
        method: "POST",
        cookie: `${SESSION}; ${RECEIPT_COOKIE}`,
        body: form({ body: "hi", clientMessageKey: "cmk_0123456789abcdef", returnTo: `/account/orders/${ORDER}` }),
      }),
      params: { orderId: ORDER },
      url: new URL(`${ORIGIN}/api/conversations/orders/${ORDER}/messages?access=account`),
    } as never);
    expect(response.headers.get("Location")).toBe(`/account/orders/${ORDER}?conversation=sent#conversation`);
    const [call] = calls();
    expect(call?.url).toBe(`https://api.internal/api/v1/customer-auth/orders/${ORDER}/conversation`);
    expect(call?.headers.get("Cookie")).toBe(SESSION);
    expect(call?.headers.has("X-Receipt-Token")).toBe(false);
  });

  it("tells a guest whose receipt proof was refused that the thread isn't available here, not to sign in", async () => {
    api.fetch.mockResolvedValue(Response.json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid receipt" } }, { status: 401 }));
    const response = await postOrderMessage({
      request: request(`/api/conversations/orders/${ORDER}/messages`, {
        method: "POST",
        cookie: RECEIPT_COOKIE,
        body: form({ body: "hi", clientMessageKey: "cmk_0123456789abcdef", returnTo: `/order-success?orderId=${ORDER}` }),
      }),
      params: { orderId: ORDER },
      url: new URL(`${ORIGIN}/api/conversations/orders/${ORDER}/messages`),
    } as never);
    expect(response.headers.get("Location")).toBe(`/order-success?orderId=${ORDER}&conversation=missing#conversation`);
  });

  it("uploads images first, then posts with their ids, and answers an enhanced post with rendered messages", async () => {
    api.fetch
      .mockResolvedValueOnce(envelope({ attachmentId: ATT, conversationId: CNV }, 201))
      .mockResolvedValueOnce(envelope({ conversation: thread({ messages: [{ id: "msg_3", seq: 3, kind: "message", from: "buyer", body: "<b>x</b>", eventKind: null, eventData: null, createdAt: 1_790_000_000, attachments: [{ id: ATT, mediaType: "image/webp", sizeBytes: 3, width: 1, height: 1 }] }] }) }, 201));
    const response = await postThreadMessage({
      request: request(`/api/conversations/${CNV}/messages`, {
        method: "POST",
        cookie: SESSION,
        accept: "application/json",
        body: form({ body: "<b>x</b>", clientMessageKey: "cmk_0123456789abcdef", returnTo: `/account/inbox/${CNV}` }, [new File([new Uint8Array([0xff, 0xd8, 0xff])], "a.jpg", { type: "image/jpeg" })]),
      }),
      params: { id: CNV },
    } as never);

    expect(response.status).toBe(201);
    const payload = await response.json() as { success: boolean; data: { messagesHtml: string } };
    expect(payload.success).toBe(true);
    expect(payload.data.messagesHtml).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(payload.data.messagesHtml).toContain(`/api/conversations/${CNV}/attachments/${ATT}`);
    const [upload, post] = calls();
    expect(upload?.url).toBe("https://api.internal/api/v1/customer-auth/conversation-attachments");
    expect((upload?.init.body as FormData).get("conversationId")).toBe(CNV);
    expect(upload?.headers.get("Cookie")).toBe(SESSION);
    expect(post?.url).toBe(`https://api.internal/api/v1/customer-auth/conversations/${CNV}/messages`);
    expect(JSON.parse(String(post?.init.body)).attachmentIds).toEqual([ATT]);
  });

  it("turns a rate limit into the buyer's sentence (JSON) or the rate flag (redirect)", async () => {
    const limited = () => Response.json({ success: false, error: { code: "RATE_LIMITED", message: "You're sending too quickly. Please wait a moment and try again." } }, { status: 429 });
    api.fetch.mockImplementation(async () => limited());
    const fields = { body: "hi", clientMessageKey: "cmk_0123456789abcdef", returnTo: `/account/inbox/${CNV}` };
    const json = await postThreadMessage({
      request: request(`/api/conversations/${CNV}/messages`, { method: "POST", cookie: SESSION, accept: "application/json", body: form(fields) }),
      params: { id: CNV },
    } as never);
    expect(json.status).toBe(429);
    expect(await json.json()).toEqual({ success: false, error: { code: "rate", message: "You're sending too quickly. Please wait a moment and try again." } });

    const redirect = await postThreadMessage({
      request: request(`/api/conversations/${CNV}/messages`, { method: "POST", cookie: SESSION, body: form(fields) }),
      params: { id: CNV },
    } as never);
    expect(redirect.headers.get("Location")).toBe(`/account/inbox/${CNV}?conversation=rate#conversation`);
  });

  it("refuses unsafe return paths, empty bodies, too many images and cross-origin posts before calling the API", async () => {
    const empty = await postThreadMessage({
      request: request(`/api/conversations/${CNV}/messages`, { method: "POST", cookie: SESSION, body: form({ body: "   ", clientMessageKey: "cmk_0123456789abcdef", returnTo: "https://evil.test/" }) }),
      params: { id: CNV },
    } as never);
    expect(empty.headers.get("Location")).toBe(`/account/inbox/${CNV}?conversation=invalid#conversation`);

    const image = () => new File([new Uint8Array(4)], "a.png", { type: "image/png" });
    const many = await postThreadMessage({
      request: request(`/api/conversations/${CNV}/messages`, { method: "POST", cookie: SESSION, body: form({ body: "hi", clientMessageKey: "cmk_0123456789abcdef" }, [image(), image(), image(), image()]) }),
      params: { id: CNV },
    } as never);
    expect(many.headers.get("Location")).toBe(`/account/inbox/${CNV}?conversation=image#conversation`);

    const crossOrigin = await postThreadMessage({
      request: request(`/api/conversations/${CNV}/messages`, { method: "POST", cookie: SESSION, headers: { Origin: "https://evil.test" }, body: form({ body: "hi", clientMessageKey: "cmk_0123456789abcdef" }) }),
      params: { id: CNV },
    } as never);
    expect(crossOrigin.status).toBe(403);

    const badId = await postThreadMessage({
      request: request("/api/conversations/nope/messages", { method: "POST", cookie: SESSION, body: form({ body: "hi", clientMessageKey: "cmk_0123456789abcdef" }) }),
      params: { id: "nope" },
    } as never);
    expect(badId.headers.get("Location")).toBe("/account/inbox?conversation=missing#conversation");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("starts a store thread and redirects to it; a 403 means the account is not verified", async () => {
    api.fetch.mockResolvedValueOnce(envelope({ conversation: thread({ subjectType: "store", subject: "Sizes", orderId: null, orderNumber: null }) }, 201));
    const started = await postStoreThread({
      request: request("/api/conversations/store", { method: "POST", cookie: SESSION, body: form({ subject: "Sizes", body: "Do you have XL?", clientMessageKey: "cmk_0123456789abcdef" }) }),
    } as never);
    expect(started.headers.get("Location")).toBe(`/account/inbox/${CNV}?conversation=started#conversation`);
    expect(JSON.parse(String(calls()[0]?.init.body))).toEqual({ subject: "Sizes", body: "Do you have XL?", clientMessageKey: "cmk_0123456789abcdef" });

    api.fetch.mockResolvedValueOnce(Response.json({ success: false, error: { code: "FORBIDDEN", message: "Verify first" } }, { status: 403 }));
    const refused = await postStoreThread({
      request: request("/api/conversations/store", { method: "POST", cookie: SESSION, body: form({ subject: "Sizes", body: "Do you have XL?", clientMessageKey: "cmk_0123456789abcdef" }) }),
    } as never);
    expect(refused.headers.get("Location")).toBe("/account/inbox?conversation=unverified#conversation");

    const multiline = await postStoreThread({
      request: request("/api/conversations/store", { method: "POST", cookie: SESSION, body: form({ subject: "a\nb", body: "x", clientMessageKey: "cmk_0123456789abcdef" }) }),
    } as never);
    expect(multiline.headers.get("Location")).toBe("/account/inbox?conversation=invalid#conversation");
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });
});
