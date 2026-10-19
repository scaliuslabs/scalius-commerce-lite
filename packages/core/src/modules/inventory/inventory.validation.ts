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

const adjustInventoryFields = {
    delta: signedStockAdjustmentSchema,
    reason: z.enum(["received", "correction", "damage", "theft", "return", "other"]),
    notes: z.string().trim().max(500).optional(),
    pool: z.enum(["stock", "preorderStock"]).optional().default("stock"),
    /** On-hand stock only: the active location adjusted; the default location when omitted. */
    locationId: z.string().trim().min(1).max(100).optional(),
} as const;

function validateAdjustmentReason(
    value: { delta: number; reason: "received" | "correction" | "damage" | "theft" | "return" | "other" },
    context: z.RefinementCtx,
) {
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
}

export const adjustInventorySchema = z.object({
    operationKey: inventoryOperationKeySchema,
    ...adjustInventoryFields,
}).superRefine(validateAdjustmentReason);

/**
 * The stable app API's adjustment (`dashboard.inventory.adjust`): its retry
 * key is the Idempotency-Key header, from which the ledger's operation key
 * is derived.
 */
export const adjustInventoryRequestSchema = z.object({
    ...adjustInventoryFields,
    expectedStockVersion: z.number().int().min(0).optional()
        .describe("The SKU's stockVersion you read; any stock change since is refused with 409. Omit to apply whatever happened since."),
}).superRefine(validateAdjustmentReason);
