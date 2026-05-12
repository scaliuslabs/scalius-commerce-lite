// src/modules/widgets/widgets.validation.ts
// Zod schemas for widget create/update operations.
// Imported by admin API routes and WidgetService.

import { z } from "zod";
import {
    WidgetPlacementAnchorType,
    WidgetPlacementRule,
    WidgetPlacementScope,
    WidgetPlacementSlot,
} from "@scalius/database/schema";
import {
    isWidgetCollectionSlot,
    isWidgetPlacementSlotAllowedForScope,
} from "@scalius/shared/widget-placement";

export const widgetPlacementInputSchema = z.object({
    id: z.string().optional(),
    scope: z.enum([
        WidgetPlacementScope.HOMEPAGE,
        WidgetPlacementScope.PAGE,
        WidgetPlacementScope.PRODUCT,
        WidgetPlacementScope.CATEGORY,
    ]).default(WidgetPlacementScope.HOMEPAGE),
    scopeId: z.string().optional().nullable(),
    slot: z.enum([
        WidgetPlacementSlot.TOP,
        WidgetPlacementSlot.BOTTOM,
        WidgetPlacementSlot.BEFORE_CONTENT,
        WidgetPlacementSlot.AFTER_CONTENT,
        WidgetPlacementSlot.BEFORE_COLLECTION,
        WidgetPlacementSlot.AFTER_COLLECTION,
    ]).default(WidgetPlacementSlot.TOP),
    anchorType: z.enum([
        WidgetPlacementAnchorType.COLLECTION,
        WidgetPlacementAnchorType.CONTENT,
    ]).optional().nullable(),
    anchorId: z.string().optional().nullable(),
    sortOrder: z.number().int().optional().default(0),
    isActive: z.boolean().optional().default(true),
}).superRefine((placement, ctx) => {
    if (!isWidgetPlacementSlotAllowedForScope(placement.scope, placement.slot)) {
        ctx.addIssue({
            code: "custom",
            message: "This placement slot is not valid for the selected scope.",
            path: ["slot"],
        });
    }

    if (placement.scope !== WidgetPlacementScope.HOMEPAGE && !placement.scopeId) {
        ctx.addIssue({
            code: "custom",
            message: "This placement scope requires a scopeId.",
            path: ["scopeId"],
        });
    }

    if (placement.scope === WidgetPlacementScope.HOMEPAGE && placement.scopeId) {
        ctx.addIssue({
            code: "custom",
            message: "Homepage placements must not include a scopeId.",
            path: ["scopeId"],
        });
    }

    if (
        isWidgetCollectionSlot(placement.slot) &&
        (!placement.anchorId || placement.anchorType !== WidgetPlacementAnchorType.COLLECTION)
    ) {
        ctx.addIssue({
            code: "custom",
            message: "Collection-anchored placements require anchorType=collection and anchorId.",
            path: ["anchorId"],
        });
    }

    if (
        !isWidgetCollectionSlot(placement.slot) &&
        (placement.anchorType != null || placement.anchorId != null)
    ) {
        ctx.addIssue({
            code: "custom",
            message: "Only collection-anchored placements may include anchor fields.",
            path: ["anchorId"],
        });
    }
});

function placementIdentity(placement: WidgetPlacementInput): string {
    return [
        placement.scope,
        placement.scopeId ?? "",
        placement.slot,
        placement.anchorType ?? "",
        placement.anchorId ?? "",
    ].join("\u001f");
}

const widgetPlacementListSchema = z.array(widgetPlacementInputSchema).superRefine((placements, ctx) => {
    const seen = new Map<string, number>();
    placements.forEach((placement, index) => {
        const key = placementIdentity(placement);
        const firstIndex = seen.get(key);
        if (firstIndex !== undefined) {
            ctx.addIssue({
                code: "custom",
                message: "Duplicate widget placement target.",
                path: [index],
            });
            ctx.addIssue({
                code: "custom",
                message: "Duplicate widget placement target.",
                path: [firstIndex],
            });
            return;
        }
        seen.set(key, index);
    });
});

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
    ]).default(WidgetPlacementRule.STANDALONE),
    referenceCollectionId: z.string().optional().nullable(),
    sortOrder: z.number().int().optional().default(0),
    placements: widgetPlacementListSchema.optional(),
});

/** Validates projected placement fields only when canonical placement rows are absent. */
function validateCollectionRef(data: {
    placementRule?: string;
    referenceCollectionId?: string | null;
    placements?: WidgetPlacementInput[];
}) {
    if (data.placements !== undefined) {
        return true;
    }

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

function hasLegacyPlacementProjection(data: Partial<{
    displayTarget: string;
    placementRule: WidgetPlacementRule;
    referenceCollectionId: string | null;
    sortOrder: number;
}>): boolean {
    return data.displayTarget !== undefined ||
        data.placementRule !== undefined ||
        data.referenceCollectionId !== undefined ||
        data.sortOrder !== undefined;
}

/** Schema for creating a new widget (POST /api/widgets) */
export const createWidgetSchema = widgetBaseSchema.refine(
    validateCollectionRef,
    collectionRefMessage,
);

/** Schema for updating an existing widget (PUT /api/widgets/:id) */
export const updateWidgetSchema = widgetBaseSchema.partial().superRefine((data, ctx) => {
    if (!validateCollectionRef(data)) {
        ctx.addIssue({
            code: "custom",
            message: collectionRefMessage.message,
            path: collectionRefMessage.path,
        });
    }

    if (data.placements === undefined && hasLegacyPlacementProjection(data)) {
        ctx.addIssue({
            code: "custom",
            message: "Use canonical placements to change widget placement.",
            path: ["placements"],
        });
    }
});

export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;
export type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>;
export type WidgetPlacementInput = z.infer<typeof widgetPlacementInputSchema>;
