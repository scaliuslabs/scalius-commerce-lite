import { describe, expect, it } from "vitest";
import { orderShopAmounts } from "./money-chain";
import {
  convertStoreCurrencyMinor,
  crossRate,
  DEFAULT_FX_LOCK_MINUTES,
  invertFxRate,
  isForeignPresentment,
  marketPresentment,
  orderFxRate,
  presentmentFx,
  presentShopMinor,
  shopMinorOf,
  shopPresentment,
} from "./presentment";

const BDT = { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 };
const USD = { code: "USD", decimalPlaces: 2, priceIncrementMinor: 1 };

describe("presentment money", () => {
  it("converts nothing in the shop currency", () => {
    const money = shopPresentment(BDT);
    expect(isForeignPresentment(money)).toBe(false);
    expect(presentShopMinor(money, 12_345)).toBe(12_345);
    expect(shopMinorOf(money, 12_345)).toBe(12_345);
    expect(orderFxRate(money)).toBe("1");
    expect(presentmentFx(money)).toEqual({ shopCurrency: "BDT", fxRate: "1", fxSource: "same_currency", fxAsOf: null, fxLockedUntil: null });
  });

  it("a market in the shop currency is the shop presentment with its lock", () => {
    const money = marketPresentment({ shop: BDT, currencyCode: "bdt", rate: "2", lockMinutes: 45 });
    expect(isForeignPresentment(money)).toBe(false);
    expect(money.lockMinutes).toBe(45);
    expect(presentShopMinor(money, 500)).toBe(500);
  });

  it("converts shop amounts at the rate and rounds to the market increment", () => {
    // 1 BDT = 0.0068 GBP; GBP increment 1 penny.
    const gbp = marketPresentment({ shop: BDT, currencyCode: "GBP", rate: "0.0068", fxAsOf: 1_790_000_000 });
    expect(gbp.incrementMinor).toBe(1);
    expect(presentShopMinor(gbp, 150_000)).toBe(1_020); // ৳1,500 → £10.20
    expect(presentShopMinor(gbp, 100)).toBe(1); // ৳1 → £0.0068 → one penny, never zero
    expect(presentShopMinor(gbp, 100, "down")).toBe(0);
    expect(presentShopMinor(gbp, 0)).toBe(0);
    expect(presentShopMinor(gbp, -150_000)).toBe(-1_020);
    // A zero-decimal market: JPY from USD at 149.5.
    const jpy = marketPresentment({ shop: USD, currencyCode: "JPY", rate: "149.5" });
    expect(jpy.decimalPlaces).toBe(0);
    expect(presentShopMinor(jpy, 1_999)).toBe(2_989); // $19.99 → ¥2,988.505 → ¥2,989
    // A BDT market of a USD shop prices in whole taka.
    const bdt = marketPresentment({ shop: USD, currencyCode: "BDT", rate: "117.25" });
    expect(bdt.incrementMinor).toBe(100);
    expect(presentShopMinor(bdt, 1_999)).toBe(234_400); // $19.99 → ৳2,343.8275 → ৳2,344
  });

  it("states the order rate as the inverse and converts back exactly at it", () => {
    expect(invertFxRate("0.0068")).toBe("147.058823529412");
    expect(invertFxRate("149.5")).toBe("0.006688963211");
    expect(invertFxRate("2")).toBe("0.5");
    const gbp = marketPresentment({ shop: BDT, currencyCode: "GBP", rate: "0.0068" });
    expect(orderFxRate(gbp)).toBe("147.058823529412");
    expect(shopMinorOf(gbp, 1_020)).toBe(150_000);
    const shop = orderShopAmounts(
      { currencyCode: "GBP", subtotalAmountMinor: 1_020, shippingAmountMinor: 0, discountAmountMinor: 0, taxAmountMinor: 0, totalAmountMinor: 1_020 },
      { shopCurrency: "BDT", fxRate: orderFxRate(gbp) },
    );
    expect(shop.totalShopMinor).toBe(150_000);
  });

  it("locks the rate for the market's minutes from placement", () => {
    const placedAt = new Date("2026-10-07T10:00:00Z");
    const gbp = marketPresentment({ shop: BDT, currencyCode: "GBP", rate: "0.0068", fxAsOf: 1_790_000_000 });
    expect(gbp.lockMinutes).toBe(DEFAULT_FX_LOCK_MINUTES);
    const fx = presentmentFx(gbp, placedAt);
    expect(fx.fxSource).toBe("manual");
    expect(fx.fxAsOf?.getTime()).toBe(1_790_000_000_000);
    expect(fx.fxLockedUntil?.toISOString()).toBe("2026-10-07T10:30:00.000Z");
    const short = marketPresentment({ shop: BDT, currencyCode: "GBP", rate: "0.0068", lockMinutes: 2 });
    expect(short.lockMinutes).toBe(DEFAULT_FX_LOCK_MINUTES);
  });

  it("refuses an unusable rate", () => {
    expect(() => marketPresentment({ shop: BDT, currencyCode: "GBP", rate: "0" })).toThrow(RangeError);
    expect(() => marketPresentment({ shop: BDT, currencyCode: "GBP", rate: "abc" })).toThrow(RangeError);
  });
});

describe("store currencies", () => {
  const bdt = { code: "BDT", decimalPlaces: 2, rate: "1" };
  const gbp = { code: "GBP", decimalPlaces: 2, rate: "0.0068" };
  const jpy = { code: "JPY", decimalPlaces: 0, rate: "1.25" };

  it("converts through the shop currency, down for a balance and up for a debit", () => {
    expect(convertStoreCurrencyMinor(100_000, bdt, gbp, "down")).toBe(680);
    expect(convertStoreCurrencyMinor(680, gbp, bdt, "up")).toBe(100_000);
    expect(convertStoreCurrencyMinor(681, gbp, bdt, "up")).toBe(100_148);
    // £10 in yen: 10 / 0.0068 × 1.25 = 1838.23 → 1838 down
    expect(convertStoreCurrencyMinor(1_000, gbp, jpy, "down")).toBe(1_838);
    expect(convertStoreCurrencyMinor(500, bdt, bdt, "down")).toBe(500);
  });

  it("a debit never exceeds the balance it was converted from", () => {
    for (const balance of [1, 7, 99, 100, 12_345, 999_999]) {
      const value = convertStoreCurrencyMinor(balance, bdt, gbp, "down");
      expect(convertStoreCurrencyMinor(value, gbp, bdt, "up")).toBeLessThanOrEqual(balance);
    }
  });

  it("states the cross rate", () => {
    expect(crossRate(bdt, gbp)).toBe("0.0068");
    expect(crossRate(gbp, bdt)).toBe("147.058823529412");
    expect(crossRate(gbp, gbp)).toBe("1");
  });
});
