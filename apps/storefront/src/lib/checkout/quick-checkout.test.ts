import { describe, expect, it } from "vitest";

import {
  chooseQuickCheckoutRate,
  quickBuyNoScriptForm,
  quickCheckoutFieldErrors,
  quickCheckoutMode,
  quickCheckoutOrderForm,
  quickCheckoutPhoneCountry,
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

  it("quotes and orders another country's address by its fields, never Bangladesh's ids (MARKETS-DESIGN step 3b)", () => {
    const form = readQuickCheckoutForm(posted({
      cartItems: line(), customerName: "Abroad Buyer", customerPhone: "+14155552671", shippingCountryCode: "us",
      shippingAddress: "1 Market St", shippingLocality: "San Francisco", shippingAdminArea: "CA", shippingPostalCode: "94103",
      city: "dhaka", zone: "mirpur", expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    }));
    expect(form.shippingCountryCode).toBe("US");
    expect(quickCheckoutQuoteInput(form, "delivery", "us_standard")).toMatchObject({
      deliveryMode: "delivery",
      shippingCountryCode: "US",
      shippingAdminArea: "CA",
      shippingPostalCode: "94103",
      shippingMethodId: "us_standard",
    });
    expect(quickCheckoutQuoteInput(form, "delivery", "us_standard")).not.toHaveProperty("city");
    expect(quickCheckoutFieldErrors(form, "delivery", 10)).toEqual([]);
    const order = quickCheckoutOrderForm(form, "delivery", "us_standard", { discounts: [], items: [] });
    expect(Object.fromEntries(order.entries())).toMatchObject({
      shippingCountryCode: "US",
      shippingAddress: "1 Market St",
      shippingLocality: "San Francisco",
      shippingAdminArea: "CA",
      shippingPostalCode: "94103",
    });
    expect(order.has("city")).toBe(false);
  });

  it("reads a number typed without a country code in the delivery address's country, as the order is placed (Bangladesh for pickup)", () => {
    const abroad = readQuickCheckoutForm(posted({
      cartItems: line(), customerName: "India Buyer", customerPhone: "098765 43210", shippingCountryCode: "in",
      shippingAddress: "12 MG Road", shippingLocality: "Bengaluru", expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    }));
    expect(quickCheckoutPhoneCountry(abroad, "delivery")).toBe("IN");
    expect(quickCheckoutPhoneCountry(abroad, "pickup")).toBe("BD");
    expect(quickCheckoutFieldErrors(abroad, "delivery", 10)).toEqual([]);
    expect(quickCheckoutQuoteInput(abroad, "delivery", "in_standard")).toMatchObject({ customerPhone: "+919876543210" });
    // The same digits in a Bangladesh read are not a mobile number.
    expect(quickCheckoutFieldErrors(abroad, "pickup", 10)).toEqual(["customerPhone"]);
    expect(quickCheckoutQuoteInput(abroad, "pickup", "p1")).not.toHaveProperty("customerPhone");
    // A Bangladesh address keeps Bangladesh's rules.
    const home = readQuickCheckoutForm(posted({ cartItems: line(), customerName: "Home Buyer", customerPhone: "098765 43210", city: "dhaka", zone: "mirpur", shippingAddress: "House 1, Road 2" }));
    expect(quickCheckoutPhoneCountry(home, "delivery")).toBe("BD");
    expect(quickCheckoutFieldErrors(home, "delivery", 10)).toEqual(["customerPhone"]);
  });

  it("names every missing contact or address field before placing", () => {
    const form = readQuickCheckoutForm(posted({ cartItems: line(), customerName: "Al", customerPhone: "123", customerEmail: "x@" }));
    expect(quickCheckoutFieldErrors(form, "delivery", 10)).toEqual(["customerName", "customerPhone", "customerEmail", "shippingAddress", "city"]);
    expect(quickCheckoutFieldErrors({ ...form, customerName: "STAB Buyer", customerPhone: "01700000000", customerEmail: "" }, "pickup", 10)).toEqual([]);
  });

  const quoteItems = [{
    cartKey: "quick_buy:prod_1:var_1", productId: "prod_1", variantId: "var_1", quantity: 2, unitPrice: 550,
    productName: "Tee", variantLabel: null, fulfillmentType: "ship" as const, properties: [], propertiesPriceMinor: 5000, propertiesHash: null,
  }];

  it("orders exactly the reviewed state: the quote's applied codes, no address for pickup", () => {
    const form = { ...readQuickCheckoutForm(posted({ cartItems: line(), customerName: "STAB Buyer", customerPhone: "01700000000", shippingAddress: "House 1, Road 2", city: "dhaka", zone: "mirpur", discountCode: "NOPE", expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv" })) };
    const delivery = quickCheckoutOrderForm(form, "delivery", "rate_1", { items: quoteItems, discounts: [{ promotionId: "p", title: "EID", code: "EID10", amount: 5, shippingAmount: 0 }, { promotionId: "bundle", title: "Pair", code: null, amount: 5, shippingAmount: 0 }] });
    expect(delivery.get("discountCodes")).toBe('["EID10"]');
    expect(delivery.get("shippingLocation")).toBe("rate_1");
    expect(delivery.get("city")).toBe("dhaka");
    expect(delivery.get("expectedQuoteFingerprint")).toBe("taxq_abcdefghijklmnopqrstuv");
    // A line priced before a price change is ordered at the reviewed price, with its inputs intact.
    const ordered = JSON.parse(String(delivery.get("cartItems")))["quick_buy:prod_1:var_1"];
    expect(ordered.price).toBe(550);
    expect(ordered.properties[0].value).toBe("A&B");
    const pickup = quickCheckoutOrderForm(form, "pickup", "pick_1", { items: quoteItems, discounts: [] });
    expect(pickup.get("deliveryMode")).toBe("pickup");
    expect(pickup.get("shippingAddress")).toBeNull();
    expect(pickup.get("discountCodes")).toBe("");
    expect(quickCheckoutOrderForm(form, "none", "", { items: quoteItems, discounts: [] }).get("shippingLocation")).toBeNull();
  });

  it("carries a ticked marketing consent box to the order, and nothing when it is unticked", () => {
    const base = { cartItems: line(), customerName: "STAB Buyer", customerPhone: "01700000000", expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv" };
    const ticked = readQuickCheckoutForm(posted({ ...base, marketingConsent_email: "bn" }));
    expect(ticked.marketingConsent).toEqual({ marketingConsent_email: "bn" });
    expect(quickCheckoutOrderForm(ticked, "none", "", { items: quoteItems, discounts: [] }).get("marketingConsent_email")).toBe("bn");
    const unticked = readQuickCheckoutForm(posted(base));
    expect(unticked.marketingConsent).toEqual({});
    expect(quickCheckoutOrderForm(unticked, "none", "", { items: quoteItems, discounts: [] }).has("marketingConsent")).toBe(false);
  });
});
