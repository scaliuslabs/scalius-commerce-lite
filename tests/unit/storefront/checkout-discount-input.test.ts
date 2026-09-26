import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrder } from "../../../apps/storefront/src/lib/checkout/create-order";
import { readDiscountCodes } from "../../../apps/storefront/src/lib/checkout/tax-quote-client";

afterEach(() => vi.unstubAllGlobals());

describe("checkout discount input", () => {
  it("extracts the codes from the cart JSON and keeps client amounts out of the order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: "order_1" } })));
    vi.stubGlobal("fetch", fetchMock);
    await createOrder({
      checkoutRequestId: "checkout_1",
      expectedQuoteFingerprint: `taxq_${"a".repeat(22)}`,
      cartItems: "{}",
      discountCodes: JSON.stringify(["SAVE10"]),
      discountCodeHidden: JSON.stringify({ id: "disc_1", code: "FORGED", amount: 120 }),
      discountAmount: "999",
    }, "cod");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.discountCodes).toEqual(["SAVE10"]);
    expect(body).not.toHaveProperty("discountAmount");
    expect(body).not.toHaveProperty("discountCodeHidden");
    expect(body).not.toHaveProperty("discountCode");
  });

  it("accepts direct code arrays from non-cart callers", () => {
    expect(readDiscountCodes({ discountCodes: ["save10"], discountAmount: "75" })).toEqual(["SAVE10"]);
  });

  it("does not revive legacy hidden code or client amount fields", () => {
    expect(readDiscountCodes({ discountCodeHidden: "SAVE10", discountCode: "SAVE10", discountAmount: "75" })).toEqual([]);
  });

  it.each(["SAVE10", "{broken", "null", "{}"])("fails closed for malformed transferred codes %s", (discountCodes) => {
    expect(readDiscountCodes({ discountCodes })).toEqual([]);
  });
});
