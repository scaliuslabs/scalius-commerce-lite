import { describe, expect, it } from "vitest";
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import type { CheckoutConfig } from "./types";
import {
  isManualCodDepositRequired,
  manualCodDepositAmount,
  resolveCheckoutPaymentRequest,
  resolveExplicitCheckoutPaymentRequest,
} from "./payment-mode";
import { CheckoutCopyError } from "./error-messages";

type CodDeposit = NonNullable<Parameters<typeof isManualCodDepositRequired>[0]["codDeposit"]>;

function codDepositConfig(
  overrides: Partial<CodDeposit> = {},
): Pick<Parameters<typeof isManualCodDepositRequired>[0], "codDeposit"> {
  return {
    codDeposit: {
      enabled: true,
      mode: "fixed",
      amount: 100,
      percent: 20,
      instructions: "Pay via bKash",
      ...overrides,
    },
  };
}

describe("isManualCodDepositRequired", () => {
  const lineTypesPhysical: readonly (FulfillmentType | null)[] = ["ship"];
  const lineTypesDigital: readonly (FulfillmentType | null)[] = ["digital"];
  const lineTypesGiftCard: readonly (FulfillmentType | null)[] = ["gift_card"];

  describe("fixed mode", () => {
    it("returns true when deposit is positive and less than total", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 100 }),
          1000,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(true);
    });

    it("returns false when deposit equals total (not strictly less)", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 1000 }),
          1000,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(false);
    });

    it("returns false when deposit is greater than total", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 1500 }),
          1000,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(false);
    });

    it("returns false when codDeposit is disabled", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ enabled: false }),
          1000,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(false);
    });

    it("returns false when no lines are physical (digital only)", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 100 }),
          1000,
          lineTypesDigital,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(false);
    });

    it("returns false when lines include gift card", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 100 }),
          1000,
          lineTypesGiftCard,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(false);
    });

    it("returns false when order currency differs from store currency", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 100 }),
          1000,
          lineTypesPhysical,
          "EGP",
          "USD",
          2,
        ),
      ).toBe(false);
    });

    it("returns true with zero-decimal currency (BDT) when deposit < total", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 500 }),
          1000,
          lineTypesPhysical,
          "BDT",
          "BDT",
          0,
        ),
      ).toBe(true);
    });

    it("returns false with zero-decimal currency when deposit >= total", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 1000 }),
          1000,
          lineTypesPhysical,
          "BDT",
          "BDT",
          0,
        ),
      ).toBe(false);
    });

    it("works with null line types", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 100 }),
          1000,
          [null],
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(true);
    });

    it("returns false with empty line types", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "fixed", amount: 100 }),
          1000,
          [],
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(false);
    });
  });

  describe("percentage mode", () => {
    it("computes in minor units: 20% of 1000 EGP = 200 minor", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "percentage", percent: 20 }),
          1000,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(true);
    });

    it("percentage deposit < total is eligible", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "percentage", percent: 50 }),
          1000,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(true);
    });

    it("percentage deposit clamped: ceil(99% of 1000) = 990 < 1000, eligible", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "percentage", percent: 99 }),
          1000,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(true);
    });

    it("zero-decimal currency: 20% of 1000 BDT = 200 minor, eligible", () => {
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "percentage", percent: 20 }),
          1000,
          lineTypesPhysical,
          "BDT",
          "BDT",
          0,
        ),
      ).toBe(true);
    });

    it("percentage rounds up in minor units: 33% of 100 EGP = 3300 minor < totalMinor", () => {
      // totalAmount = 100 EGP → totalMinor = 10000
      // depositMinor = ceil(10000 * 33/100) = ceil(3300) = 3300 minor units
      // clamp to totalMinor - 1 = 9999 → min(9999, 3300) = 3300
      // 3300 > 0 && 3300 < 10000 → true
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "percentage", percent: 33 }),
          100,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(true);
    });

    it("percentage deposit stays below total after clamp: 99% of 1 EGP = 99 minor < totalMinor", () => {
      // totalAmount = 1 EGP → totalMinor = 100
      // depositMinor = ceil(100 * 99/100) = ceil(99) = 99
      // clamp to totalMinor - 1 = 99 → min(99, 99) = 99
      // 99 > 0 && 99 < 100 → true
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "percentage", percent: 99 }),
          1,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(true);
    });

    it("percentage deposit below total after clamp", () => {
      // totalMinor = 100, depositMinor = min(99, ceil(100 * 99/100)) = min(99, 99) = 99
      // 99 > 0 && 99 < 100 → true
      expect(
        isManualCodDepositRequired(
          codDepositConfig({ mode: "percentage", percent: 99 }),
          1,
          lineTypesPhysical,
          "EGP",
          "EGP",
          2,
        ),
      ).toBe(true);
    });
  });

  describe("unit consistency", () => {
    it("fixed mode: amount in minor units matches across functions", () => {
      const required = isManualCodDepositRequired(
        codDepositConfig({ mode: "fixed", amount: 250 }),
        1000,
        lineTypesPhysical,
        "EGP",
        "EGP",
        2,
      );
      const amount = manualCodDepositAmount(
        codDepositConfig({ mode: "fixed", amount: 250 }),
        1000,
        2,
      );
      expect(required).toBe(true);
      expect(amount).toBe(250);
    });

    it("percentage mode: amount in minor units matches across functions", () => {
      const required = isManualCodDepositRequired(
        codDepositConfig({ mode: "percentage", percent: 25 }),
        1000,
        lineTypesPhysical,
        "EGP",
        "EGP",
        2,
      );
      const amount = manualCodDepositAmount(
        codDepositConfig({ mode: "percentage", percent: 25 }),
        1000,
        2,
      );
      expect(required).toBe(true);
      expect(amount).toBe(250);
    });

    it("zero-decimal currency: fixed amount returns whole units", () => {
      const amount = manualCodDepositAmount(
        codDepositConfig({ mode: "fixed", amount: 500 }),
        1000,
        0,
      );
      expect(amount).toBe(500);
    });
  });
});

describe("manualCodDepositAmount", () => {
  const lineTypesPhysical: readonly (FulfillmentType | null)[] = ["ship"];

  describe("fixed mode", () => {
    it("returns amount in major units for 2 decimal places", () => {
      // amount is in major units: 150.00 EGP = 15000 minor → returns 150.00
      expect(
        manualCodDepositAmount(
          codDepositConfig({ mode: "fixed", amount: 150 }),
          1000,
          2,
        ),
      ).toBe(150);
    });

    it("returns amount as-is for zero decimal places", () => {
      expect(
        manualCodDepositAmount(
          codDepositConfig({ mode: "fixed", amount: 500 }),
          1000,
          0,
        ),
      ).toBe(500);
    });

    it("returns null when codDeposit is disabled", () => {
      expect(
        manualCodDepositAmount(
          codDepositConfig({ enabled: false }),
          1000,
          2,
        ),
      ).toBe(null);
    });

    it("returns null when deposit >= total", () => {
      expect(
        manualCodDepositAmount(
          codDepositConfig({ mode: "fixed", amount: 1000 }),
          1000,
          2,
        ),
      ).toBe(null);
    });

    it("returns null when deposit > total", () => {
      expect(
        manualCodDepositAmount(
          codDepositConfig({ mode: "fixed", amount: 1500 }),
          1000,
          2,
        ),
      ).toBe(null);
    });
  });

  describe("percentage mode", () => {
    it("computes percentage in minor units and returns major units", () => {
      // 20% of 1000.00 EGP = 200.00 → 20000 minor → 200.00 major
      expect(
        manualCodDepositAmount(
          codDepositConfig({ mode: "percentage", percent: 20 }),
          1000,
          2,
        ),
      ).toBe(200);
    });

    it("rounds up in minor units: 33% of 10.00 EGP = ceil(330) = 330 minor = 3.30 major", () => {
      // totalMinor = 1000, depositMinor = ceil(1000 * 33/100) = ceil(330) = 330
      expect(
        manualCodDepositAmount(
          codDepositConfig({ mode: "percentage", percent: 33 }),
          10,
          2,
        ),
      ).toBe(3.3);
    });

    it("clamps to totalMinor - 1 so deposit stays below total", () => {
      // 99% of 100.00 = ceil(9900/100) = ceil(99) = 99 minor... wait
      // totalMinor = 10000, depositMinor = ceil(10000 * 99/100) = ceil(9900) = 9900
      // 9900 < 10000 → returns 99.00
      expect(
        manualCodDepositAmount(
          codDepositConfig({ mode: "percentage", percent: 99 }),
          100,
          2,
        ),
      ).toBe(99);
    });

    it("zero-decimal currency: 20% of 1000 BDT = 200 minor = 200 major", () => {
      expect(
        manualCodDepositAmount(
          codDepositConfig({ mode: "percentage", percent: 20 }),
          1000,
          0,
        ),
      ).toBe(200);
    });

    it("returns null when codDeposit is disabled", () => {
      expect(
        manualCodDepositAmount(
          codDepositConfig({ enabled: false }),
          1000,
          2,
        ),
      ).toBe(null);
    });
  });
});

describe("resolveExplicitCheckoutPaymentRequest", () => {
  it("returns { paymentType: 'full' } for full", () => {
    expect(resolveExplicitCheckoutPaymentRequest("full")).toEqual({ paymentType: "full" });
  });

  it("returns { paymentType: 'balance' } for balance", () => {
    expect(resolveExplicitCheckoutPaymentRequest("balance")).toEqual({ paymentType: "balance" });
  });

  it("returns { paymentType: 'deposit', depositAmount } for deposit with valid amount", () => {
    expect(resolveExplicitCheckoutPaymentRequest("deposit", 250)).toEqual({ paymentType: "deposit", depositAmount: 250 });
  });

  it("throws CheckoutCopyError for deposit with amount 0", () => {
    expect(() => resolveExplicitCheckoutPaymentRequest("deposit", 0)).toThrow(CheckoutCopyError);
  });

  it("throws CheckoutCopyError for deposit with negative amount", () => {
    expect(() => resolveExplicitCheckoutPaymentRequest("deposit", -100)).toThrow(CheckoutCopyError);
  });

  it("throws CheckoutCopyError for deposit with NaN", () => {
    expect(() => resolveExplicitCheckoutPaymentRequest("deposit", NaN)).toThrow(CheckoutCopyError);
  });

  it("throws CheckoutCopyError for deposit with Infinity", () => {
    expect(() => resolveExplicitCheckoutPaymentRequest("deposit", Infinity)).toThrow(CheckoutCopyError);
  });

  it("throws CheckoutCopyError for deposit with undefined amount", () => {
    expect(() => resolveExplicitCheckoutPaymentRequest("deposit")).toThrow(CheckoutCopyError);
  });
});

describe("resolveCheckoutPaymentRequest", () => {
  const baseConfig: Pick<CheckoutConfig, "partialPaymentEnabled" | "partialPaymentAmount" | "codDeposit"> = {
    partialPaymentEnabled: true,
    partialPaymentAmount: 200,
    codDeposit: { enabled: false, mode: "fixed", amount: 0, percent: 0, instructions: "" },
  };

  it("returns deposit when partialPaymentEnabled and physical lines", () => {
    expect(resolveCheckoutPaymentRequest(baseConfig, 1000, ["ship"])).toEqual({ paymentType: "deposit", depositAmount: 200 });
  });

  it("returns full when partialPaymentEnabled and gift card lines", () => {
    expect(resolveCheckoutPaymentRequest(baseConfig, 1000, ["gift_card"])).toEqual({ paymentType: "full" });
  });

  it("returns full when partialPaymentEnabled and digital lines", () => {
    expect(resolveCheckoutPaymentRequest(baseConfig, 1000, ["digital"])).toEqual({ paymentType: "full" });
  });

  it("returns full when partialPaymentEnabled is false", () => {
    const noPartial = { ...baseConfig, partialPaymentEnabled: false };
    expect(resolveCheckoutPaymentRequest(noPartial, 1000, ["ship"])).toEqual({ paymentType: "full" });
  });

  it("returns full when deposit equals total", () => {
    const bigDeposit = { ...baseConfig, partialPaymentAmount: 1000 };
    expect(resolveCheckoutPaymentRequest(bigDeposit, 1000, ["ship"])).toEqual({ paymentType: "full" });
  });

  it("returns full when null line types", () => {
    expect(resolveCheckoutPaymentRequest(baseConfig, 1000, [null])).toEqual({ paymentType: "deposit", depositAmount: 200 });
  });

  it("returns full when empty line types", () => {
    expect(resolveCheckoutPaymentRequest(baseConfig, 1000, [])).toEqual({ paymentType: "full" });
  });
});
