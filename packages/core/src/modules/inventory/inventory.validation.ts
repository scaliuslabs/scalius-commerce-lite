import { z } from "zod";

const signedStockAdjustmentSchema = z
    .number({ message: "delta (number) is required" })
    .int("Adjustment must be a whole number.")
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER)
    .refine((value) => value !== 0, "Adjustment must not be zero.");

export const inventoryOperationKeySchema = z
    .string()
    .trim()
    .min(16, "operationKey must be at least 16 characters")
    .max(128, "operationKey must be at most 128 characters")
    .regex(
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
        "operationKey contains unsupported characters",
    );

export const adjustInventorySchema = z.object({
    operationKey: inventoryOperationKeySchema,
    delta: signedStockAdjustmentSchema,
    reason: z.enum(["received", "correction", "damage", "theft", "return", "other"]),
    notes: z.string().trim().max(500).optional(),
    pool: z.enum(["stock", "preorderStock"]).optional().default("stock"),
}).superRefine((value, context) => {
    if ((value.reason === "received" || value.reason === "return") && value.delta < 0) {
        context.addIssue({
            code: "custom",
            path: ["reason"],
            message: "Stock received and customer return require a positive adjustment.",
        });
    }
    if ((value.reason === "damage" || value.reason === "theft") && value.delta > 0) {
        context.addIssue({
            code: "custom",
            path: ["reason"],
            message: "Damage and theft require a negative adjustment.",
        });
    }
});
