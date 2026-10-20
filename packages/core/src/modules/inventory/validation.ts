// src/lib/inventory/validation.ts
// Input validation guards for inventory data integrity.
// Prevents data corruption by validating invariants at the service layer.

import { z } from "zod";
import { ValidationError } from "@scalius/core/errors";

/** Parses a purchasing or location input; the first issue is the message. */
export function parseInventoryInput<T>(schema: z.ZodType<T>, input: unknown, fallback: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

export const optionalTextSchema = (max: number) => z.string().trim().max(max).nullable().optional();

export const dateOnlySchema = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Use a real calendar date.");

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
