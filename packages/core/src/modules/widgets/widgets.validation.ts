// src/modules/widgets/widgets.validation.ts
// Zod schemas for widget create/update operations.
// Imported by admin API routes and WidgetService.

import { z } from "zod";
import { WidgetPlacementRule } from "@scalius/database/schema";

/** Base shape without .refine() so .partial() works for the update schema */
const widgetBaseSchema = z.object({
    name: z.string().min(3),
    htmlContent: z.string().min(1),
    cssContent: z.string().optional(),
    aiContext: z.record(z.string(), z.unknown()).nullable().optional(),
    isActive: z.boolean().default(true),
    displayTarget: z.enum(["homepage"]).default("homepage"),
    placementRule: z.enum([
        WidgetPlacementRule.BEFORE_COLLECTION,
        WidgetPlacementRule.AFTER_COLLECTION,
        WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
        WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
        WidgetPlacementRule.STANDALONE,
    ]),
    referenceCollectionId: z.string().optional().nullable(),
    sortOrder: z.number().int().optional().default(0),
});

/** Validates that collection-based placement rules have a referenceCollectionId */
function validateCollectionRef(data: { placementRule?: string; referenceCollectionId?: string | null }) {
    if (
        data.placementRule !== undefined &&
        (data.placementRule === WidgetPlacementRule.BEFORE_COLLECTION ||
            data.placementRule === WidgetPlacementRule.AFTER_COLLECTION) &&
        !data.referenceCollectionId
    ) {
        return false;
    }
    return true;
}

const collectionRefMessage = {
    message: "A reference collection is required for this placement rule.",
    path: ["referenceCollectionId"] as string[],
};

/** Schema for creating a new widget (POST /api/widgets) */
export const createWidgetSchema = widgetBaseSchema.refine(
    validateCollectionRef,
    collectionRefMessage,
);

/** Schema for updating an existing widget (PUT /api/widgets/:id) */
export const updateWidgetSchema = widgetBaseSchema.partial().refine(
    validateCollectionRef,
    collectionRefMessage,
);

export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;
export type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>;
