import { describe, expect, it } from "vitest";

import {
  chooseQuickCheckoutRate,
  quickBuyNoScriptForm,
  quickCheckoutFieldErrors,
  quickCheckoutMode,
  quickCheckoutOrderForm,
  quickCheckoutQuoteInput,
  readQuickCheckoutForm,
  readQuickCheckoutLines,
} from "./quick-checkout";

const line = (fulfillmentKind?: string) => JSON.stringify({
  "quick_buy:prod_1:var_1": {
    id: "prod_1",
    variantId: "var_1",
    name: "Tee <b>",
    price: 1,
    quantity: 2,
    ...(fulfillmentKind ? { fulfillmentKind } : {}),
    properties: [{ key: "engraving", value: "A&B", label: "Engraving", displayValue: "A&B", priceMinor: 5000 }],
  },
});

function posted(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

describe("checkout without JavaScript", () => {
  it("carries the quick-buy line in a form body, never a URL, escaped for HTML", () => {
    const html = quickBuyNoScriptForm(JSON.parse(line("physical")));
    expect(html).toContain('<form method="post" action="/checkout/quick">');
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("A&amp;B");
    expect(html).not.toContain("?cartItems");
    expect(html).toMatch(/name="checkoutId" value="chk_session_[A-Za-z0-9_-]{8,}"/);
    expect(html.startsWith("<noscript>")).toBe(true);
  });

  it("reads the posted form, keeps a valid checkout id and replaces a forged one", () => {
    const kept = readQuickCheckoutForm(posted({ cartItems: line(), checkoutId: "chk_session_abcdefgh12", discountCode: " eid10 ", intent: "place" }));
    expect(kept.checkoutId).toBe("chk_session_abcdefgh12");
    expect(kept.discountCode).toBe("EID10");
    expect(kept.intent).toBe("place");
    const forged = readQuickCheckoutForm(posted({ checkoutId: "x\"><script>", city: "bad id!", expectedQuoteFingerprint: "nope" }));
    expect(forged.checkoutId).toMatch(/^chk_session_/);
    expect(forged.city).toBe("");
    expect(forged.expectedQuoteFingerprint).toBe("");
    expect(forged.intent).toBe("review");
  });

  it("refuses an empty or unreadable cart and picks the path from the lines", () => {
    expect(readQuickCheckoutLines("{}")).toBeNull();
    expect(readQuickCheckoutLines("not json")).toBeNull();
    const physical = readQuickCheckoutLines(line("physical"))!;
    const service = readQuickCheckoutLines(line("service"))!;
    expect(physical).toEqual([{ cartKey: "quick_buy:prod_1:var_1", name: "Tee <b>", quantity: 2, fulfillmentKind: "physical" }]);
    expect(quickCheckoutMode(service, { deliveryMode: "delivery" }, true, true)).toBe("none");
    expect(quickCheckoutMode(physical, { deliveryMode: "pickup" }, true, true)).toBe("pickup");
    expect(quickCheckoutMode(physical, { deliveryMode: "pickup" }, false, true)).toBe("delivery");
    expect(quickCheckoutMode(physical, { deliveryMode: "delivery" }, true, false)).toBe("pickup");
  });

  it("quotes only once the address and an offered option are known", () => {
    const form = readQuickCheckoutForm(posted({ cartItems: line(), customerPhone: "01700000000", city: "dhaka", zone: "" }));
    expect(chooseQuickCheckoutRate([{ id: "a" }, { id: "b" }], "b")).toBe("b");
    expect(chooseQuickCheckoutRate([{ id: "a" }], "gone")).toBe("a");
    expect(quickCheckoutQuoteInput(form, "delivery", "a")).toBeNull();
    expect(quickCheckoutQuoteInput({ ...form, zone: "mirpur" }, "delivery", "")).toBeNull();
    expect(quickCheckoutQuoteInput({ ...form, zone: "mirpur", discountCode: "EID10" }, "delivery", "a")).toMatchObject({
      deliveryMode: "delivery", city: "dhaka", zone: "mirpur", shippingMethodId: "a",
      discountCodes: '["EID10"]', customerPhone: "+8801700000000",
    });
    const pickup = quickCheckoutQuoteInput(form, "pickup", "p1")!;
    expect(pickup).not.toHaveProperty("city");
    expect(pickup.shippingMethodId).toBe("p1");
    expect(quickCheckoutQuoteInput(form, "none", "")).not.toHaveProperty("shippingMethodId");
  });

  it("names every missing contact or address field before placing", () => {
    const form = readQuickCheckoutForm(posted({ cartItems: line(), customerName: "Al", customerPhone: "123", customerEmail: "x@" }));
    expect(quickCheckoutFieldErrors(form, "delivery", 10)).toEqual(["customerName", "customerPhone", "customerEmail", "shippingAddress", "city"]);
    expect(quickCheckoutFieldErrors({ ...form, customerName: "STAB Buyer", customerPhone: "01700000000", customerEmail: "" }, "pickup", 10)).toEqual([]);
  });

  it("orders exactly the reviewed state: the quote's applied codes, no address for pickup", () => {
    const form = { ...readQuickCheckoutForm(posted({ cartItems: line(), customerName: "STAB Buyer", customerPhone: "01700000000", shippingAddress: "House 1, Road 2", city: "dhaka", zone: "mirpur", discountCode: "NOPE", expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv" })) };
    const delivery = quickCheckoutOrderForm(form, "delivery", "rate_1", { discounts: [{ promotionId: "p", title: "EID", code: "EID10", amount: 5, shippingAmount: 0 }, { promotionId: "bundle", title: "Pair", code: null, amount: 5, shippingAmount: 0 }] });
    expect(delivery.get("discountCodes")).toBe('["EID10"]');
    expect(delivery.get("shippingLocation")).toBe("rate_1");
    expect(delivery.get("city")).toBe("dhaka");
    expect(delivery.get("expectedQuoteFingerprint")).toBe("taxq_abcdefghijklmnopqrstuv");
    const pickup = quickCheckoutOrderForm(form, "pickup", "pick_1", { discounts: [] });
    expect(pickup.get("deliveryMode")).toBe("pickup");
    expect(pickup.get("shippingAddress")).toBeNull();
    expect(pickup.get("discountCodes")).toBe("");
    expect(quickCheckoutOrderForm(form, "none", "", { discounts: [] }).get("shippingLocation")).toBeNull();
  });
});
