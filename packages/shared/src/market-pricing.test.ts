import { describe, expect, it } from "vitest";

import {
  applicablePriceListPrices,
  cardPriceOf,
  fxPriceMinor,
  marketFxPolicyIssue,
  marketFxRate,
  maxBaseForFxPrice,
  minBaseForFxPrice,
  nextPriceListBoundary,
  resolvePrice,
  resolvedPriceAsCatalogPrice,
  type FxConversion,
  type PriceListPrice,
  type PriceListRow,
} from "./market-pricing";
import { discountedPriceMinor } from "./money";

/** BDT (2 dp, whole taka) to USD (2 dp, cents): 1 BDT = 0.0091 USD. */
const usd = (policy: Partial<FxConversion["policy"]> = {}, incrementMinor = 1): FxConversion => ({
  policy: { rate: "0.0091", adjustmentBps: 0, roundingMinor: null, endingMinor: null, ...policy },
  fromDecimalPlaces: 2,
  toDecimalPlaces: 2,
  incrementMinor,
});

describe("fxPriceMinor", () => {
  it("converts a shop price into another currency at the exact rate, half-up to the increment", () => {
    // 1,000 BDT × 0.0091 = 9.10 USD.
    expect(fxPriceMinor(100_000, usd())).toBe(910);
    // 1,234.56 BDT × 0.0091 = 11.234496 USD → 11.23.
    expect(fxPriceMinor(123_456, usd())).toBe(1_123);
    // 1,235 BDT × 0.0091 = 11.2385 → 11.24 (half-up).
    expect(fxPriceMinor(123_500, usd())).toBe(1_124);
  });

  it("converts between exponents (BDT to JPY and to KWD)", () => {
    // 1,000 BDT × 1.25 = 1,250 JPY (0 dp).
    expect(fxPriceMinor(100_000, { ...usd({ rate: "1.25" }), toDecimalPlaces: 0 })).toBe(1_250);
    // 1,000 BDT × 0.0025 = 2.500 KWD (3 dp).
    expect(fxPriceMinor(100_000, { ...usd({ rate: "0.0025" }), toDecimalPlaces: 3 })).toBe(2_500);
  });

  it("applies the percentage adjustment before rounding, once", () => {
    // 1,000 BDT × 0.0091 × 1.15 = 10.465 → 10.47.
    expect(fxPriceMinor(100_000, usd({ adjustmentBps: 1_500 }))).toBe(1_047);
    // −10 %: 8.19.
    expect(fxPriceMinor(100_000, usd({ adjustmentBps: -1_000 }))).toBe(819);
  });

  it("rounds up to the step and applies the ending (charm pricing)", () => {
    // 11.2345 → up to 12.00 → .99 ending → 11.99.
    expect(fxPriceMinor(123_456, usd({ roundingMinor: 100, endingMinor: 99 }))).toBe(1_199);
    // 9.10 → up to 10.00 → ending .95 → 9.95.
    expect(fxPriceMinor(100_000, usd({ roundingMinor: 100, endingMinor: 95 }))).toBe(995);
    // Whole dollars, no ending: 9.10 → 10.00.
    expect(fxPriceMinor(100_000, usd({ roundingMinor: 100 }))).toBe(1_000);
    // A tiny price never charms to zero.
    expect(fxPriceMinor(100, usd({ roundingMinor: 100, endingMinor: 99 }))).toBe(99);
  });

  it("is the identity for the shop currency without an adjustment, and keeps zero", () => {
    const same: FxConversion = { policy: { rate: "1", adjustmentBps: 0, roundingMinor: null, endingMinor: null }, fromDecimalPlaces: 2, toDecimalPlaces: 2, incrementMinor: 100 };
    for (const base of [100, 9_900, 123_400, 50_000_000]) expect(fxPriceMinor(base, same)).toBe(base);
    expect(fxPriceMinor(0, same)).toBe(0);
    // Whole taka: +10 % of 999 taka is 1,098.90 → 1,099.
    expect(fxPriceMinor(99_900, { ...same, policy: { ...same.policy, adjustmentBps: 1_000 } })).toBe(109_900);
    // Rounded up to 10 taka, ending in 9 taka.
    expect(fxPriceMinor(99_900, { ...same, policy: { ...same.policy, adjustmentBps: 1_000, roundingMinor: 1_000, endingMinor: 900 } })).toBe(109_900);
  });

  it("refuses broken policies", () => {
    expect(marketFxPolicyIssue({ rate: "0", adjustmentBps: 0, roundingMinor: null, endingMinor: null }, 1)).toBe("rate");
    expect(marketFxPolicyIssue({ rate: "1", adjustmentBps: -10_000, roundingMinor: null, endingMinor: null }, 1)).toBe("adjustment");
    expect(marketFxPolicyIssue({ rate: "1", adjustmentBps: 0, roundingMinor: 150, endingMinor: null }, 100)).toBe("rounding");
    expect(marketFxPolicyIssue({ rate: "1", adjustmentBps: 0, roundingMinor: null, endingMinor: 99 }, 1)).toBe("ending");
    expect(marketFxPolicyIssue({ rate: "1", adjustmentBps: 0, roundingMinor: 100, endingMinor: 100 }, 1)).toBe("ending");
    expect(marketFxPolicyIssue({ rate: "1", adjustmentBps: 0, roundingMinor: 1_000, endingMinor: 950 }, 100)).toBe("ending");
    expect(marketFxPolicyIssue({ rate: "1.5", adjustmentBps: 2_000, roundingMinor: 1_000, endingMinor: 900 }, 100)).toBeNull();
  });

  it("inverts a market price bound to a base price bound exactly", () => {
    const conversion = usd({ adjustmentBps: 1_500, roundingMinor: 100, endingMinor: 99 });
    for (const marketMax of [99, 999, 1_199, 1_200, 25_000]) {
      const base = maxBaseForFxPrice(marketMax, conversion, 10_000_000);
      expect(fxPriceMinor(base, conversion)).toBeLessThanOrEqual(marketMax);
      expect(fxPriceMinor(base + 1, conversion)).toBeGreaterThan(marketMax);
      const lower = minBaseForFxPrice(marketMax, conversion, 10_000_000);
      expect(fxPriceMinor(lower, conversion)).toBeGreaterThanOrEqual(marketMax);
      if (lower > 0) expect(fxPriceMinor(lower - 1, conversion)).toBeLessThan(marketMax);
    }
  });
});

describe("marketFxRate", () => {
  it("is 1 for the shop currency, the manual rate otherwise, and null without one", () => {
    expect(marketFxRate({ currencyCode: "BDT", fxRate: "5" }, "bdt")).toBe("1");
    expect(marketFxRate({ currencyCode: "USD", fxRate: "0.0091" }, "BDT")).toBe("0.0091");
    expect(marketFxRate({ currencyCode: "USD", fxRate: null }, "BDT")).toBeNull();
    expect(marketFxRate({ currencyCode: "USD", fxRate: "abc" }, "BDT")).toBeNull();
  });
});

const price = (overrides: Partial<PriceListPrice> & Pick<PriceListPrice, "priceListId" | "kind" | "amountMinor">): PriceListPrice => ({
  priority: 0,
  compareAtMinor: null,
  minQuantity: 1,
  ...overrides,
});

describe("resolvePrice", () => {
  const base = { priceMinor: 120_000, effectiveMinor: 100_000 };
  const plain = { base, prices: [], fx: null, incrementMinor: 100 };

  it("is the base buyer price with the catalogue compare-at without lists or FX", () => {
    expect(resolvePrice(plain)).toEqual({ amountMinor: 100_000, compareAtMinor: 120_000, source: "base", priceListId: null });
    expect(resolvePrice({ ...plain, base: { priceMinor: 100_000, effectiveMinor: 100_000 } }).compareAtMinor).toBeNull();
  });

  it("derives from FX (amount and compare-at) when the market is in fx mode", () => {
    const resolved = resolvePrice({ ...plain, fx: usd(), incrementMinor: 1 });
    expect(resolved).toEqual({ amountMinor: 910, compareAtMinor: 1_092, source: "fx", priceListId: null });
  });

  it("follows sale > segment > market > FX > base", () => {
    const market = price({ priceListId: "pl_m", kind: "market", amountMinor: 90_000 });
    const segment = price({ priceListId: "pl_s", kind: "segment", amountMinor: 95_000 });
    const sale = price({ priceListId: "pl_x", kind: "sale", amountMinor: 97_000 });
    const fx = usd();
    expect(resolvePrice({ ...plain, fx, prices: [market] }).source).toBe("market");
    expect(resolvePrice({ ...plain, fx, prices: [market, segment] }).source).toBe("segment");
    expect(resolvePrice({ ...plain, fx, prices: [market, segment, sale] })).toMatchObject({ source: "sale", amountMinor: 97_000, priceListId: "pl_x" });
  });

  it("places an app price below every list and above FX and base (cart.line_prices)", () => {
    const app = { amountMinor: 85_049, pluginId: "acme.b2b" };
    // Above base: rounds half-up to the increment, struck against the price without it.
    expect(resolvePrice({ ...plain, app })).toEqual({ amountMinor: 85_000, compareAtMinor: 120_000, source: "app", priceListId: null });
    // Above FX.
    expect(resolvePrice({ ...plain, fx: usd(), incrementMinor: 1, app: { amountMinor: 800, pluginId: "acme.b2b" } }))
      .toMatchObject({ amountMinor: 800, compareAtMinor: 1_092, source: "app" });
    // Every list outranks it: market and price-list rules stay authoritative.
    const market = price({ priceListId: "pl_m", kind: "market", amountMinor: 90_000 });
    expect(resolvePrice({ ...plain, prices: [market], app })).toMatchObject({ source: "market", amountMinor: 90_000 });
    const sale = price({ priceListId: "pl_x", kind: "sale", amountMinor: 97_000 });
    // A sale without its own compare-at compares against the price without sales, never an app price.
    expect(resolvePrice({ ...plain, prices: [sale], app }).compareAtMinor).toBe(100_000);
    // A surcharge price is allowed; a price never reaches zero; a broken one is ignored.
    expect(resolvePrice({ ...plain, app: { amountMinor: 130_000, pluginId: "acme.b2b" } })).toMatchObject({ amountMinor: 130_000, compareAtMinor: null });
    expect(resolvePrice({ ...plain, app: { amountMinor: 10, pluginId: "acme.b2b" } }).amountMinor).toBe(100);
    expect(resolvePrice({ ...plain, app: { amountMinor: 0, pluginId: "acme.b2b" } }).source).toBe("base");
    expect(resolvePrice({ ...plain, app: { amountMinor: 1.5, pluginId: "acme.b2b" } }).source).toBe("base");
  });

  it("breaks ties by priority, then the lowest amount, then the list id", () => {
    const low = price({ priceListId: "pl_b", kind: "market", amountMinor: 80_000, priority: 1 });
    const high = price({ priceListId: "pl_a", kind: "market", amountMinor: 90_000, priority: 5 });
    expect(resolvePrice({ ...plain, prices: [low, high] }).priceListId).toBe("pl_a");
    const cheap = price({ priceListId: "pl_c", kind: "market", amountMinor: 70_000, priority: 5 });
    expect(resolvePrice({ ...plain, prices: [low, high, cheap] }).priceListId).toBe("pl_c");
    const twin = price({ priceListId: "pl_0", kind: "market", amountMinor: 70_000, priority: 5 });
    expect(resolvePrice({ ...plain, prices: [cheap, twin] }).priceListId).toBe("pl_0");
    expect(resolvePrice({ ...plain, prices: [twin, cheap] }).priceListId).toBe("pl_0");
  });

  it("honours quantity breaks within a list", () => {
    const prices = [
      price({ priceListId: "pl_w", kind: "segment", amountMinor: 90_000 }),
      price({ priceListId: "pl_w", kind: "segment", amountMinor: 80_000, minQuantity: 10 }),
      price({ priceListId: "pl_w", kind: "segment", amountMinor: 70_000, minQuantity: 50 }),
    ];
    expect(resolvePrice({ ...plain, prices, quantity: 1 }).amountMinor).toBe(90_000);
    expect(resolvePrice({ ...plain, prices, quantity: 10 }).amountMinor).toBe(80_000);
    expect(resolvePrice({ ...plain, prices, quantity: 49 }).amountMinor).toBe(80_000);
    expect(resolvePrice({ ...plain, prices, quantity: 500 }).amountMinor).toBe(70_000);
    // A list whose only row needs more units does not apply yet.
    const bulkOnly = [price({ priceListId: "pl_b", kind: "sale", amountMinor: 60_000, minQuantity: 5 })];
    expect(resolvePrice({ ...plain, prices: bulkOnly, quantity: 4 }).source).toBe("base");
    expect(resolvePrice({ ...plain, prices: bulkOnly, quantity: 5 }).source).toBe("sale");
  });

  it("keeps the row's compare-at; a sale without one compares against the price without sales", () => {
    const market = price({ priceListId: "pl_m", kind: "market", amountMinor: 90_000, compareAtMinor: 110_000 });
    expect(resolvePrice({ ...plain, prices: [market] }).compareAtMinor).toBe(110_000);
    const noCompare = price({ priceListId: "pl_m", kind: "market", amountMinor: 90_000 });
    expect(resolvePrice({ ...plain, prices: [noCompare] }).compareAtMinor).toBeNull();
    const sale = price({ priceListId: "pl_s", kind: "sale", amountMinor: 75_000 });
    expect(resolvePrice({ ...plain, prices: [noCompare, sale] }).compareAtMinor).toBe(90_000);
    // A compare-at at or below the amount is never shown.
    const flat = price({ priceListId: "pl_f", kind: "market", amountMinor: 90_000, compareAtMinor: 90_000 });
    expect(resolvePrice({ ...plain, prices: [flat] }).compareAtMinor).toBeNull();
  });

  it("rounds a list amount to the market's increment", () => {
    const odd = price({ priceListId: "pl_o", kind: "market", amountMinor: 89_950 });
    expect(resolvePrice({ ...plain, prices: [odd] }).amountMinor).toBe(90_000);
  });

  it("prices in the catalogue's discount shape exactly", () => {
    for (const resolved of [
      resolvePrice({ ...plain, prices: [price({ priceListId: "pl", kind: "sale", amountMinor: 75_000 })] }),
      resolvePrice(plain),
      resolvePrice({ ...plain, base: { priceMinor: 100_000, effectiveMinor: 100_000 } }),
    ]) {
      const shape = resolvedPriceAsCatalogPrice(resolved);
      expect(discountedPriceMinor(shape.priceMinor, shape.discountType, shape.discountBps, shape.discountAmountMinor, 100)).toBe(resolved.amountMinor);
    }
  });
});

describe("applicablePriceListPrices", () => {
  const row = (overrides: Partial<PriceListRow>): PriceListRow => ({
    priceListId: "pl_1",
    kind: "market",
    marketId: "mkt_in",
    segmentId: null,
    priority: 0,
    startsAt: null,
    endsAt: null,
    currencyCode: "BDT",
    amountMinor: 50_000,
    compareAtMinor: null,
    minQuantity: 1,
    ...overrides,
  });
  const scope = { marketId: "mkt_in", currencyCode: "bdt", atSeconds: 1_000, segmentIds: "public" as const };

  it("keeps the market's live rows in its currency and segment rows only for members", () => {
    const rows = [
      row({ priceListId: "keep" }),
      row({ priceListId: "other_market", marketId: "mkt_np" }),
      row({ priceListId: "other_currency", currencyCode: "USD" }),
      row({ priceListId: "not_started", startsAt: 2_000 }),
      row({ priceListId: "ended", endsAt: 1_000 }),
      row({ priceListId: "started", startsAt: 1_000, endsAt: 1_001 }),
      row({ priceListId: "segment", kind: "segment", segmentId: "seg_a" }),
    ];
    expect(applicablePriceListPrices(rows, scope).map((each) => each.priceListId)).toEqual(["keep", "started"]);
    expect(applicablePriceListPrices(rows, { ...scope, segmentIds: new Set(["seg_a"]) }).map((each) => each.priceListId))
      .toEqual(["keep", "started", "segment"]);
    expect(applicablePriceListPrices(rows, { ...scope, segmentIds: new Set(["seg_b"]) }).map((each) => each.priceListId))
      .toEqual(["keep", "started"]);
  });

  it("finds the next schedule boundary", () => {
    expect(nextPriceListBoundary([{ startsAt: 500, endsAt: 3_000 }, { startsAt: 2_000, endsAt: null }], 1_000)).toBe(2_000);
    expect(nextPriceListBoundary([{ startsAt: null, endsAt: null }], 1_000)).toBeNull();
  });
});

describe("cardPriceOf", () => {
  const sku = (skuId: string, amountMinor: number, available: boolean) => ({
    skuId,
    available,
    resolved: { amountMinor, compareAtMinor: null, source: "base" as const, priceListId: null },
  });

  it("prefers buyable SKUs, the lowest price, then the SKU id, and reports the pool's maximum", () => {
    expect(cardPriceOf([sku("b", 500, true), sku("a", 300, false), sku("c", 700, true)]))
      .toEqual({ card: sku("b", 500, true), maxAmountMinor: 700 });
    expect(cardPriceOf([sku("b", 500, false), sku("a", 500, false)])!.card.skuId).toBe("a");
    expect(cardPriceOf([])).toBeNull();
  });
});
