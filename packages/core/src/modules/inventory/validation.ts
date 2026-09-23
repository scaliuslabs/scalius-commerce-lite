// src/lib/inventory/validation.ts
// Input validation guards for inventory data integrity.
// Prevents data corruption by validating invariants at the service layer.

import { ValidationError } from "@scalius/core/errors";

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
 * Validate a relative stock adjustment without changing its meaning.
 * Manual stock writes must never round fractional values or clamp an
 * overdraw to a smaller movement because the audit row must match the
 * merchant's submitted operation exactly.
 */
export function validateSignedStockAdjustment(
  adjustment: number,
  label = "adjustment",
): void {
  if (!Number.isSafeInteger(adjustment)) {
    throw new ValidationError(`${label} must be a safe integer`);
  }
  if (adjustment === 0) {
    throw new ValidationError(`${label} must not be zero`);
  }
}

/** Validate an absolute stocktake count at every service boundary. */
export function validateAbsoluteStockCount(
  stock: number,
  label = "newStock",
): void {
  if (!Number.isSafeInteger(stock)) {
    throw new ValidationError(`${label} must be a safe integer`);
  }
  if (stock < 0) {
    throw new ValidationError(`${label} must be greater than or equal to zero`);
  }
}
