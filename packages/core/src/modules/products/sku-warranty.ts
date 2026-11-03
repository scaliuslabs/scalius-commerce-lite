// A SKU's warranty (migration 0189): it inherits its product's policy, names
// its own, or has none. Checkout freezes the effective policy's current
// revision onto the order line; an archived own policy freezes none.
import { z } from "zod";

export const SKU_WARRANTY_MODES = ["inherit", "policy", "none"] as const;
export type SkuWarrantyMode = (typeof SKU_WARRANTY_MODES)[number];

/** A warranty policy id; a write checks it exists and is not archived. */
export const warrantyPolicyIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^wrp_[A-Za-z0-9_-]+$/u, "Choose a warranty policy from the list.");

/** A SKU write's warranty fields: omit both to keep a saved SKU's (a new SKU inherits). */
export const skuWarrantyInputShape = {
    warrantyMode: z.enum(SKU_WARRANTY_MODES).optional()
        .describe("inherit: the product's warranty; policy: warrantyPolicyId; none: no warranty. Omit to keep (a new SKU inherits)."),
    warrantyPolicyId: warrantyPolicyIdSchema.nullable().optional()
        .describe("The SKU's own live warranty policy (wrp_…), exactly when warrantyMode is policy."),
};

export interface SkuWarrantyInput {
    warrantyMode?: SkuWarrantyMode | undefined;
    warrantyPolicyId?: string | null | undefined;
}

/** The stored pair, or undefined when the input leaves the SKU's warranty alone. */
export function skuWarrantyColumns(input: SkuWarrantyInput):
    { warrantyMode: SkuWarrantyMode; warrantyPolicyId: string | null } | undefined {
    if (input.warrantyMode === undefined) return undefined;
    return {
        warrantyMode: input.warrantyMode,
        warrantyPolicyId: input.warrantyMode === "policy" ? input.warrantyPolicyId ?? null : null,
    };
}

/** Adds the issue of an inconsistent pair: a policy exactly in `policy` mode, and never without a mode. */
export function addSkuWarrantyIssues(value: SkuWarrantyInput, context: z.RefinementCtx, path: Array<string | number> = []): void {
    if (value.warrantyMode === "policy" && !value.warrantyPolicyId) {
        context.addIssue({ code: "custom", path: [...path, "warrantyPolicyId"], message: "Choose the warranty policy for this SKU." });
    } else if (value.warrantyMode !== "policy" && value.warrantyPolicyId) {
        context.addIssue({
            code: "custom",
            path: [...path, "warrantyPolicyId"],
            message: "Set warrantyMode to policy to give this SKU its own warranty policy.",
        });
    }
}
