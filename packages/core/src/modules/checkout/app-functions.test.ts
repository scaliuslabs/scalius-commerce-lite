// The pure rules that merge app function outputs into checkout: discount
// stacking (after the platform's, never below zero, caps, cash rounding,
// shipping-only targets, gift cards, codes), delivery and payment method
// operations, and where cart rule errors land.
import { describe, expect, it, vi } from "vitest";
import type { PluginFunctionOutput } from "@scalius/shared/plugins";
import {
  applyAppPaymentMethodOperations,
  applyAppShippingRateOperations,
  buildAppFunctionCart,
  collectCheckoutRuleErrors,
  combineDiscountAllocations,
  resolveAppDiscounts,
  type CheckoutAppFunctionResult,
  type CheckoutRateOption,
} from "./app-functions";

type Discount = PluginFunctionOutput<"checkout.discounts">["discounts"][number];

function result<P extends "checkout.discounts" | "checkout.shipping_rates" | "checkout.payment_methods" | "cart.validate">(
  pluginId: string,
  output: PluginFunctionOutput<P>,
): CheckoutAppFunctionResult<P> {
  return { pluginId, appName: `${pluginId} app`, priority: 100, output };
}
const discounts = (pluginId: string, ...list: Discount[]) => result<"checkout.discounts">(pluginId, { discounts: list });
const percentOff = (percent: number, target: Discount["target"] = { kind: "order" }, extra: Partial<Discount> = {}): Discount =>
  ({ title: `${percent}% off`, target, value: { type: "percentage", percent }, ...extra });
const fixedOff = (amountMinor: number, target: Discount["target"] = { kind: "order" }, extra: Partial<Discount> = {}): Discount =>
  ({ title: `${amountMinor} off`, target, value: { type: "fixed_amount", amountMinor }, ...extra });

const LINES = [
  { lineId: "cart:0:v_a", grossMinor: 100_000, platformDiscountMinor: 10_000 },
  { lineId: "cart:1:v_b", grossMinor: 50_000, platformDiscountMinor: 0 },
];

function resolve(results: Array<CheckoutAppFunctionResult<"checkout.discounts">>, overrides: Partial<Parameters<typeof resolveAppDiscounts>[0]> = {}) {
  return resolveAppDiscounts({
    currencyCode: "BDT",
    priceIncrementMinor: 100,
    lines: LINES,
    shippingMinor: 6_000,
    platformShippingDiscountMinor: 0,
    submittedCodes: [],
    results,
    ...overrides,
  });
}

describe("app discount stacking", () => {
  it("applies after the platform's discount, on what is left, split by value in whole taka", () => {
    const resolution = resolve([discounts("acme.bulk", percentOff(10))]);
    // 90,000 + 50,000 left; 10% = 14,000, split 9,000 / 5,000.
    expect(resolution.applied).toEqual([{
      pluginId: "acme.bulk", appName: "acme.bulk app", title: "10% off", code: null, target: "order",
      amountMinor: 14_000, shippingAmountMinor: 0,
      lines: [{ lineId: "cart:0:v_a", amountMinor: 9_000 }, { lineId: "cart:1:v_b", amountMinor: 5_000 }],
    }]);
    expect(resolution.merchandiseMinor).toBe(14_000);
  });

  it("never takes a line below zero: later discounts see only what is left", () => {
    const resolution = resolve([
      discounts("a.first", fixedOff(1_000_000, { kind: "lines", lineIds: ["cart:1:v_b"] })),
      discounts("b.second", percentOff(50, { kind: "lines", lineIds: ["cart:1:v_b"] })),
    ]);
    expect(resolution.applied).toHaveLength(1);
    expect(resolution.applied[0]).toMatchObject({ pluginId: "a.first", amountMinor: 50_000, lines: [{ lineId: "cart:1:v_b", amountMinor: 50_000 }] });
  });

  it("honours a cap, floored to the price increment, and rounds percentages half-up to it (whole taka by default)", () => {
    const capped = resolve([discounts("acme.cap", percentOff(50, { kind: "order" }, { maxAmountMinor: 5_050 }))]);
    expect(capped.applied[0]!.amountMinor).toBe(5_000);
    // 12.5% of 90,000 + 50,000 = 17,500 (whole taka already); 3.33% = 4,662 → 4,700 (half-up to 100 paisa).
    expect(resolve([discounts("acme.odd", percentOff(3.33))]).applied[0]!.amountMinor).toBe(4_700);
    // USD keeps cents, and so does a BDT store that prices in paisa.
    expect(resolve([discounts("acme.odd", percentOff(3.33))], { currencyCode: "USD", priceIncrementMinor: 1 }).applied[0]!.amountMinor).toBe(4_662);
    expect(resolve([discounts("acme.odd", percentOff(3.33))], { priceIncrementMinor: 1 }).applied[0]!.amountMinor).toBe(4_662);
    // A fixed amount with paisa is floored to whole taka.
    expect(resolve([discounts("acme.fixed", fixedOff(1_299))]).applied[0]!.amountMinor).toBe(1_200);
  });

  it("a shipping discount lowers delivery only, after the platform's delivery discount", () => {
    const resolution = resolve([discounts("acme.ship", percentOff(100, { kind: "shipping" }))], { platformShippingDiscountMinor: 2_000 });
    expect(resolution.applied).toEqual([expect.objectContaining({ target: "shipping", amountMinor: 0, shippingAmountMinor: 4_000, lines: [] })]);
    expect(resolution.merchandiseMinor).toBe(0);
    expect(resolution.shippingMinor).toBe(4_000);
    // Free delivery already: nothing to take, nothing applied.
    expect(resolve([discounts("acme.ship", fixedOff(500, { kind: "shipping" }))], { shippingMinor: 0 }).applied).toEqual([]);
  });

  it("never discounts a gift-card line, and skips (and reports) a discount naming a line not in the cart", () => {
    const report = vi.fn();
    const lines = [...LINES, { lineId: "cart:2:v_card", grossMinor: 100_000, platformDiscountMinor: 0, giftCard: true }];
    const order = resolve([discounts("acme.all", percentOff(10))], { lines });
    expect(order.applied[0]!.lines.map((line) => line.lineId)).toEqual(["cart:0:v_a", "cart:1:v_b"]);
    const onlyCard = resolve([discounts("acme.card", percentOff(10, { kind: "lines", lineIds: ["cart:2:v_card"] }))], { lines });
    expect(onlyCard.applied).toEqual([]);
    const unknown = resolve([discounts("acme.ghost", percentOff(10, { kind: "lines", lineIds: ["cart:9:v_ghost"] }))], { apps: { report } });
    expect(unknown.applied).toEqual([]);
    expect(report).toHaveBeenCalledWith("acme.ghost", "checkout.discounts", expect.stringContaining("not in the cart"));
  });

  it("a code-driven discount applies only with its code, and claims the code", () => {
    const coded = discounts("acme.code", percentOff(10, { kind: "order" }, { code: "bulk10" }));
    expect(resolve([coded]).applied).toEqual([]);
    const withCode = resolve([coded], { submittedCodes: ["Bulk10"] });
    expect(withCode.applied[0]).toMatchObject({ code: "BULK10", amountMinor: 14_000 });
    expect(withCode.claimedCodes).toEqual(["BULK10"]);
  });

  it("applies apps in the order given (priority order) and each app's discounts in order", () => {
    const resolution = resolve([
      discounts("a.first", fixedOff(20_000, { kind: "lines", lineIds: ["cart:0:v_a"] }), fixedOff(5_000)),
      discounts("b.second", percentOff(10)),
    ]);
    expect(resolution.applied.map((entry) => [entry.pluginId, entry.amountMinor])).toEqual([
      ["a.first", 20_000],
      ["a.first", 5_000],
      // 70,000 − 3,000 + 50,000 − 2,000 (5,000 split 70:50 in whole taka) = 115,000 left; 10% = 11,500.
      ["b.second", 11_500],
    ]);
  });

  it("combines with the platform allocation for the tax quote", () => {
    const app = resolve([discounts("acme.bulk", percentOff(10)), discounts("acme.ship", fixedOff(1_000, { kind: "shipping" }))]).applied;
    expect(combineDiscountAllocations({ lines: [{ lineId: "cart:0:v_a", amountMinor: 10_000 }], shippingMinor: 500 }, app)).toEqual({
      lines: [{ lineId: "cart:0:v_a", amountMinor: 19_000 }, { lineId: "cart:1:v_b", amountMinor: 5_000 }],
      shippingMinor: 1_500,
    });
    expect(combineDiscountAllocations(undefined, [])).toBeUndefined();
  });
});

describe("app delivery and payment operations", () => {
  const rates: CheckoutRateOption[] = [
    { rateId: "m_std", name: "Standard", kind: "delivery", amountMinor: 6_000, baseAmountMinor: 6_000, waived: false },
    { rateId: "m_exp", name: "Express", kind: "delivery", amountMinor: 12_000, baseAmountMinor: 12_000, waived: false },
    { rateId: "m_free", name: "Saver", kind: "delivery", amountMinor: 0, baseAmountMinor: 8_000, waived: true },
    { rateId: "m_pick", name: "Pickup", kind: "pickup", amountMinor: 0, baseAmountMinor: 0, waived: false },
  ];
  const ops = (pluginId: string, operations: PluginFunctionOutput<"checkout.shipping_rates">["operations"]) =>
    result<"checkout.shipping_rates">(pluginId, { operations });

  it("hides, renames, prices and reorders; never adds; a waived rate stays free; hidden stays hidden", () => {
    const report = vi.fn();
    const adjusted = applyAppShippingRateOperations(rates, [
      ops("a.first", [
        { op: "hide", rateId: "m_exp" },
        { op: "rename", rateId: "m_std", name: "Dhaka standard" },
        { op: "price", rateId: "m_std", amountMinor: 7_049 },
        { op: "price", rateId: "m_free", amountMinor: 9_000 },
        { op: "price", rateId: "m_new", amountMinor: 1 },
      ]),
      ops("b.second", [{ op: "rename", rateId: "m_exp", name: "Back" }, { op: "reorder", rateIds: ["m_pick", "m_std"] }]),
    ], 100, { report });
    expect(adjusted.changed).toBe(true);
    expect(adjusted.rates).toEqual([
      { rateId: "m_pick", name: "Pickup", kind: "pickup", amountMinor: 0, baseAmountMinor: 0, waived: false },
      { rateId: "m_std", name: "Dhaka standard", kind: "delivery", amountMinor: 7_000, baseAmountMinor: 7_000, waived: false },
      { rateId: "m_free", name: "Saver", kind: "delivery", amountMinor: 0, baseAmountMinor: 9_000, waived: true },
    ]);
    expect(report).toHaveBeenCalledWith("a.first", "checkout.shipping_rates", expect.stringContaining("m_new"));
  });

  it("reports no change when the operations change nothing", () => {
    expect(applyAppShippingRateOperations(rates, [ops("a.noop", [{ op: "rename", rateId: "m_std", name: "Standard" }])], 100).changed).toBe(false);
  });

  it("payment methods: hide, rename, reorder only what checkout allows", () => {
    const report = vi.fn();
    const methods = [{ methodId: "cod", name: "Cash on Delivery" }, { methodId: "stripe", name: "Card" }, { methodId: "sslcommerz", name: "bKash/Nagad" }];
    const adjusted = applyAppPaymentMethodOperations(methods, [result<"checkout.payment_methods">("acme.pay", {
      operations: [
        { op: "hide", methodId: "cod" },
        { op: "rename", methodId: "stripe", name: "Visa / Mastercard" },
        { op: "reorder", methodIds: ["sslcommerz"] },
        { op: "hide", methodId: "polar" },
      ],
    })], { report });
    expect(adjusted).toEqual({
      changed: true,
      methods: [{ methodId: "sslcommerz", name: "bKash/Nagad" }, { methodId: "stripe", name: "Visa / Mastercard" }],
    });
    expect(report).toHaveBeenCalledWith("acme.pay", "checkout.payment_methods", expect.stringContaining("polar"));
  });

  // Security audit S4: an app's pay-later method fails closed.
  it("payment methods: an app's deferred method is offered only when its own app allows it", () => {
    const report = vi.fn();
    const methods = [{ methodId: "stripe", name: "Card" }, { methodId: "acme.credit:invoice", name: "Pay in 30 days" }];
    const gated = new Set(["acme.credit:invoice"]);
    // The app timed out or failed: no answer, so nothing offers credit.
    expect(applyAppPaymentMethodOperations(methods, [], { report }, gated).methods.map((method) => method.methodId)).toEqual(["stripe"]);
    // Another app cannot open someone else's credit line.
    const foreign = applyAppPaymentMethodOperations(methods, [
      result<"checkout.payment_methods">("other.app", { operations: [{ op: "allow", methodId: "acme.credit:invoice" }] }),
    ], { report }, gated);
    expect(foreign.methods.map((method) => method.methodId)).toEqual(["stripe"]);
    expect(report).toHaveBeenCalledWith("other.app", "checkout.payment_methods", expect.stringContaining("only its own app"));
    // Its own app's allow offers it; a hide from any app still wins.
    const own = result<"checkout.payment_methods">("acme.credit", { operations: [{ op: "allow", methodId: "acme.credit:invoice" }] });
    expect(applyAppPaymentMethodOperations(methods, [own], { report }, gated).methods.map((method) => method.methodId))
      .toEqual(["stripe", "acme.credit:invoice"]);
    expect(applyAppPaymentMethodOperations(methods, [own, result<"checkout.payment_methods">("other.app", {
      operations: [{ op: "hide", methodId: "acme.credit:invoice" }],
    })], { report }, gated).methods.map((method) => method.methodId)).toEqual(["stripe"]);
  });

  it("payment methods: any app may allow the built-in invoice the merchant lets apps decide", () => {
    const methods = [{ methodId: "net_terms", name: "Invoice" }];
    const allowed = applyAppPaymentMethodOperations(methods, [
      result<"checkout.payment_methods">("acme.b2b", { operations: [{ op: "allow", methodId: "net_terms" }] }),
    ], undefined, new Set(["net_terms"]));
    expect(allowed.methods.map((method) => method.methodId)).toEqual(["net_terms"]);
  });
});

describe("cart rule errors", () => {
  it("land on their line (index and cart key), or on the whole cart; duplicates collapse", () => {
    const report = vi.fn();
    const lines = new Map([["cart:0:v_a", { index: 0, cartKey: "line:a" }], ["cart:1:v_b", { index: 1, cartKey: null }]]);
    const errors = collectCheckoutRuleErrors([
      result<"cart.validate">("acme.rules", { errors: [
        { code: "max_quantity", message: "At most 10.", lineId: "cart:1:v_b" },
        { code: "max_quantity", message: "At most 10.", lineId: "cart:1:v_b" },
        { code: "min_order", message: "Spend ৳500 to order." },
        { code: "ghost", message: "Unknown line.", lineId: "cart:7:v_x" },
      ] }),
    ], lines, { report });
    expect(errors).toEqual([
      { code: "max_quantity", message: "At most 10.", index: 1, cartKey: null },
      { code: "min_order", message: "Spend ৳500 to order.", index: null, cartKey: null },
      { code: "ghost", message: "Unknown line.", index: null, cartKey: null },
    ]);
    expect(report).toHaveBeenCalledOnce();
  });
});

describe("the app cart", () => {
  it("carries totals after the platform's discounts, facts, region only and normalized codes", () => {
    const cart = buildAppFunctionCart({
      currency: { code: "bdt", decimalPlaces: 2 },
      channel: "online_store",
      lines: [{
        lineId: "cart:0:v_a", productId: "p_a", variantId: "v_a", title: "Tee (M)", quantity: 2, unitPriceMinor: 50_000,
        discountMinor: 10_000, properties: [{ key: "engraving", value: "Anika" }],
      }],
      facts: {
        products: new Map([["p_a", { categoryIds: ["cat_child", "cat_root"], collectionIds: ["col_1"], brandId: "brand_1" }]]),
        skus: new Map([["v_a", "TEE-M"]]),
        customer: { id: "cust_1", tags: ["vip", "wholesale"], orderCount: 3, totalSpentMinor: 250_000 },
        market: { id: "mkt_backup", country: "BD" },
      },
      destination: { city: "Dhaka", zone: null },
      discountCodes: [" bulk10 ", "BULK10"],
    });
    expect(cart).toEqual({
      currency: "BDT",
      decimalPlaces: 2,
      channel: "online_store",
      lines: [{
        lineId: "cart:0:v_a", productId: "p_a", variantId: "v_a", sku: "TEE-M", title: "Tee (M)", quantity: 2,
        unitPriceMinor: 50_000, lineTotalMinor: 90_000, categoryIds: ["cat_child", "cat_root"], collectionIds: ["col_1"],
        brandId: "brand_1", properties: { engraving: "Anika" },
      }],
      subtotalMinor: 90_000,
      customer: { id: "cust_1", tags: ["vip", "wholesale"], orderCount: 3, totalSpentMinor: 250_000 },
      destination: { country: "BD", city: "Dhaka", zone: null },
      discountCodes: ["BULK10"],
      market: { id: "mkt_backup", country: "BD" },
      attributes: {},
    });
  });
});
