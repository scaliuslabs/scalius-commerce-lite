// src/modules/widgets/widgets.service.ts
// All DB queries and business logic for the widgets domain.

import { widgets, collections, WidgetPlacementRule } from "@scalius/database/schema";
import { isNull, asc, and, sql, inArray, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Database } from "@scalius/database/client";

// ─────────────────────────────────────────
// Schema
// ─────────────────────────────────────────

// Base shape without .refine() so .partial() works for the update schema
const widgetBaseSchema = z.object({
    name: z.string().min(3),
    htmlContent: z.string().min(1),
    cssContent: z.string().optional(),
    aiContext: z.any().optional(),
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

// Create schema adds the cross-field validation refine
export const createWidgetSchema = widgetBaseSchema.refine(
    (data) => {
        if (
            (data.placementRule === WidgetPlacementRule.BEFORE_COLLECTION ||
                data.placementRule === WidgetPlacementRule.AFTER_COLLECTION) &&
            !data.referenceCollectionId
        ) {
            return false;
        }
        return true;
    },
    {
        message: "A reference collection is required for this placement rule.",
        path: ["referenceCollectionId"],
    },
);

// Update schema is partial of the base (no cross-field validation needed for partial updates)
export const updateWidgetSchema = widgetBaseSchema.partial();

export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;
export type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>;

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listWidgets(db: Database) {
    const allWidgets = await db
        .select({
            id: widgets.id,
            name: widgets.name,
            htmlContent: widgets.htmlContent,
            cssContent: widgets.cssContent,
            aiContext: widgets.aiContext,
            isActive: widgets.isActive,
            displayTarget: widgets.displayTarget,
            placementRule: widgets.placementRule,
            referenceCollectionId: widgets.referenceCollectionId,
            sortOrder: widgets.sortOrder,
            createdAt: sql<number>`CAST(${widgets.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${widgets.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${widgets.deletedAt} AS INTEGER)`,
        })
        .from(widgets)
        .where(isNull(widgets.deletedAt))
        .orderBy(asc(widgets.sortOrder), asc(widgets.name));

    const availableCollections = await db
        .select({
            id: collections.id,
            name: collections.name,
            sortOrder: collections.sortOrder,
            type: collections.type,
        })
        .from(collections)
        .where(and(isNull(collections.deletedAt), eq(collections.isActive, true)))
        .orderBy(asc(collections.sortOrder));

    return { widgets: allWidgets, availableCollections };
}

export async function getWidgetById(db: Database, id: string) {
    return db
        .select()
        .from(widgets)
        .where(and(eq(widgets.id, id), isNull(widgets.deletedAt)))
        .get() ?? null;
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createWidget(db: Database, data: CreateWidgetInput) {
    return db
        .insert(widgets)
        .values({
            id: "wid_" + nanoid(),
            name: data.name,
            htmlContent: data.htmlContent,
            cssContent: data.cssContent,
            isActive: data.isActive,
            displayTarget: data.displayTarget,
            placementRule: data.placementRule,
            referenceCollectionId: data.referenceCollectionId,
            sortOrder: data.sortOrder,
            aiContext: data.aiContext ? JSON.stringify(data.aiContext) : null,
        })
        .returning()
        .get();
}

export async function updateWidget(db: Database, id: string, data: UpdateWidgetInput) {
    const existing = await getWidgetById(db, id);
    if (!existing) throw Object.assign(new Error("Widget not found"), { statusCode: 404 });

    const updateData: Record<string, unknown> = { updatedAt: sql`unixepoch()` };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.htmlContent !== undefined) updateData.htmlContent = data.htmlContent;
    if (data.cssContent !== undefined) updateData.cssContent = data.cssContent;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.displayTarget !== undefined) updateData.displayTarget = data.displayTarget;
    if (data.placementRule !== undefined) updateData.placementRule = data.placementRule;
    if (data.referenceCollectionId !== undefined) updateData.referenceCollectionId = data.referenceCollectionId;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
    if (data.aiContext !== undefined) updateData.aiContext = data.aiContext ? JSON.stringify(data.aiContext) : null;

    return db.update(widgets).set(updateData).where(eq(widgets.id, id)).returning().get();
}

export async function deleteWidget(db: Database, id: string): Promise<void> {
    await db
        .update(widgets)
        .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
        .where(eq(widgets.id, id));
}

export async function bulkDeleteWidgets(db: Database, ids: string[], permanent = false): Promise<void> {
    if (permanent) {
        await db.delete(widgets).where(inArray(widgets.id, ids));
    } else {
        await db
            .update(widgets)
            .set({ deletedAt: sql`unixepoch()` })
            .where(inArray(widgets.id, ids));
    }
}

export async function bulkActivateWidgets(db: Database, ids: string[]): Promise<void> {
    await db.update(widgets).set({ isActive: true }).where(inArray(widgets.id, ids));
}

export async function bulkDeactivateWidgets(db: Database, ids: string[]): Promise<void> {
    await db.update(widgets).set({ isActive: false }).where(inArray(widgets.id, ids));
}

export async function restoreWidgets(db: Database, ids: string[]): Promise<void> {
    await db.update(widgets).set({ deletedAt: null }).where(inArray(widgets.id, ids));
}
