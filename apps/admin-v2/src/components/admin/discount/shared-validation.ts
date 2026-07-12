/**
 * Shared discount form validation constants and schemas.
 * All discount types (AmountOffProducts, AmountOffOrder, FreeShipping) should
 * import from here to ensure consistent validation rules.
 */
import { z } from "zod";

/** Discount code: 3-50 chars, alphanumeric + underscores + hyphens, stored uppercase */
export const discountCodeSchema = z
  .string()
  .trim()
  .min(3, { message: "Code must be at least 3 characters long" })
  .max(50, { message: "Code cannot exceed 50 characters" })
  .regex(/^[a-zA-Z0-9_-]+$/, {
    message: "Code can only contain letters, numbers, underscores, and hyphens",
  })
  .transform((v) => v.toUpperCase());

/** Common optional fields shared across all discount form types */
export const sharedDiscountFields = {
  minPurchaseAmount: z.coerce
    .number({ message: "Minimum purchase must be a number or empty" })
    .positive({ message: "Minimum purchase must be positive" })
    .nullable()
    .optional(),
  maxUsesPerOrder: z.coerce
    .number({ message: "Max uses per order must be an integer or empty" })
    .int({ message: "Max uses per order must be a whole number" })
    .positive({ message: "Max uses per order must be positive" })
    .max(1, { message: "Checkout accepts one discount code per order" })
    .nullable()
    .optional(),
  maxUses: z.coerce
    .number({ message: "Max total uses must be an integer or empty" })
    .int({ message: "Max total uses must be a whole number" })
    .positive({ message: "Max total uses must be positive" })
    .nullable()
    .optional(),
  limitOnePerCustomer: z.boolean(),
  startDate: z.date({ message: "Start date is required" }),
  endDate: z.date().nullable().optional(),
  isActive: z.boolean(),
} as const;

/** End-date-after-start-date refinement, reusable across forms */
export function refineEndDateAfterStart<T extends { startDate: Date; endDate?: Date | null }>(
  schema: z.ZodType<T>,
) {
  return schema.refine(
    (data) => {
      if (data.endDate && data.startDate && data.endDate < data.startDate) {
        return false;
      }
      return true;
    },
    {
      message: "End date must be on or after the start date",
      path: ["endDate"],
    },
  );
}

/** Percentage discounts cannot exceed the complete eligible amount. */
export function refinePercentageAtMost100<
  T extends { valueType: "percentage" | "fixed_amount"; discountValue: number },
>(schema: z.ZodType<T>) {
  return schema.refine(
    (data) => data.valueType !== "percentage" || data.discountValue <= 100,
    {
      message: "Percentage discount cannot exceed 100%",
      path: ["discountValue"],
    },
  );
}

/** The current admin editor is date-based: starts are local-day inclusive. */
export function normalizeDiscountStartDate(value: Date): Date {
  const normalized = new Date(value);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

/** Date-based end dates remain valid through the selected merchant-local day. */
export function normalizeDiscountEndDate(value: Date): Date {
  const normalized = new Date(value);
  normalized.setHours(23, 59, 59, 999);
  return normalized;
}
