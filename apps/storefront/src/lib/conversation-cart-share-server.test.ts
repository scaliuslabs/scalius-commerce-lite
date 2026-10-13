// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api/transport", () => ({ resolveBackendTarget: (path: string) => ({ url: `https://api.internal${path}`, fetch: api.fetch }) }));
import { proxyConversationCartShare } from "./conversation-cart-share-server";
import { getOrderReceiptCookieName } from "./order-receipt-cookie";

const origin = "https://shop.test";
const target = { kind: "thread" as const, conversationId: "cnv_abcdefgh" };
const line = { productId: "prd_one", skuId: "sku_one", quantity: 1 };
const share = { lines: [line], products: [{ ...line, title: "Bag", variantLabel: null, status: "available", price: { amount: 20, currency: "BDT" } }], version: 1, sharedAt: 100, withdrawnAt: null };
const req = (method = "GET", body?: unknown, extra: Record<string, string> = {}) => new Request(`${origin}/api/conversations/${target.conversationId}/cart-share`, {
  method, headers: { Accept: "application/json", Origin: origin, Cookie: "cs_tok=session; other=private", ...(body ? { "Content-Type": "application/json" } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
beforeEach(() => { api.fetch.mockReset().mockResolvedValue(Response.json({ success: true, data: { cartShare: share } })); });

describe("private cart-share proxy", () => {
  it("forwards only the account cookie and returns a private minimal snapshot without prices", async () => {
    const response = await proxyConversationCartShare(req(), target);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(new Headers(api.fetch.mock.calls[0]![1].headers).get("Cookie")).toBe("cs_tok=session");
    const body = await response.text(); expect(body).not.toContain("price"); expect(body).not.toContain("session");
  });
  it("keeps receipt proof in the header, never the URL or shared lines", async () => {
    const proof = `chk_${"p".repeat(40)}`;
    const request = req("PUT", { expectedVersion: 0, lines: [{ ...line, buyerInput: "private engraving", price: 50 }] }, { Cookie: `${getOrderReceiptCookieName("ord_one")}=${proof}` });
    await proxyConversationCartShare(request, { kind: "order", orderId: "ord_one", access: "receipt" });
    const [url, init] = api.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.internal/api/v1/orders/receipt/ord_one/conversation/cart-share");
    expect(new Headers(init.headers).get("X-Receipt-Token")).toBe(proof);
    expect(new Headers(init.headers).get("Cookie")).toBeNull();
    expect(JSON.parse(init.body)).toEqual({ expectedVersion: 0, lines: [line] });
    expect(init.body).not.toContain(proof);
  });
  it("preserves a conflict so the client must reconcile consent", async () => {
    api.fetch.mockResolvedValueOnce(new Response(null, { status: 409 }));
    expect((await proxyConversationCartShare(req("PUT", { expectedVersion: 0, lines: [line] }), target)).status).toBe(409);
  });
  it("preserves unavailable-item validation instead of offering a retry for a server outage", async () => {
    api.fetch.mockResolvedValueOnce(new Response(null, { status: 422 }));
    expect((await proxyConversationCartShare(req("PUT", { expectedVersion: 0, lines: [line] }), target)).status).toBe(422);
  });
  it("rejects invalid, unbounded, empty and cross-origin mutations before the API", async () => {
    for (const body of [null, { expectedVersion: -1, lines: [line] }, { expectedVersion: 0, lines: [] }, { expectedVersion: 0, lines: [{ quantity: 1 }] }, { expectedVersion: 0, lines: [{ ...line, quantity: 100 }] }]) {
      expect((await proxyConversationCartShare(req("PUT", body), target)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await proxyConversationCartShare(req("PUT", { expectedVersion: 0, lines: [line] }, { Origin: "https://other.test" }), target)).status).toBe(403);
    expect((await proxyConversationCartShare(req("GET", undefined, { "Sec-Fetch-Site": "cross-site" }), target)).status).toBe(403);
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it("does not treat malformed success as a never-shared cart", async () => {
    api.fetch.mockResolvedValueOnce(Response.json({ success: true, data: {} }));
    expect((await proxyConversationCartShare(req(), target)).status).toBe(503);
  });
  it("requires existing positive version for withdrawal and forwards DELETE body", async () => {
    expect((await proxyConversationCartShare(req("DELETE", { expectedVersion: 0 }), target)).status).toBe(400);
    await proxyConversationCartShare(req("DELETE", { expectedVersion: 1 }), target);
    expect(api.fetch.mock.calls[0]![1].method).toBe("DELETE");
    expect(api.fetch.mock.calls[0]![1].body).toBe('{"expectedVersion":1}');
  });
});
