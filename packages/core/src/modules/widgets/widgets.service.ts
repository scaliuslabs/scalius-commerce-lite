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
import { sanitizeHtml } from "@scalius/shared/html-sanitize";

export { createWidgetSchema, updateWidgetSchema, type CreateWidgetInput, type UpdateWidgetInput };

// ─────────────────────────────────────────
// HTML Sanitization
// ─────────────────────────────────────────

/** Strip dangerous HTML patterns before serving widget content to storefront.
 *  Delegates to the shared sanitizer which handles entity-encoded event handlers,
 *  null bytes, CSS expressions, dangerous tags, and protocol-based XSS vectors. */
export function sanitizeWidgetHtml(html: string): string {
    if (!html) return html;
    return sanitizeHtml(html);
}

/** Strip dangerous CSS patterns from widget stylesheets.
 *  Removes: @import (external stylesheet loading), expression() (IE script exec),
 *  url(javascript:...), behavior/binding properties (IE/Firefox script exec). */
export function sanitizeWidgetCss(css: string): string {
    if (!css) return css;
    let result = css;
    // Remove @import rules (can load external stylesheets with script content)
    result = result.replace(/@import\b[^;]*;?/gi, "");
    // Remove expression() (IE CSS expressions execute JavaScript)
    result = result.replace(/expression\s*\(/gi, "blocked(");
    // Remove url(javascript:...) and url(vbscript:...)
    result = result.replace(/url\s*\(\s*(['"]?\s*(?:javascript|vbscript)\s*:)/gi, "url(blocked:");
    // Remove behavior and -moz-binding (IE/Firefox script execution via CSS)
    result = result.replace(/(?:behavior|(?:-moz-|-webkit-)?binding)\s*:/gi, "blocked:");
    return result;
}

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

/** Get active widget by ID with sanitized HTML for storefront rendering.
 *  WIRE: api-app should call this from routes/widgets.ts (getWidgetByIdRoute handler)
 *  replacing the inline DB query at lines 90-100. Same query shape + sanitization. */
export async function getActiveWidgetById(db: Database, id: string) {
    const widget = await db
        .select()
        .from(widgets)
        .where(and(eq(widgets.id, id), eq(widgets.isActive, true), isNull(widgets.deletedAt)))
        .get() ?? null;

    if (widget) {
        if (widget.htmlContent) widget.htmlContent = sanitizeWidgetHtml(widget.htmlContent);
        if (widget.cssContent) widget.cssContent = sanitizeWidgetCss(widget.cssContent);
    }
    return widget;
}

/** Get all active homepage widgets with sanitized HTML for storefront rendering.
 *  WIRE: api-app should call this from routes/widgets.ts (getActiveHomepageWidgetsRoute handler)
 *  replacing the inline DB query at lines 137-147. Same query shape + sanitization. */
export async function getActiveHomepageWidgets(db: Database) {
    const result = await db
        .select()
        .from(widgets)
        .where(and(eq(widgets.isActive, true), eq(widgets.displayTarget, "homepage"), isNull(widgets.deletedAt)))
        .orderBy(asc(widgets.placementRule), asc(widgets.sortOrder));

    return result.map((w) => ({
        ...w,
        htmlContent: w.htmlContent ? sanitizeWidgetHtml(w.htmlContent) : w.htmlContent,
        cssContent: w.cssContent ? sanitizeWidgetCss(w.cssContent) : w.cssContent,
    }));
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
    const existing = await getWidgetById(db, id);
    if (!existing) throw new NotFoundError("Widget not found");

    await db
        .update(widgets)
        .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
        .where(eq(widgets.id, id));
}

export async function bulkDeleteWidgets(db: Database, ids: string[], permanent = false): Promise<void> {
    if (ids.length === 0) return;
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
    if (ids.length === 0) return;
    await db.update(widgets).set({ isActive: true }).where(inArray(widgets.id, ids));
}

export async function bulkDeactivateWidgets(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.update(widgets).set({ isActive: false }).where(inArray(widgets.id, ids));
}

export async function restoreWidgets(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.update(widgets).set({ deletedAt: null, updatedAt: sql`unixepoch()` }).where(inArray(widgets.id, ids));
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

    // Atomic: snapshot current state + restore from history in a single batch
    await db.batch([
        db.insert(widgetHistory).values({
            id: "whist_" + nanoid(),
            widgetId,
            htmlContent: widget.htmlContent,
            cssContent: widget.cssContent,
            reason: "Auto-saved before restore",
        }),
        db.update(widgets)
            .set({
                htmlContent: entry.htmlContent,
                cssContent: entry.cssContent,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(widgets.id, widgetId)),
    ] as const);

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
