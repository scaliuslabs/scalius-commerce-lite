import { describe, expect, it } from "vitest";

import {
  convertMinorAtRate,
  isFxRate,
  orderMoneyChainColumns,
  paymentSettlement,
  presentedSettlement,
  rateBetweenMinor,
  sameCurrencyFx,
} from "./money-chain";

const TOTALS = {
  currencyCode: "BDT",
  subtotalAmountMinor: 250_000,
  shippingAmountMinor: 6_000,
  discountAmountMinor: 10_000,
  taxAmountMinor: 12_000,
  totalAmountMinor: 258_000,
};

describe("exchange rates", () => {
  it("accepts positive decimal strings only", () => {
    for (const rate of ["1", "0.0091", "117.25", "000.5"]) expect(isFxRate(rate), rate).toBe(true);
    for (const rate of ["0", "0.000", "-1", "1.", ".5", "1e3", "1,5", 1, null, "1.1234567890123"]) {
      expect(isFxRate(rate), String(rate)).toBe(false);
    }
  });

  it("converts exactly and rounds once, half up, across exponents", () => {
    expect(convertMinorAtRate(258_000, "1", 2, 2)).toBe(258_000);
    // ৳2,580.00 at 0.0091 USD per taka = $23.478 → $23.48.
    expect(convertMinorAtRate(258_000, "0.0091", 2, 2)).toBe(2_348);
    // $10.00 at 117.25 taka per dollar = ৳1,172.50.
    expect(convertMinorAtRate(1_000, "117.25", 2, 2)).toBe(117_250);
    // ¥1,000 (exponent 0) at 0.0067 USD = $6.70; KWD (exponent 3) at 3.26 USD.
    expect(convertMinorAtRate(1_000, "0.0067", 0, 2)).toBe(670);
    expect(convertMinorAtRate(12_345, "3.26", 3, 2)).toBe(4_024);
    // Half up: 0.5 of a minor unit rounds away from zero, symmetric for negatives.
    expect(convertMinorAtRate(5, "0.1", 2, 2)).toBe(1);
    expect(convertMinorAtRate(-5, "0.1", 2, 2)).toBe(-1);
    expect(() => convertMinorAtRate(1, "0", 2, 2)).toThrow(RangeError);
  });

  it("states the rate between two amounts to twelve places", () => {
    expect(rateBetweenMinor(1_000, 2, 117_250, 2)).toBe("117.25");
    expect(rateBetweenMinor(258_000, 2, 2_348, 2)).toBe("0.009100775194");
    expect(rateBetweenMinor(1_000, 0, 670, 2)).toBe("0.0067");
    expect(rateBetweenMinor(500, 2, 500, 2)).toBe("1");
  });
});

describe("order money chain", () => {
  it("makes a same-currency order's shop amounts its presentment amounts at rate 1", () => {
    expect(orderMoneyChainColumns(TOTALS)).toEqual({
      shopCurrency: "BDT",
      fxRate: "1",
      fxSource: "same_currency",
      fxAsOf: null,
      fxLockedUntil: null,
      subtotalShopMinor: 250_000,
      shippingShopMinor: 6_000,
      discountShopMinor: 10_000,
      taxShopMinor: 12_000,
      totalShopMinor: 258_000,
    });
    expect(sameCurrencyFx(" usd ").shopCurrency).toBe("USD");
  });

  it("converts each total once at the locked rate into the shop currency's exponent", () => {
    const fx = { shopCurrency: "USD", fxRate: "0.0091", fxSource: "manual", fxAsOf: new Date(1_000), fxLockedUntil: new Date(2_000) };
    expect(orderMoneyChainColumns(TOTALS, fx)).toMatchObject({
      shopCurrency: "USD",
      fxRate: "0.0091",
      subtotalShopMinor: 2_275,
      shippingShopMinor: 55,
      discountShopMinor: 91,
      taxShopMinor: 109,
      totalShopMinor: 2_348,
    });
  });
});

describe("payment settlement", () => {
  it("records a movement nobody reported on as settled in its own currency", () => {
    expect(presentedSettlement(258_000, "bdt")).toEqual({
      settlementCurrency: "BDT", settlementAmountMinor: 258_000, settlementRate: "1", exchangeAdjustmentMinor: 0,
    });
    expect(paymentSettlement({ amountMinor: 258_000, currency: "BDT" })).toEqual(presentedSettlement(258_000, "BDT"));
    // An unusable report is ignored, never half-recorded.
    expect(paymentSettlement({ amountMinor: 100, currency: "BDT", settlement: { currency: "TAKA", amountMinor: 100 } }))
      .toEqual(presentedSettlement(100, "BDT"));
  });

  it("keeps a provider's settlement and its gain or loss against the order's locked rate", () => {
    // $10.00 presented, the order locked 117 taka per dollar (৳1,170.00); the payout was ৳1,172.50.
    expect(paymentSettlement({
      amountMinor: 1_000,
      currency: "USD",
      settlement: { currency: "BDT", amountMinor: 117_250, exchangeRate: "117.25" },
      order: { shopCurrency: "BDT", fxRate: "117" },
    })).toEqual({ settlementCurrency: "BDT", settlementAmountMinor: 117_250, settlementRate: "117.25", exchangeAdjustmentMinor: 250 });
    // No rate reported: derived from the two amounts. Settled outside the shop currency: no adjustment.
    expect(paymentSettlement({
      amountMinor: 1_000,
      currency: "USD",
      settlement: { currency: "EUR", amountMinor: 920 },
      order: { shopCurrency: "BDT", fxRate: "117" },
    })).toEqual({ settlementCurrency: "EUR", settlementAmountMinor: 920, settlementRate: "0.92", exchangeAdjustmentMinor: 0 });
    // Same-currency settlement keeps the reported amount at rate 1.
    expect(paymentSettlement({ amountMinor: 1_000, currency: "USD", settlement: { currency: "usd", amountMinor: 1_000 } }))
      .toEqual({ settlementCurrency: "USD", settlementAmountMinor: 1_000, settlementRate: "1", exchangeAdjustmentMinor: 0 });
  });
});
