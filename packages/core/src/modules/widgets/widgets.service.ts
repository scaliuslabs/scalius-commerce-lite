// src/modules/widgets/widgets.service.ts
// All DB queries and business logic for the widgets domain.

import { widgets, widgetHistory, collections } from "@scalius/database/schema";
import type { WidgetHistory } from "@scalius/database/schema";
import { isNull, asc, and, sql, inArray, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";
import {
    createWidgetSchema,
    updateWidgetSchema,
    type CreateWidgetInput,
    type UpdateWidgetInput,
} from "./widgets.validation";

export { createWidgetSchema, updateWidgetSchema, type CreateWidgetInput, type UpdateWidgetInput };

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listWidgets(db: Database, options?: { showTrashed?: boolean }) {
    const { showTrashed = false } = options ?? {};
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
        .where(showTrashed ? sql`${widgets.deletedAt} IS NOT NULL` : isNull(widgets.deletedAt))
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
    if (!existing) throw new NotFoundError("Widget not found");

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

// ─────────────────────────────────────────
// History
// ─────────────────────────────────────────

export async function createHistoryEntry(
    db: Database,
    widgetId: string,
    reason: string = "Manual save",
): Promise<WidgetHistory> {
    const widget = await getWidgetById(db, widgetId);
    if (!widget) throw new NotFoundError("Widget not found");

    return db
        .insert(widgetHistory)
        .values({
            id: "whist_" + nanoid(),
            widgetId,
            htmlContent: widget.htmlContent,
            cssContent: widget.cssContent,
            reason,
        })
        .returning()
        .get();
}

export async function getWidgetHistory(db: Database, widgetId: string) {
    const widget = await getWidgetById(db, widgetId);
    if (!widget) throw new NotFoundError("Widget not found");

    return db
        .select()
        .from(widgetHistory)
        .where(eq(widgetHistory.widgetId, widgetId))
        .orderBy(sql`${widgetHistory.createdAt} DESC`);
}

export async function restoreFromHistory(
    db: Database,
    widgetId: string,
    historyId: string,
) {
    const widget = await getWidgetById(db, widgetId);
    if (!widget) throw new NotFoundError("Widget not found");

    const [entry] = await db
        .select()
        .from(widgetHistory)
        .where(and(eq(widgetHistory.id, historyId), eq(widgetHistory.widgetId, widgetId)));
    if (!entry) throw new NotFoundError("History entry not found");

    // Auto-snapshot current state before overwriting
    await createHistoryEntry(db, widgetId, "Auto-saved before restore");

    // Overwrite widget with history entry content
    await db
        .update(widgets)
        .set({
            htmlContent: entry.htmlContent,
            cssContent: entry.cssContent,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(widgets.id, widgetId));

    return { message: "Widget restored from history" };
}

export async function deleteHistoryEntry(
    db: Database,
    widgetId: string,
    historyId: string,
): Promise<void> {
    const [entry] = await db
        .select()
        .from(widgetHistory)
        .where(and(eq(widgetHistory.id, historyId), eq(widgetHistory.widgetId, widgetId)));
    if (!entry) throw new NotFoundError("History entry not found");

    await db.delete(widgetHistory).where(eq(widgetHistory.id, historyId));
}
