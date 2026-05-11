// tests/unit/core/discounts/discount-validation.test.ts
// Tests discount validation logic from discounts.service.ts.
// Covers code uniqueness, deleted code reuse, usage limits.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Pure logic extracted from DiscountService.create() / .update()
// ---------------------------------------------------------------------------

interface Discount {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  minPurchaseAmount: number | null;
  minQuantity: number | null;
  maxUses: number | null;
  limitOnePerCustomer: boolean;
  isActive: boolean;
  deletedAt: Date | null;
  startDate: Date;
  endDate: Date | null;
}

interface DiscountUsage {
  discountId: string;
  customerId: string;
  orderId: string;
  amountDiscounted: number;
}

/**
 * Validate discount code uniqueness.
 * A code is unique if no other non-deleted discount uses it.
 * Deleted codes CAN be reused (checked via `isNull(deletedAt)`).
 */
function isCodeAvailable(
  code: string,
  existingDiscounts: Discount[],
  excludeId?: string,
): boolean {
  return !existingDiscounts.some(
    (d) =>
      d.code === code &&
      d.deletedAt === null &&
      d.id !== excludeId
  );
}

/**
 * Validate discount applicability for an order.
 */
function validateDiscountApplicability(
  discount: Discount,
  orderTotal: number,
  orderQuantity: number,
  globalUsageCount: number,
  customerUsageCount: number,
): { valid: boolean; error?: string } {
  if (!discount.isActive) {
    return { valid: false, error: "Discount is not active" };
  }

  if (discount.deletedAt !== null) {
    return { valid: false, error: "Discount has been deleted" };
  }

  // Date validation
  const now = new Date();
  if (discount.startDate > now) {
    return { valid: false, error: "Discount has not started yet" };
  }
  if (discount.endDate && discount.endDate < now) {
    return { valid: false, error: "Discount has expired" };
  }

  // Minimum purchase amount
  if (discount.minPurchaseAmount !== null && orderTotal < discount.minPurchaseAmount) {
    return {
      valid: false,
      error: `Minimum purchase amount of ${discount.minPurchaseAmount} not met`,
    };
  }

  // Minimum quantity
  if (discount.minQuantity !== null && orderQuantity < discount.minQuantity) {
    return {
      valid: false,
      error: `Minimum quantity of ${discount.minQuantity} not met`,
    };
  }

  // Global usage limit (maxUses)
  if (discount.maxUses !== null && globalUsageCount >= discount.maxUses) {
    return { valid: false, error: "Discount usage limit reached" };
  }

  // Per-customer limit
  if (discount.limitOnePerCustomer && customerUsageCount > 0) {
    return { valid: false, error: "Discount already used by this customer" };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discount code uniqueness", () => {
  it("rejects duplicate code on active discount", () => {
    const existing: Discount[] = [
      {
        id: "disc_1",
        code: "SUMMER20",
        type: "amount_off_order",
        valueType: "percentage",
        discountValue: 20,
        minPurchaseAmount: null,
        minQuantity: null,
        maxUses: null,
        limitOnePerCustomer: false,
        isActive: true,
        deletedAt: null,
        startDate: new Date("2025-01-01"),
        endDate: null,
      },
    ];

    expect(isCodeAvailable("SUMMER20", existing)).toBe(false);
  });

  it("allows reuse of deleted discount code", () => {
    const existing: Discount[] = [
      {
        id: "disc_1",
        code: "SUMMER20",
        type: "amount_off_order",
        valueType: "percentage",
        discountValue: 20,
        minPurchaseAmount: null,
        minQuantity: null,
        maxUses: null,
        limitOnePerCustomer: false,
        isActive: false,
        deletedAt: new Date("2025-06-01"), // Soft-deleted
        startDate: new Date("2025-01-01"),
        endDate: null,
      },
    ];

    expect(isCodeAvailable("SUMMER20", existing)).toBe(true);
  });

  it("allows same code when updating the same discount", () => {
    const existing: Discount[] = [
      {
        id: "disc_1",
        code: "SUMMER20",
        type: "amount_off_order",
        valueType: "percentage",
        discountValue: 20,
        minPurchaseAmount: null,
        minQuantity: null,
        maxUses: null,
        limitOnePerCustomer: false,
        isActive: true,
        deletedAt: null,
        startDate: new Date("2025-01-01"),
        endDate: null,
      },
    ];

    // When updating disc_1 itself, the code is available
    expect(isCodeAvailable("SUMMER20", existing, "disc_1")).toBe(true);
  });

  it("allows new code that doesn't exist", () => {
    const existing: Discount[] = [
      {
        id: "disc_1",
        code: "SUMMER20",
        type: "amount_off_order",
        valueType: "percentage",
        discountValue: 20,
        minPurchaseAmount: null,
        minQuantity: null,
        maxUses: null,
        limitOnePerCustomer: false,
        isActive: true,
        deletedAt: null,
        startDate: new Date("2025-01-01"),
        endDate: null,
      },
    ];

    expect(isCodeAvailable("WINTER30", existing)).toBe(true);
  });
});

describe("discount applicability validation", () => {
  const baseDiscount: Discount = {
    id: "disc_1",
    code: "TEST",
    type: "amount_off_order",
    valueType: "percentage",
    discountValue: 10,
    minPurchaseAmount: null,
    minQuantity: null,
    maxUses: null,
    limitOnePerCustomer: false,
    isActive: true,
    deletedAt: null,
    startDate: new Date("2024-01-01"),
    endDate: null,
  };

  describe("minPurchaseAmount", () => {
    it("rejects order below minimum purchase amount", () => {
      const discount: Discount = {
        ...baseDiscount,
        minPurchaseAmount: 1000,
      };

      const result = validateDiscountApplicability(discount, 500, 1, 0, 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Minimum purchase amount");
    });

    it("accepts order at exact minimum purchase amount", () => {
      const discount: Discount = {
        ...baseDiscount,
        minPurchaseAmount: 1000,
      };

      const result = validateDiscountApplicability(discount, 1000, 1, 0, 0);
      expect(result.valid).toBe(true);
    });

    it("accepts order above minimum purchase amount", () => {
      const discount: Discount = {
        ...baseDiscount,
        minPurchaseAmount: 1000,
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 0, 0);
      expect(result.valid).toBe(true);
    });

    it("ignores minPurchaseAmount when null", () => {
      const result = validateDiscountApplicability(baseDiscount, 1, 1, 0, 0);
      expect(result.valid).toBe(true);
    });
  });

  describe("maxUses (global limit)", () => {
    it("rejects when global usage limit reached", () => {
      const discount: Discount = {
        ...baseDiscount,
        maxUses: 100,
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 100, 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("usage limit reached");
    });

    it("accepts when usage count is below limit", () => {
      const discount: Discount = {
        ...baseDiscount,
        maxUses: 100,
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 99, 0);
      expect(result.valid).toBe(true);
    });

    it("ignores maxUses when null (unlimited)", () => {
      const result = validateDiscountApplicability(baseDiscount, 2000, 1, 999999, 0);
      expect(result.valid).toBe(true);
    });
  });

  describe("limitOnePerCustomer", () => {
    it("rejects when customer has already used the discount", () => {
      const discount: Discount = {
        ...baseDiscount,
        limitOnePerCustomer: true,
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 0, 1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("already used by this customer");
    });

    it("accepts when customer has not used the discount", () => {
      const discount: Discount = {
        ...baseDiscount,
        limitOnePerCustomer: true,
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 0, 0);
      expect(result.valid).toBe(true);
    });

    it("allows multiple uses when limitOnePerCustomer is false", () => {
      const discount: Discount = {
        ...baseDiscount,
        limitOnePerCustomer: false,
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 0, 5);
      expect(result.valid).toBe(true);
    });
  });

  describe("date validation", () => {
    it("rejects discount that hasn't started yet", () => {
      const discount: Discount = {
        ...baseDiscount,
        startDate: new Date("2099-01-01"),
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 0, 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not started yet");
    });

    it("rejects expired discount", () => {
      const discount: Discount = {
        ...baseDiscount,
        endDate: new Date("2020-01-01"),
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 0, 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("expired");
    });

    it("accepts discount with no end date", () => {
      const result = validateDiscountApplicability(baseDiscount, 2000, 1, 0, 0);
      expect(result.valid).toBe(true);
    });
  });

  describe("inactive/deleted discounts", () => {
    it("rejects inactive discount", () => {
      const discount: Discount = {
        ...baseDiscount,
        isActive: false,
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 0, 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not active");
    });

    it("rejects deleted discount", () => {
      const discount: Discount = {
        ...baseDiscount,
        deletedAt: new Date(),
      };

      const result = validateDiscountApplicability(discount, 2000, 1, 0, 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("deleted");
    });
  });

  describe("minQuantity", () => {
    it("rejects order below minimum quantity", () => {
      const discount: Discount = {
        ...baseDiscount,
        minQuantity: 5,
      };

      const result = validateDiscountApplicability(discount, 2000, 3, 0, 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Minimum quantity");
    });

    it("accepts order at exact minimum quantity", () => {
      const discount: Discount = {
        ...baseDiscount,
        minQuantity: 5,
      };

      const result = validateDiscountApplicability(discount, 2000, 5, 0, 0);
      expect(result.valid).toBe(true);
    });
  });
});
