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
    findDuplicateWidgetPlacementIndexes,
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
        WidgetPlacementScope.COLLECTION,
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
    if (placement.isActive === false) return;

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

const widgetPlacementListSchema = z.array(widgetPlacementInputSchema).superRefine((placements, ctx) => {
    const activePlacements = placements.filter((placement) => placement.isActive !== false);
    for (const duplicate of findDuplicateWidgetPlacementIndexes(activePlacements)) {
        const duplicateIndex = placements.indexOf(activePlacements[duplicate.duplicateIndex]!);
        const firstIndex = placements.indexOf(activePlacements[duplicate.firstIndex]!);
        ctx.addIssue({
            code: "custom",
            message: "Duplicate widget placement target.",
            path: [duplicateIndex],
        });
        ctx.addIssue({
            code: "custom",
            message: "Duplicate widget placement target.",
            path: [firstIndex],
        });
    }
});

const placementRuleSchema = z.enum([
    WidgetPlacementRule.BEFORE_COLLECTION,
    WidgetPlacementRule.AFTER_COLLECTION,
    WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
    WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
    WidgetPlacementRule.STANDALONE,
]);

/** Create shape keeps defaults. Update shape below is intentionally default-free. */
const widgetBaseSchema = z.object({
    name: z.string().min(3),
    htmlContent: z.string(),
    cssContent: z.string().optional(),
    jsContent: z.string().optional(),
    aiContext: z.record(z.string(), z.unknown()).nullable().optional(),
    isActive: z.boolean().default(true),
    displayTarget: z.enum(["homepage"]).default("homepage"),
    placementRule: placementRuleSchema.default(WidgetPlacementRule.STANDALONE),
    referenceCollectionId: z.string().optional().nullable(),
    sortOrder: z.number().int().optional().default(0),
    placements: widgetPlacementListSchema.optional(),
});

const widgetUpdateBaseSchema = z.object({
    name: z.string().min(3),
    htmlContent: z.string(),
    cssContent: z.string().optional(),
    jsContent: z.string().optional(),
    aiContext: z.record(z.string(), z.unknown()).nullable().optional(),
    isActive: z.boolean(),
    displayTarget: z.enum(["homepage"]),
    placementRule: placementRuleSchema,
    referenceCollectionId: z.string().optional().nullable(),
    sortOrder: z.number().int(),
    placements: widgetPlacementListSchema,
}).partial();

type CreateWidgetInputDraft = z.infer<typeof widgetBaseSchema>;
type UpdateWidgetInputDraft = z.infer<typeof widgetUpdateBaseSchema>;

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

function hasRenderableWidgetContent(data: { htmlContent?: string }): boolean {
    return typeof data.htmlContent === "string" && data.htmlContent.trim().length > 0;
}

function validatePublishableWidget(
    data: {
        htmlContent?: string;
        isActive?: boolean;
        placements?: WidgetPlacementInput[];
        placementRule?: WidgetPlacementRule;
        referenceCollectionId?: string | null;
    },
    ctx: z.RefinementCtx,
): void {
    if (data.isActive !== true) return;

    if (!hasRenderableWidgetContent(data)) {
        ctx.addIssue({
            code: "custom",
            message: "HTML content is required before publishing a widget.",
            path: ["htmlContent"],
        });
    }
}

function validateCreateWidget(data: CreateWidgetInputDraft, ctx: z.RefinementCtx): void {
    if (!validateCollectionRef(data)) {
        ctx.addIssue({
            code: "custom",
            message: collectionRefMessage.message,
            path: collectionRefMessage.path,
        });
    }

    validatePublishableWidget(data, ctx);
}

function validateUpdateWidget(data: UpdateWidgetInputDraft, ctx: z.RefinementCtx): void {
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

    if (data.isActive === true && data.htmlContent !== undefined && !hasRenderableWidgetContent(data)) {
        ctx.addIssue({
            code: "custom",
            message: "HTML content is required before publishing a widget.",
            path: ["htmlContent"],
        });
    }

}

/** Schema for creating a new widget (POST /api/widgets) */
export const createWidgetSchema = widgetBaseSchema.superRefine(validateCreateWidget);

/** Schema for updating an existing widget (PUT /api/widgets/:id) */
export const updateWidgetSchema = widgetUpdateBaseSchema.superRefine(validateUpdateWidget);

export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;
export type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>;
export type WidgetPlacementInput = z.infer<typeof widgetPlacementInputSchema>;
