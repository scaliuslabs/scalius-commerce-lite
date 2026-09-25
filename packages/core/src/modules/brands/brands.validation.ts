// Brand write schemas (browser-safe). The record rules (id, name, slug,
// statuses) are single-sourced in @scalius/shared/catalog-brand; this file
// adds the dashboard and agent write shapes on top of them.
import { z } from "zod";
import {
    BRAND_DESCRIPTION_MAX_LENGTH,
    BRAND_STATUSES,
    brandNameSchema,
    brandSlugSchema,
} from "@scalius/shared/catalog-brand";
import { templateAssignmentSchema } from "@scalius/shared/catalog-tree";
import {
    isValidResourceCanonicalPath,
    normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";

/** Most brands one bulk trash, restore or delete may claim (D1's bound-parameter budget). */
export const BRAND_BATCH_LIMIT = 90;
export const BRAND_SORT_ORDER_LIMIT = 1_000_000;

export const brandStatusSchema = z.enum(BRAND_STATUSES);
export const brandIdSchema = z.string().trim().min(1).max(68);

const nullableText = (max: number) =>
    z.string().trim().max(max).nullable().optional().transform((value) => value || null);

const canonicalPathSchema = z
    .string()
    .nullable()
    .optional()
    .transform((value) => normalizeCanonicalPathInput(value))
    .refine((value) => value === null || isValidResourceCanonicalPath("brand", value), {
        message: "Canonical path must be a brand route such as /brands/walton.",
    });

const brandFields = z.object({
    name: brandNameSchema,
    description: nullableText(BRAND_DESCRIPTION_MAX_LENGTH)
        .describe("Buyer-facing brand story shown on the brand page (sanitised rich text)."),
    logoMediaId: z.string().trim().min(1).max(180).nullable().optional()
        .describe("A ready image from Files, or null for no logo."),
    sortOrder: z.number().int().min(-BRAND_SORT_ORDER_LIMIT).max(BRAND_SORT_ORDER_LIMIT).optional()
        .describe("Brand wall and brand list order, lowest first; ties sort by name."),
    metaTitle: nullableText(70),
    metaDescription: nullableText(200),
    canonicalPath: canonicalPathSchema,
    noIndex: z.boolean().optional().default(false),
    excludeFromSitemap: z.boolean().optional().default(false),
    listingTemplate: templateAssignmentSchema.optional()
        .describe("A listing template id from the theme, or null for the theme's default brand listing."),
});

function requireCanonicalBrandHandle(
    value: { slug?: string; canonicalPath?: string | null },
    context: z.RefinementCtx,
): void {
    if (value.canonicalPath !== null && value.canonicalPath !== undefined
        && (value.slug === undefined || value.canonicalPath !== `/brands/${value.slug}`)) {
        context.addIssue({
            code: "custom",
            path: ["canonicalPath"],
            message: "Canonical path must use this brand's current slug until URL aliases are supported.",
        });
    }
}

const expectedRevisionSchema = z.number().int().min(1);

export const createBrandSchema = brandFields.extend({
    slug: brandSlugSchema.optional()
        .describe("Omit to derive the web address from the name; a taken one gets a -2, -3… suffix."),
    status: brandStatusSchema.optional().default("draft"),
}).superRefine(requireCanonicalBrandHandle);

export const updateBrandSchema = brandFields.extend({
    slug: brandSlugSchema,
    status: brandStatusSchema,
    expectedRevision: expectedRevisionSchema,
}).superRefine(requireCanonicalBrandHandle);

export const updateBrandStatusSchema = z.object({
    expectedRevision: expectedRevisionSchema,
    status: brandStatusSchema,
});

export const brandRevisionClaimSchema = z.object({
    id: brandIdSchema,
    expectedRevision: expectedRevisionSchema,
});

export type CreateBrandInput = z.infer<typeof createBrandSchema>;
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
export type UpdateBrandStatusInput = z.infer<typeof updateBrandStatusSchema>;
export type BrandRevisionClaim = z.infer<typeof brandRevisionClaimSchema>;
export type BrandStatus = z.infer<typeof brandStatusSchema>;
