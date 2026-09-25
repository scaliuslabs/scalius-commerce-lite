// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import {
  checkAttachmentFiles,
  conversationAttachmentUrl,
  conversationEventLine,
  conversationStatusMessage,
  conversationTitle,
  currentReturnPath,
  fetchInboxUnread,
  inboxBadgeText,
  isClientMessageKey,
  newClientMessageKey,
  readBeforeSeq,
  readConversationStatusFlag,
  readInboxCursor,
  renderConversationMessages,
  renderInboxItems,
  safeConversationReturnPath,
  statusFlagForApiStatus,
  withConversationStatus,
  type BuyerConversationMessage,
  type BuyerConversationSummary,
} from "./account-inbox";

const CNV = "cnv_abcdefgh1234";
const ATT = "att_image0000001";

function message(overrides: Partial<BuyerConversationMessage>): BuyerConversationMessage {
  return {
    id: "msg_1",
    seq: 1,
    kind: "message",
    from: "buyer",
    body: "Hello",
    eventKind: null,
    eventData: null,
    createdAt: 1_790_000_000,
    attachments: [],
    ...overrides,
  };
}

function summary(overrides: Partial<BuyerConversationSummary>): BuyerConversationSummary {
  return {
    id: CNV,
    subjectType: "store",
    subject: "Delivery question",
    orderId: null,
    orderNumber: null,
    status: "open",
    lastMessageAt: 1_790_000_000,
    unread: 0,
    ...overrides,
  };
}

const attachmentUrl = (id: string) => conversationAttachmentUrl({ access: "account", conversationId: CNV }, id);

describe("conversation rendering", () => {
  it("escapes message text and keeps line breaks as text", () => {
    const html = renderConversationMessages([
      message({ body: `<img src=x onerror="alert(1)">\nline two` }),
    ], { attachmentUrl });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;\nline two");
    expect(html).toContain("whitespace-pre-line");
  });

  it("puts the buyer on the right, the store on the left and system events in the middle", () => {
    const html = renderConversationMessages([
      message({ seq: 1, from: "buyer", body: "Mine" }),
      message({ seq: 2, from: "store", body: "Theirs" }),
      message({
        seq: 3,
        kind: "event",
        from: "system",
        body: null,
        eventKind: "support_request_submitted",
        eventData: { type: "cancel_pre_shipment", status: "submitted" },
      }),
    ], { attachmentUrl });
    const document = new DOMParser().parseFromString(`<ol>${html}</ol>`, "text/html");
    const items = [...document.querySelectorAll("li")];
    expect(items[0]?.className).toContain("justify-end");
    expect(items[1]?.className).toContain("justify-start");
    expect(items[2]?.className).toContain("text-center");
    expect(items[2]?.textContent).toContain("Cancellation request submitted");
  });

  it("shows a New divider before the first unread store line only", () => {
    const html = renderConversationMessages([
      message({ seq: 1, from: "buyer" }),
      message({ seq: 2, from: "buyer" }),
      message({ seq: 3, from: "store" }),
      message({ seq: 4, from: "store" }),
    ], { attachmentUrl, readSeq: 1 });
    expect(html.match(/role="separator"/g)).toHaveLength(1);
    expect(html.indexOf('role="separator"')).toBeGreaterThan(html.indexOf('data-seq="2"'));
    expect(html.indexOf('role="separator"')).toBeLessThan(html.indexOf('data-seq="3"'));
  });

  it("serves images through the same-origin proxy by opaque ids only", () => {
    const html = renderConversationMessages([
      message({ from: "store", attachments: [{ id: ATT, mediaType: "image/webp", sizeBytes: 10, width: 40, height: 30 }, { id: "not-an-attachment", mediaType: "image/webp", sizeBytes: 1, width: null, height: null }] }),
    ], { attachmentUrl });
    expect(html).toContain(`src="/api/conversations/${CNV}/attachments/${ATT}"`);
    expect(html).toContain('width="40" height="30"');
    expect(html).not.toContain("not-an-attachment");
    expect(conversationAttachmentUrl({ access: "receipt", orderId: "order_1" }, ATT))
      .toBe(`/api/conversations/orders/order_1/attachments/${ATT}`);
  });

  it("words support-request events for buyers", () => {
    expect(conversationEventLine({ eventKind: "support_request_status", eventData: { type: "return", fromStatus: "submitted", toStatus: "approved" }, body: null }))
      .toBe("Return request status: approved");
    expect(conversationEventLine({ eventKind: "support_request_status", eventData: { type: "refund", toStatus: "under_review" }, body: null }))
      .toBe("Refund request status: under review");
    expect(conversationEventLine({ eventKind: "something_new", eventData: null, body: null })).toBe("Conversation updated");
  });
});

describe("inbox list", () => {
  it("titles order threads by order number and store threads by subject", () => {
    expect(conversationTitle(summary({ subjectType: "order", orderNumber: "#1057", subject: null }))).toBe("Order #1057");
    expect(conversationTitle(summary({ subjectType: "store", subject: "  " }))).toBe("Message to the store");
  });

  it("marks unread threads with a dot and a count and escapes subjects", () => {
    const html = renderInboxItems([
      summary({ id: CNV, subject: "<b>Hi</b>", unread: 3 }),
      summary({ id: "cnv_other0000000", unread: 0, status: "pending" }),
      summary({ id: "../../admin", unread: 1 }),
    ]);
    const document = new DOMParser().parseFromString(`<ul>${html}</ul>`, "text/html");
    const links = [...document.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(`/account/inbox/${CNV}`);
    expect(links[0]?.textContent).toContain("<b>Hi</b>");
    expect(links[0]?.textContent).toContain("3 new");
    expect(links[0]?.querySelector("span[aria-hidden]")?.className).toContain("bg-primary");
    expect(links[1]?.textContent).toContain("Store replied");
    expect(links[1]?.querySelector("span[aria-hidden]")?.className).toContain("bg-transparent");
  });

  it("formats the badge", () => {
    expect(inboxBadgeText(0)).toBe("");
    expect(inboxBadgeText(-2)).toBe("");
    expect(inboxBadgeText(7)).toBe("7");
    expect(inboxBadgeText(150)).toBe("99+");
  });

  it("reads the unread count through the same-origin proxy and treats failures as zero", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, data: { unread: 4 } }));
    await expect(fetchInboxUnread(fetcher as unknown as typeof fetch)).resolves.toBe(4);
    expect(fetcher).toHaveBeenCalledWith("/api/customer-auth/conversations/unread", expect.objectContaining({ credentials: "same-origin" }));
    await expect(fetchInboxUnread((async () => new Response("", { status: 401 })) as unknown as typeof fetch)).resolves.toBe(0);
    await expect(fetchInboxUnread((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).resolves.toBe(0);
  });
});

describe("post/redirect/get flags and return paths", () => {
  it("only accepts known flags from the URL", () => {
    expect(readConversationStatusFlag(new URL("https://s.test/account/inbox?conversation=sent"))).toBe("sent");
    expect(readConversationStatusFlag(new URL("https://s.test/account/inbox?conversation=%3Cscript%3E"))).toBeNull();
    expect(conversationStatusMessage("rate").text).toBe("You're sending too quickly. Please wait a moment and try again.");
  });

  it("maps API answers to flags", () => {
    expect(statusFlagForApiStatus(201)).toBe("sent");
    expect(statusFlagForApiStatus(201, "start")).toBe("started");
    expect(statusFlagForApiStatus(400)).toBe("invalid");
    expect(statusFlagForApiStatus(400, "upload")).toBe("image");
    expect(statusFlagForApiStatus(503, "upload")).toBe("image");
    expect(statusFlagForApiStatus(401)).toBe("signin");
    expect(statusFlagForApiStatus(403, "start")).toBe("unverified");
    expect(statusFlagForApiStatus(404)).toBe("missing");
    expect(statusFlagForApiStatus(409, "start")).toBe("limit");
    expect(statusFlagForApiStatus(429)).toBe("rate");
    expect(statusFlagForApiStatus(502)).toBe("unavailable");
  });

  it("returns only to the pages that host a conversation form", () => {
    expect(safeConversationReturnPath("/order-success?orderId=order_1&conversation=rate")).toBe("/order-success?orderId=order_1");
    expect(safeConversationReturnPath(`/account/inbox/${CNV}`)).toBe(`/account/inbox/${CNV}`);
    expect(safeConversationReturnPath("/account/orders/order_1")).toBe("/account/orders/order_1");
    expect(safeConversationReturnPath("/track-order")).toBe("/track-order");
    for (const unsafe of ["//evil.test/account/inbox", "https://evil.test/account/inbox", "/\\evil.test", "/checkout", "/account/inbox/../../checkout", "account/inbox", "/account/orders/", null, 7]) {
      expect(safeConversationReturnPath(unsafe)).toBeNull();
    }
  });

  it("puts only the flag and the anchor on the redirect", () => {
    expect(withConversationStatus("/order-success?orderId=order_1", "sent")).toBe("/order-success?orderId=order_1&conversation=sent#conversation");
    expect(currentReturnPath(new URL("https://s.test/account/inbox/cnv_abcdefgh1234?conversation=sent#x"))).toBe("/account/inbox/cnv_abcdefgh1234");
  });
});

describe("form fields", () => {
  it("makes a fresh idempotency key per render", () => {
    const first = newClientMessageKey();
    expect(isClientMessageKey(first)).toBe(true);
    expect(newClientMessageKey()).not.toBe(first);
    expect(isClientMessageKey("short")).toBe(false);
    expect(isClientMessageKey("has spaces in it")).toBe(false);
  });

  it("checks chosen images and ignores the empty no-JS file part", () => {
    const image = (size: number, type = "image/jpeg") => new File([new Uint8Array(size)], "photo.jpg", { type });
    expect(checkAttachmentFiles([new File([], "", { type: "application/octet-stream" }), "text"])).toEqual({ ok: true, files: [] });
    expect(checkAttachmentFiles([image(10), image(10), image(10), image(10)])).toEqual({ ok: false, reason: "too_many" });
    expect(checkAttachmentFiles([image(5 * 1024 * 1024 + 1)])).toEqual({ ok: false, reason: "too_large" });
    expect(checkAttachmentFiles([image(10, "application/pdf")])).toEqual({ ok: false, reason: "wrong_type" });
    const ok = checkAttachmentFiles([image(10), image(10, "image/webp")]);
    expect(ok.ok && ok.files).toHaveLength(2);
  });

  it("reads list cursors and sequence numbers defensively", () => {
    expect(readInboxCursor("MTc5MDAwMDAwMDpjbnZfYWJj")).toBe("MTc5MDAwMDAwMDpjbnZfYWJj");
    expect(readInboxCursor("a b")).toBeUndefined();
    expect(readInboxCursor(null)).toBeUndefined();
    expect(readBeforeSeq("12")).toBe(12);
    expect(readBeforeSeq("0")).toBeUndefined();
    expect(readBeforeSeq("-3")).toBeUndefined();
    expect(readBeforeSeq("1e3")).toBeUndefined();
  });
});
