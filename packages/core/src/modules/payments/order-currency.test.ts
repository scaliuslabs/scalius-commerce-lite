import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import {
  assertOrderPaymentCurrency,
  createOrderCurrencySnapshot,
  resolveOrderCurrencySnapshot,
} from "./order-currency";

describe("immutable order currency snapshots", () => {
  it("honors the saved JPY and KWD precision instead of current settings", () => {
    expect(resolveOrderCurrencySnapshot({ currencyCode: "jpy", currencyDecimalPlaces: 0 }))
      .toEqual({ code: "JPY", decimalPlaces: 0 });
    expect(resolveOrderCurrencySnapshot({ currencyCode: "KWD", currencyDecimalPlaces: 3 }))
      .toEqual({ code: "KWD", decimalPlaces: 3 });
  });

  it("fails closed for corrupt snapshots instead of silently switching currencies", () => {
    expect(() => resolveOrderCurrencySnapshot({ currencyCode: null, currencyDecimalPlaces: 3 }))
      .toThrow(ValidationError);
    expect(() => resolveOrderCurrencySnapshot({ currencyCode: "ZZZ", currencyDecimalPlaces: 2 }))
      .toThrow(ValidationError);
    expect(() => resolveOrderCurrencySnapshot({ currencyCode: "BDT", currencyDecimalPlaces: 4 }))
      .toThrow(ValidationError);
  });

  it("rejects payment rows from a different or missing currency", () => {
    const jpy = createOrderCurrencySnapshot("JPY");
    expect(() => assertOrderPaymentCurrency("JPY", jpy)).not.toThrow();
    expect(() => assertOrderPaymentCurrency("BDT", jpy)).toThrow(ValidationError);
    expect(() => assertOrderPaymentCurrency(null, createOrderCurrencySnapshot("BDT")))
      .toThrow(ValidationError);
  });
});
