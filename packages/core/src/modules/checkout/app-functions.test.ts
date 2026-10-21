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
  platformDiscountClasses,
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
        customer: { id: "cust_1", tags: ["vip", "wholesale"], orderCount: 3, totalSpentMinor: 250_000, roles: [] },
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
        // No SKU facts: read as a physical good of unknown weight; a one-time purchase.
        requiresShipping: true, weightGrams: null, purchaseOption: null,
      }],
      salesChannelId: "sc_online_store",
      subtotalMinor: 90_000,
      customer: { id: "cust_1", tags: ["vip", "wholesale"], segmentIds: [], orderCount: 3, totalSpentMinor: 250_000, roles: [] },
      destination: { country: "BD", city: "Dhaka", zone: null },
      discountCodes: ["BULK10"],
      market: { id: "mkt_backup", country: "BD" },
      attributes: {},
    });
  });
});

describe("the app cart's channel, shipping and purchase facts", () => {
  const facts = {
    products: new Map([
      ["p_tee", { categoryIds: [], collectionIds: [], brandId: null, isGiftCard: false }],
      ["p_card", { categoryIds: [], collectionIds: [], brandId: null, isGiftCard: true }],
      ["p_ebook", { categoryIds: [], collectionIds: [], brandId: null, isGiftCard: false }],
    ]),
    skus: new Map<string, string | null>(),
    variants: new Map([
      ["v_tee", { weightGrams: 250, physical: true }],
      ["v_card", { weightGrams: null, physical: true }],
      ["v_ebook", { weightGrams: null, physical: false }],
    ]),
    customer: { id: "cust_1", tags: [], segmentIds: [], orderCount: 0, totalSpentMinor: 0, roles: [] },
    market: { id: "mkt_backup", country: null },
  };
  const line = (productId: string, variantId: string, extra: { purchaseOption?: string | null } = {}) => ({
    lineId: `cart:0:${variantId}`, productId, variantId, title: productId, quantity: 1, unitPriceMinor: 1_000, discountMinor: 0, properties: [], ...extra,
  });

  it("says which lines ship and what they weigh: a gift card and a digital SKU require no shipping", () => {
    const cart = buildAppFunctionCart({
      currency: { code: "BDT", decimalPlaces: 2 }, channel: "online_store",
      lines: [line("p_tee", "v_tee", { purchaseOption: "acme.subscribe.monthly" }), line("p_card", "v_card"), line("p_ebook", "v_ebook")],
      facts, destination: null, discountCodes: [],
    });
    expect(cart.lines.map(({ requiresShipping, weightGrams, purchaseOption }) => ({ requiresShipping, weightGrams, purchaseOption }))).toEqual([
      { requiresShipping: true, weightGrams: 250, purchaseOption: "acme.subscribe.monthly" },
      { requiresShipping: false, weightGrams: null, purchaseOption: null },
      { requiresShipping: false, weightGrams: null, purchaseOption: null },
    ]);
  });

  it("names the sales channel the commit derives (agents sell the agents channel) unless the caller resolved one", () => {
    const build = (channel: "online_store" | "agent" | "admin", salesChannelId?: string) => buildAppFunctionCart({
      currency: { code: "BDT", decimalPlaces: 2 }, channel, ...(salesChannelId ? { salesChannelId } : {}),
      lines: [line("p_tee", "v_tee")], facts, destination: null, discountCodes: [],
    }).salesChannelId;
    expect(build("online_store")).toBe("sc_online_store");
    expect(build("agent")).toBe("sc_agents");
    expect(build("admin")).toBe("sc_online_store");
    expect(build("admin", "acme.tiktok:shop")).toBe("acme.tiktok:shop");
  });

  it("gives a signed-in buyer the segments that price the cart, sorted and unique, and a guest none", () => {
    const signedIn = buildAppFunctionCart({
      currency: { code: "BDT", decimalPlaces: 2 }, channel: "online_store", segmentIds: ["seg_wholesale", "seg_vip", "seg_vip"],
      lines: [line("p_tee", "v_tee")], facts, destination: null, discountCodes: [],
    });
    expect(signedIn.customer?.segmentIds).toEqual(["seg_vip", "seg_wholesale"]);
    const guest = buildAppFunctionCart({
      currency: { code: "BDT", decimalPlaces: 2 }, channel: "online_store", segmentIds: ["seg_vip"],
      lines: [line("p_tee", "v_tee")], facts: { ...facts, customer: null }, destination: null, discountCodes: [],
    });
    expect(guest.customer).toBeNull();
  });
});

describe("discount classes and combinesWith", () => {
  const notWith = (key: "product" | "order" | "shipping"): Partial<Discount> => ({ combinesWith: { [key]: false } });
  const lineTarget = { kind: "lines" as const, lineIds: ["cart:1:v_b"] };
  const noPlatform = { lines: LINES.map((entry) => ({ ...entry, platformDiscountMinor: 0 })) };

  it("stacks everything when no discount says otherwise (today's behaviour)", () => {
    const resolution = resolve([
      discounts("a.first", fixedOff(1_000, lineTarget), fixedOff(1_000), fixedOff(1_000, { kind: "shipping" })),
      discounts("b.second", fixedOff(1_000, lineTarget), fixedOff(1_000), fixedOff(1_000, { kind: "shipping" })),
    ]);
    expect(resolution.applied).toHaveLength(6);
  });

  it("applies a pair only when each combines with the other's class, in priority then output order", () => {
    // [first's class, second's class, the key the second turns off, the key the first turns off] → both apply?
    const classes = { product: lineTarget, order: { kind: "order" as const }, shipping: { kind: "shipping" as const } } as const;
    const keyOf = { product: "product", order: "order", shipping: "shipping" } as const;
    for (const first of ["product", "order", "shipping"] as const) {
      for (const second of ["product", "order", "shipping"] as const) {
        const both = resolve([discounts("a.first", fixedOff(1_000, classes[first])), discounts("b.second", fixedOff(1_000, classes[second]))], noPlatform);
        expect(both.applied.map((entry) => entry.pluginId), `${first}+${second}`).toEqual(["a.first", "b.second"]);
        // The second refuses the first's class: it is skipped.
        const refusedBySecond = resolve([
          discounts("a.first", fixedOff(1_000, classes[first])),
          discounts("b.second", fixedOff(1_000, classes[second], notWith(keyOf[first]))),
        ], noPlatform);
        expect(refusedBySecond.applied.map((entry) => entry.pluginId), `${first}+${second} refused by second`).toEqual(["a.first"]);
        // The first refuses the second's class: the second is skipped, the first stands.
        const refusedByFirst = resolve([
          discounts("a.first", fixedOff(1_000, classes[first], notWith(keyOf[second]))),
          discounts("b.second", fixedOff(1_000, classes[second])),
        ], noPlatform);
        expect(refusedByFirst.applied.map((entry) => entry.pluginId), `${first}+${second} refused by first`).toEqual(["a.first"]);
      }
    }
  });

  it("checks a candidate against every discount already applied, the platform's included", () => {
    // The platform took 10,000 off a line (a product discount): an app discount that does not combine with product discounts is skipped.
    const skipped = resolve([discounts("a.order", fixedOff(1_000, { kind: "order" }, notWith("product")))]);
    expect(skipped.applied).toEqual([]);
    // An order-level promotion counts as an order discount, not a product one.
    const orderPromotion = resolve([discounts("a.order", fixedOff(1_000, { kind: "order" }, notWith("product")))], { platformClasses: ["order"] });
    expect(orderPromotion.applied.map((entry) => entry.pluginId)).toEqual(["a.order"]);
    // No platform discount: nothing constrains it.
    expect(resolve([discounts("a.order", fixedOff(1_000, { kind: "order" }, notWith("product")))], noPlatform).applied).toHaveLength(1);
    // A skipped discount constrains nothing after it.
    const chain = resolve([
      discounts("a.ship", fixedOff(1_000, { kind: "shipping" })),
      discounts("b.picky", fixedOff(1_000, { kind: "order" }, notWith("shipping"))),
      discounts("c.plain", fixedOff(1_000, lineTarget, notWith("order"))),
    ], noPlatform);
    expect(chain.applied.map((entry) => entry.pluginId)).toEqual(["a.ship", "c.plain"]);
  });

  it("lets a skipped code-driven discount claim no code and spend no commit", () => {
    const commit = { pluginId: "a.loyalty", object: "balance", public: false, events: false, id: "cust_1", expectedRevision: 1, dataJson: "{}", columns: {} };
    const resolution = resolve([
      { ...discounts("a.loyalty", fixedOff(1_000, { kind: "order" }, { code: "POINTS", ...notWith("product") })), commits: [commit] },
    ], { submittedCodes: ["points"] });
    expect(resolution.applied).toEqual([]);
    expect(resolution.claimedCodes).toEqual([]);
    expect(resolution.commits).toEqual([]);
  });

  it("reads the platform's classes from what it applied", () => {
    const promotion = (discountClass: "product" | "order" | "shipping", totalDiscountMinor: number) => ({ discountClass, totalDiscountMinor });
    expect(platformDiscountClasses({ discount: { applied: null }, bundleLines: [], allocation: undefined })).toEqual([]);
    expect(platformDiscountClasses({ discount: { applied: { discounts: [promotion("order", 500), promotion("shipping", 0)] } }, bundleLines: [], allocation: { lines: [], shippingMinor: 0 } })).toEqual(["order"]);
    expect(platformDiscountClasses({ discount: { applied: null }, bundleLines: [{ lineId: "l", amountMinor: 100 }], allocation: { lines: [], shippingMinor: 0 } })).toEqual(["product"]);
    // Free shipping bundled with an item discount counts as a shipping discount too.
    expect(platformDiscountClasses({ discount: { applied: { discounts: [promotion("product", 500)] } }, bundleLines: [], allocation: { lines: [], shippingMinor: 300 } }).sort()).toEqual(["product", "shipping"]);
  });
});
