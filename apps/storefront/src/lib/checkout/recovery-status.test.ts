// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@scalius/shared/hash";
import { inspectCheckoutRecovery } from "./recovery-status";

const recovery = {
  href: "/order-success?orderId=order_1&payment=stripe",
  gateway: "stripe", orderId: "order_1", checkoutId: "checkout-request-1",
  cartFingerprint: null, createdAt: 1,
};
afterEach(() => vi.unstubAllGlobals());

describe("checkout recovery inspection", () => {
  it.each([
    ["expired", "order_1", "expired"],
    ["completed", "order_1", "active"],
    ["expired", "order_other", "unknown"],
    ["processing", "order_1", "unknown"],
    ["failed", "order_1", "unknown"],
  ])("maps %s for %s to %s without changing its pointer", async (status, orderId, expected) => {
    const request = vi.fn(async () => Response.json({ success: true, data: { status, orderId } }));
    vi.stubGlobal("fetch", request);
    const original = { ...recovery };
    expect(await inspectCheckoutRecovery(recovery)).toBe(expected);
    expect(recovery).toEqual(original);
    expect(request).toHaveBeenCalledWith("/api/checkout/recovery-status", expect.objectContaining({
      method: "POST", cache: "no-store",
      body: JSON.stringify({ statusToken: `cst_${await sha256Hex(recovery.checkoutId)}` }),
    }));
  });

  it("leaves missing identities and failed or malformed responses unknown", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ success: true, data: { status: "expired", orderId: "order_1" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ success: false, data: { status: "expired", orderId: "order_1" } }))
      .mockResolvedValueOnce(new Response("not JSON"));
    vi.stubGlobal("fetch", request);
    expect(await inspectCheckoutRecovery({ ...recovery, checkoutId: null })).toBe("unknown");
    expect(request).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) expect(await inspectCheckoutRecovery(recovery)).toBe("unknown");
  });
});
