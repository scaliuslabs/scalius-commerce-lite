import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import {
  assertOrderPaymentCurrency,
  createOrderCurrencySnapshot,
  orderMoneyEqual,
  resolveOrderCurrencySnapshot,
  roundOrderMoney,
} from "./order-currency";

describe("immutable order currency snapshots", () => {
  it("uses BDT only when both legacy snapshot columns are null", () => {
    expect(resolveOrderCurrencySnapshot({ currencyCode: null, currencyDecimalPlaces: null }))
      .toEqual({ code: "BDT", decimalPlaces: 2, legacyFallback: true });
  });

  it("honors saved JPY and KWD precision instead of current settings", () => {
    expect(roundOrderMoney(100.49, resolveOrderCurrencySnapshot({
      currencyCode: "JPY",
      currencyDecimalPlaces: 0,
    }))).toBe(100);
    expect(roundOrderMoney(1.2346, resolveOrderCurrencySnapshot({
      currencyCode: "KWD",
      currencyDecimalPlaces: 3,
    }))).toBe(1.235);
  });

  it("derives precision from a saved code only for partial legacy snapshots", () => {
    expect(resolveOrderCurrencySnapshot({ currencyCode: "kwd", currencyDecimalPlaces: null }))
      .toEqual({ code: "KWD", decimalPlaces: 3, legacyFallback: false });
  });

  it("fails closed for corrupt snapshots instead of silently switching currencies", () => {
    expect(() => resolveOrderCurrencySnapshot({ currencyCode: null, currencyDecimalPlaces: 3 }))
      .toThrow(ValidationError);
    expect(() => resolveOrderCurrencySnapshot({ currencyCode: "ZZZ", currencyDecimalPlaces: 2 }))
      .toThrow(ValidationError);
  });

  it("compares amounts at the immutable precision", () => {
    const kwd = createOrderCurrencySnapshot("KWD");
    expect(orderMoneyEqual(1.2346, 1.235, kwd)).toBe(true);
    expect(orderMoneyEqual(1.234, 1.235, kwd)).toBe(false);
  });

  it("rejects payment rows from a different currency", () => {
    const jpy = createOrderCurrencySnapshot("JPY");
    expect(() => assertOrderPaymentCurrency("JPY", jpy)).not.toThrow();
    expect(() => assertOrderPaymentCurrency("BDT", jpy)).toThrow(ValidationError);
  });

  it("allows a missing payment currency only for a truly legacy BDT order", () => {
    const legacy = resolveOrderCurrencySnapshot({ currencyCode: null, currencyDecimalPlaces: null });
    expect(() => assertOrderPaymentCurrency(null, legacy)).not.toThrow();
    expect(() => assertOrderPaymentCurrency(null, createOrderCurrencySnapshot("BDT")))
      .toThrow(ValidationError);
  });
});
