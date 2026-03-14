// src/lib/inventory/validation.ts
// Input validation guards for inventory data integrity.
// Prevents data corruption by validating invariants at the service layer.

import { ValidationError } from "@scalius/core/errors";
import { roundPrice } from "@scalius/shared/price-utils";

/**
 * Validate that stock value is non-negative.
 * Should be called on variant creation and stock adjustments.
 *
 * @throws ValidationError if stock < 0
 */
export function validateStockNonNegative(stock: number, label = "stock"): void {
  if (typeof stock !== "number" || !Number.isFinite(stock)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  if (stock < 0) {
    throw new ValidationError(`${label} must be >= 0, got ${stock}`);
  }
}

/**
 * Validate that backorder limit is non-negative.
 * A value of 0 means "unlimited backorders".
 *
 * @throws ValidationError if backorderLimit < 0
 */
export function validateBackorderLimit(backorderLimit: number): void {
  if (typeof backorderLimit !== "number" || !Number.isFinite(backorderLimit)) {
    throw new ValidationError("backorderLimit must be a finite number");
  }
  if (backorderLimit < 0) {
    throw new ValidationError(
      `backorderLimit must be >= 0 (0 = unlimited), got ${backorderLimit}`
    );
  }
}

/**
 * Validate that reservedStock does not exceed stock.
 * Catches logical inconsistencies before they persist.
 *
 * @throws ValidationError if reservedStock > stock
 */
export function validateReservedStockConsistency(
  stock: number,
  reservedStock: number
): void {
  if (reservedStock > stock) {
    throw new ValidationError(
      `reservedStock (${reservedStock}) cannot exceed stock (${stock})`
    );
  }
}

/**
 * Validate that quantity is a positive integer.
 * Used for reservation, deduction, and release operations.
 *
 * @throws ValidationError if quantity <= 0 or not an integer
 */
export function validatePositiveQuantity(quantity: number): void {
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    throw new ValidationError("quantity must be a finite number");
  }
  if (quantity <= 0) {
    throw new ValidationError(`quantity must be > 0, got ${quantity}`);
  }
  if (!Number.isInteger(quantity)) {
    throw new ValidationError(`quantity must be an integer, got ${quantity}`);
  }
}

/**
 * Calculate the final price after applying a discount.
 * Validates that the result is non-negative.
 *
 * @param price - Original price (must be >= 0)
 * @param discountType - "percentage" or "flat"
 * @param discountPercentage - Percentage discount (0-100), used when type is "percentage"
 * @param discountAmount - Flat discount amount, used when type is "flat"
 * @returns The final price after discount
 * @throws ValidationError if the result would be negative
 */
export function calculateFinalPrice(
  price: number,
  discountType: "percentage" | "flat" | null | undefined,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined
): number {
  if (price < 0) {
    throw new ValidationError(`Base price must be >= 0, got ${price}`);
  }

  if (!discountType) {
    return price;
  }

  let finalPrice: number;

  if (discountType === "percentage") {
    const pct = discountPercentage ?? 0;
    if (pct < 0 || pct > 100) {
      throw new ValidationError(
        `discountPercentage must be between 0 and 100, got ${pct}`
      );
    }
    finalPrice = roundPrice(price * (1 - pct / 100));
  } else if (discountType === "flat") {
    const amount = discountAmount ?? 0;
    if (amount < 0) {
      throw new ValidationError(
        `discountAmount must be >= 0, got ${amount}`
      );
    }
    finalPrice = roundPrice(price - amount);
  } else {
    return price;
  }

  if (finalPrice < 0) {
    throw new ValidationError(
      `Final price after discount would be negative (${finalPrice}). ` +
        `Price: ${price}, discount: ${discountType === "percentage" ? `${discountPercentage}%` : `${discountAmount} flat`}`
    );
  }

  return finalPrice;
}
