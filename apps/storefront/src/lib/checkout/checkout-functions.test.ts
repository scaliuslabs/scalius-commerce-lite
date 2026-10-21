// Store app checkout functions as the storefront reads them: the quote's
// delivery options, payment methods and app discount lines, and the rules and
// refusals in an error answer. A quote without apps must parse exactly as before.
import { describe, expect, it, vi } from "vitest";

import {
  discountLineKey,
  parseTaxQuoteEnvelope,
  TaxQuoteContractError,
  type CheckoutTaxQuote,
} from "./tax-quote-contract";
import {
  cartRuleRefusal,
  checkoutOrderRefusal,
  parseCartRuleErrors,
  refusedDeliveryRates,
} from "./tax-quote-error-contract";
import {
  fetchAuthoritativeTaxQuote,
  TaxQuoteCartRulesError,
  TaxQuoteDeliveryRateError,
} from "./tax-quote-client";

function quote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    valid: true,
    quoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    displayLabel: "VAT",
    pricesIncludeTax: false,
    shippingTaxed: false,
    currencyCode: "BDT",
    decimalPlaces: 2,
    settingsVersion: 1,
    subtotalMinor: 30_000,
    subtotalAmount: 300,
    shippingMinor: 4_000,
    shippingAmount: 40,
    discountMinor: 0,
    discountAmount: 0,
    taxMinor: 0,
    taxAmount: 0,
    totalMinor: 34_000,
    totalAmount: 340,
    deliveryMethodKind: "delivery",
    requiresShipping: true,
    pickup: null,
    allowedPaymentMethods: ["cod", "bkash"],
    shippingMethod: {
      id: "ship_express",
      name: "Express (app)",
      description: null,
      baseAmountMinor: 4_000,
      feeWaived: false,
    },
    discounts: [],
    offers: [],
    rejectedCodes: [],
    items: [{
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "var_1",
      quantity: 2,
      unitPrice: 150,
      productName: "Cotton Panjabi",
      variantLabel: null,
      fulfillmentType: "ship",
      properties: [],
      propertiesPriceMinor: 0,
      propertiesHash: "none",
    }],
    ...overrides,
  };
}

const APP_RATES = [
  { id: "ship_express", name: "Express (app)", kind: "delivery", amount: 40, amountMinor: 4_000 },
  { id: "ship_standard", name: "Standard", kind: "delivery", amount: 0, amountMinor: 0 },
];

describe("quote fields a store app sets", () => {
  it("leaves a quote without apps exactly as before (no new keys)", () => {
    const parsed = parseTaxQuoteEnvelope({ success: true, data: quote({ shippingRates: null, paymentMethods: null }) });
    expect(parsed).not.toHaveProperty("shippingRates");
    expect(parsed).not.toHaveProperty("paymentMethods");
    expect(parseTaxQuoteEnvelope({ success: true, data: quote() })).toEqual(parsed);
  });

  it("reads the delivery options and payment methods an app left, in its order", () => {
    const parsed = parseTaxQuoteEnvelope({
      success: true,
      data: quote({
        shippingRates: APP_RATES,
        paymentMethods: [{ id: "bkash", name: "bKash (5% off)" }, { id: "cod", name: "Pay at the door" }],
      }),
    });
    expect(parsed.shippingRates).toEqual(APP_RATES);
    expect(parsed.paymentMethods).toEqual([
      { id: "bkash", name: "bKash (5% off)" },
      { id: "cod", name: "Pay at the door" },
    ]);
    // The proxy re-serializes the parsed quote: it must read back the same.
    expect(parseTaxQuoteEnvelope({ success: true, data: JSON.parse(JSON.stringify(parsed)) })).toEqual(parsed);
  });

  it.each([
    ["not a list", { shippingRates: { id: "ship_express" } }],
    ["an unknown kind", { shippingRates: [{ ...APP_RATES[0], kind: "drone" }] }],
    ["an amount that contradicts its minor units", { shippingRates: [{ ...APP_RATES[0], amount: 400 }] }],
    ["a negative fee", { shippingRates: [{ ...APP_RATES[0], amount: -1, amountMinor: -100 }] }],
    ["the same option twice", { shippingRates: [APP_RATES[0], APP_RATES[0]] }],
    ["a name with a control character", { shippingRates: [{ ...APP_RATES[0], name: "Express\u0000" }] }],
    ["an over-long name", { shippingRates: [{ ...APP_RATES[0], name: "x".repeat(101) }] }],
    ["a method without a name", { paymentMethods: [{ id: "cod" }] }],
    ["the same method twice", { paymentMethods: [{ id: "cod", name: "A" }, { id: "cod", name: "B" }] }],
    ["methods that are not a list", { paymentMethods: "cod" }],
  ])("refuses a quote with %s", (_label, overrides) => {
    expect(() => parseTaxQuoteEnvelope({ success: true, data: quote(overrides) })).toThrow(TaxQuoteContractError);
  });

  it("reads an app's discount line (no promotion) and keys it by app and position", () => {
    const parsed = parseTaxQuoteEnvelope({
      success: true,
      data: quote({
        discountMinor: 3_000,
        discountAmount: 30,
        totalMinor: 31_000,
        totalAmount: 310,
        discounts: [
          { promotionId: "promo_1", appId: null, title: "Eid 5%", code: null, amount: 15, shippingAmount: 0 },
          { promotionId: null, appId: "app_loyalty", title: "Loyalty reward", code: null, amount: 15, shippingAmount: 0 },
        ],
      }),
    });
    expect(parsed.discounts).toEqual([
      { promotionId: "promo_1", title: "Eid 5%", code: null, amount: 15, shippingAmount: 0 },
      { promotionId: null, appId: "app_loyalty", title: "Loyalty reward", code: null, amount: 15, shippingAmount: 0 },
    ]);
    expect(parsed.discounts.map((line, position) => discountLineKey(line, position)))
      .toEqual(["promo_1", "app:app_loyalty:1"]);
  });

  it("refuses a discount line with neither a promotion nor an app", () => {
    expect(() => parseTaxQuoteEnvelope({
      success: true,
      data: quote({
        discounts: [{ promotionId: null, appId: null, title: "?", code: null, amount: 0, shippingAmount: 0 }],
      }),
    })).toThrow(TaxQuoteContractError);
  });
});

describe("rules and refusals in an error answer", () => {
  it("bounds app rule messages to plain text and keeps line references only when they are one", () => {
    expect(parseCartRuleErrors([
      { code: "max_qty", message: "  At most 10\nper order  ", index: 0, cartKey: "line_1" },
      { code: "min_total", message: "Spend ৳500 to check out.", index: null, cartKey: null },
      { code: "bad_index", message: "Whole cart", index: -1, cartKey: 42 },
      { code: "no_message", message: "" },
      { code: "too_long", message: "x".repeat(301) },
      "not a rule",
    ])).toEqual([
      { code: "max_qty", message: "At most 10 per order", index: 0, cartKey: "line_1" },
      { code: "min_total", message: "Spend ৳500 to check out.", index: null, cartKey: null },
      { code: "bad_index", message: "Whole cart", index: null, cartKey: null },
    ]);
    expect(parseCartRuleErrors(Array.from({ length: 80 }, (_, index) => ({ code: "r", message: `Rule ${index}` }))))
      .toHaveLength(50);
    expect(parseCartRuleErrors(undefined)).toEqual([]);
  });

  it("reads a rules refusal, and still blocks when its rules are unreadable", () => {
    const rules = [{ code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1" }];
    expect(cartRuleRefusal({ success: false, error: { code: "validation_error", details: { reason: "cart_rules", ruleErrors: rules } } }))
      .toEqual(rules);
    expect(cartRuleRefusal({ details: { reason: "cart_rules", ruleErrors: "nope" } }))
      .toEqual([{ code: "cart_rules", message: "", index: null, cartKey: null }]);
    expect(cartRuleRefusal({ details: { reason: "delivery_rate_unavailable" } })).toBeNull();
  });

  it("reads the options still offered when an app hid the chosen one, or none when malformed", () => {
    expect(refusedDeliveryRates({ details: { reason: "delivery_rate_unavailable", shippingRates: APP_RATES } }))
      .toEqual(APP_RATES);
    expect(refusedDeliveryRates({ details: { reason: "delivery_rate_unavailable" } })).toBeNull();
    expect(refusedDeliveryRates({ details: { reason: "delivery_rate_unavailable", shippingRates: [{ id: "x" }] } }))
      .toBeNull();
  });

  it("names the order refusals the checkout repairs itself", () => {
    expect(checkoutOrderRefusal({ details: { reason: "payment_method_unavailable" } }))
      .toEqual({ reason: "payment_method_unavailable" });
    expect(checkoutOrderRefusal({ details: { reason: "cart_rules", ruleErrors: [{ code: "c", message: "No." }] } }))
      .toEqual({ reason: "cart_rules", ruleErrors: [{ code: "c", message: "No.", index: null, cartKey: null }] });
    expect(checkoutOrderRefusal({ details: { reason: "delivery_rate_unavailable", shippingRates: APP_RATES } }))
      .toEqual({ reason: "delivery_rate_unavailable", shippingRates: APP_RATES });
    expect(checkoutOrderRefusal({ details: { itemIssues: [] } })).toBeNull();
  });
});

describe("the browser's quote request with app functions", () => {
  const checkoutData = {
    cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", quantity: 2 } }),
    city: "city_1",
    zone: "zone_1",
    shippingMethodId: "ship_express",
  };
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("turns a rules refusal into the app's rules", async () => {
    const error = await fetchAuthoritativeTaxQuote(checkoutData, answer(400, {
      success: false,
      error: "Current checkout total is unavailable",
      details: { reason: "cart_rules", ruleErrors: [{ code: "max_qty", message: "At most 10.", index: 0, cartKey: "line_1" }] },
    })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaxQuoteCartRulesError);
    expect((error as TaxQuoteCartRulesError).ruleErrors).toEqual([
      { code: "max_qty", message: "At most 10.", index: 0, cartKey: "line_1" },
    ]);
  });

  it("carries the options still offered with a refused delivery option", async () => {
    const error = await fetchAuthoritativeTaxQuote(checkoutData, answer(400, {
      success: false,
      details: { reason: "delivery_rate_unavailable", shippingRates: [APP_RATES[1]] },
    })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaxQuoteDeliveryRateError);
    expect((error as TaxQuoteDeliveryRateError).shippingRates).toEqual([APP_RATES[1]]);

    const plain = await fetchAuthoritativeTaxQuote(checkoutData, answer(400, {
      success: false,
      details: { reason: "delivery_rate_unavailable" },
    })).catch((caught: unknown) => caught);
    expect((plain as TaxQuoteDeliveryRateError).shippingRates).toBeNull();
  });

  it("accepts a quote that carries the app's options", async () => {
    const parsed: CheckoutTaxQuote = await fetchAuthoritativeTaxQuote(
      checkoutData,
      answer(200, { success: true, data: quote({ shippingRates: APP_RATES }) }),
    );
    expect(parsed.shippingRates?.map(({ id }) => id)).toEqual(["ship_express", "ship_standard"]);
  });
});
