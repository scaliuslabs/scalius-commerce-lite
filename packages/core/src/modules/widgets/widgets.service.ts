// src/modules/widgets/widgets.service.ts
// All DB queries and business logic for the widgets domain.

import {
    widgets,
    widgetPlacements,
    widgetHistory,
    collections,
    pages,
    WidgetPlacementAnchorType,
    WidgetPlacementRule,
    WidgetPlacementScope,
    WidgetPlacementSlot,
} from "@scalius/database/schema";
import type { WidgetHistory, WidgetPlacement } from "@scalius/database/schema";
import { isNull, asc, and, sql, inArray, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";
import {
    createWidgetSchema,
    updateWidgetSchema,
    type CreateWidgetInput,
    type UpdateWidgetInput,
    type WidgetPlacementInput,
} from "./widgets.validation";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { sanitizeCssForStyleElement } from "@scalius/shared/css-sanitize";

export { createWidgetSchema, updateWidgetSchema, type CreateWidgetInput, type UpdateWidgetInput };

type WidgetPlacementInsert = typeof widgetPlacements.$inferInsert;

type LegacyPlacementFields = {
    displayTarget: "homepage";
    placementRule: WidgetPlacementRule;
    referenceCollectionId: string | null;
    sortOrder: number;
};

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

/** Strip dangerous CSS patterns from widget stylesheets before persistence/rendering. */
export function sanitizeWidgetCss(css: string): string {
    return sanitizeCssForStyleElement(css);
}

function legacyFieldsFromPlacement(placement?: WidgetPlacementInput | WidgetPlacement | null): LegacyPlacementFields {
    if (!placement || placement.scope !== WidgetPlacementScope.HOMEPAGE) {
        return {
            displayTarget: "homepage",
            placementRule: WidgetPlacementRule.STANDALONE,
            referenceCollectionId: null,
            sortOrder: 0,
        };
    }

    if (placement.slot === WidgetPlacementSlot.BEFORE_COLLECTION) {
        return {
            displayTarget: "homepage",
            placementRule: WidgetPlacementRule.BEFORE_COLLECTION,
            referenceCollectionId: placement.anchorId ?? null,
            sortOrder: placement.sortOrder ?? 0,
        };
    }

    if (placement.slot === WidgetPlacementSlot.AFTER_COLLECTION) {
        return {
            displayTarget: "homepage",
            placementRule: WidgetPlacementRule.AFTER_COLLECTION,
            referenceCollectionId: placement.anchorId ?? null,
            sortOrder: placement.sortOrder ?? 0,
        };
    }

    return {
        displayTarget: "homepage",
        placementRule:
            placement.slot === WidgetPlacementSlot.BOTTOM
                ? WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE
                : WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
        referenceCollectionId: null,
        sortOrder: placement.sortOrder ?? 0,
    };
}

function placementFromLegacyFields(data: {
    placementRule: WidgetPlacementRule;
    referenceCollectionId?: string | null;
    sortOrder?: number;
}): WidgetPlacementInput[] {
    const sortOrder = data.sortOrder ?? 0;
    switch (data.placementRule) {
        case WidgetPlacementRule.BEFORE_COLLECTION:
            return [{
                scope: WidgetPlacementScope.HOMEPAGE,
                slot: WidgetPlacementSlot.BEFORE_COLLECTION,
                anchorType: WidgetPlacementAnchorType.COLLECTION,
                anchorId: data.referenceCollectionId ?? null,
                sortOrder,
                isActive: true,
            }];
        case WidgetPlacementRule.AFTER_COLLECTION:
            return [{
                scope: WidgetPlacementScope.HOMEPAGE,
                slot: WidgetPlacementSlot.AFTER_COLLECTION,
                anchorType: WidgetPlacementAnchorType.COLLECTION,
                anchorId: data.referenceCollectionId ?? null,
                sortOrder,
                isActive: true,
            }];
        case WidgetPlacementRule.FIXED_TOP_HOMEPAGE:
            return [{
                scope: WidgetPlacementScope.HOMEPAGE,
                slot: WidgetPlacementSlot.TOP,
                sortOrder,
                isActive: true,
            }];
        case WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE:
            return [{
                scope: WidgetPlacementScope.HOMEPAGE,
                slot: WidgetPlacementSlot.BOTTOM,
                sortOrder,
                isActive: true,
            }];
        case WidgetPlacementRule.STANDALONE:
        default:
            return [];
    }
}

function normalizePlacementInserts(
    widgetId: string,
    placements: WidgetPlacementInput[] | undefined,
): WidgetPlacementInsert[] {
    return (placements ?? []).map((placement) => ({
        id: "wpl_" + nanoid(),
        widgetId,
        scope: placement.scope,
        scopeId: placement.scopeId ?? null,
        slot: placement.slot,
        anchorType: placement.anchorType ?? null,
        anchorId: placement.anchorId ?? null,
        sortOrder: placement.sortOrder ?? 0,
        isActive: placement.isActive ?? true,
        deletedAt: null,
    }));
}

function groupPlacementsByWidget(placements: WidgetPlacement[]) {
    const byWidget = new Map<string, WidgetPlacement[]>();
    for (const placement of placements) {
        const list = byWidget.get(placement.widgetId) ?? [];
        list.push(placement);
        byWidget.set(placement.widgetId, list);
    }
    return byWidget;
}

const slotSortRank: Record<string, number> = {
    [WidgetPlacementSlot.TOP]: 10,
    [WidgetPlacementSlot.BEFORE_CONTENT]: 20,
    [WidgetPlacementSlot.BEFORE_COLLECTION]: 30,
    [WidgetPlacementSlot.AFTER_COLLECTION]: 40,
    [WidgetPlacementSlot.AFTER_CONTENT]: 50,
    [WidgetPlacementSlot.BOTTOM]: 60,
};

function sortPlacementRows<
    T extends {
        name: string;
        id: string;
        placement: Pick<WidgetPlacement, "slot" | "sortOrder" | "anchorId">;
    },
>(rows: T[]): T[] {
    return [...rows].sort((a, b) => {
        const slotDiff =
            (slotSortRank[a.placement.slot] ?? 999) -
            (slotSortRank[b.placement.slot] ?? 999);
        if (slotDiff !== 0) return slotDiff;

        const anchorDiff = (a.placement.anchorId ?? "").localeCompare(
            b.placement.anchorId ?? "",
        );
        if (anchorDiff !== 0) return anchorDiff;

        const orderDiff = a.placement.sortOrder - b.placement.sortOrder;
        if (orderDiff !== 0) return orderDiff;

        const nameDiff = a.name.localeCompare(b.name);
        return nameDiff !== 0 ? nameDiff : a.id.localeCompare(b.id);
    });
}

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listWidgets(db: Database, options?: { showTrashed?: boolean }) {
    const { showTrashed = false } = options ?? {};
    const [allWidgets, allPlacements, availableCollections, availablePages] = await Promise.all([
        db
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
        .orderBy(asc(widgets.sortOrder), asc(widgets.name)),

        db
            .select()
            .from(widgetPlacements)
            .where(showTrashed ? sql`1 = 1` : isNull(widgetPlacements.deletedAt))
            .orderBy(asc(widgetPlacements.sortOrder)),

        db
        .select({
            id: collections.id,
            name: collections.name,
            sortOrder: collections.sortOrder,
            type: collections.type,
        })
        .from(collections)
        .where(and(isNull(collections.deletedAt), eq(collections.isActive, true)))
        .orderBy(asc(collections.sortOrder)),

        db
            .select({
                id: pages.id,
                title: pages.title,
                slug: pages.slug,
                sortOrder: pages.sortOrder,
            })
            .from(pages)
            .where(isNull(pages.deletedAt))
            .orderBy(asc(pages.sortOrder), asc(pages.title)),
    ]);

    const placementsByWidget = groupPlacementsByWidget(allPlacements as WidgetPlacement[]);

    return {
        widgets: allWidgets.map((widget) => ({
            ...widget,
            placements: placementsByWidget.get(widget.id) ?? [],
        })),
        availableCollections,
        availablePages,
    };
}

export async function getWidgetById(db: Database, id: string) {
    const widget = await db
        .select()
        .from(widgets)
        .where(and(eq(widgets.id, id), isNull(widgets.deletedAt)))
        .get() ?? null;

    if (!widget) return null;

    const placements = await db
        .select()
        .from(widgetPlacements)
        .where(and(eq(widgetPlacements.widgetId, id), isNull(widgetPlacements.deletedAt)))
        .orderBy(asc(widgetPlacements.sortOrder));

    return { ...widget, placements };
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
        const placements = await db
            .select()
            .from(widgetPlacements)
            .where(and(
                eq(widgetPlacements.widgetId, id),
                eq(widgetPlacements.isActive, true),
                isNull(widgetPlacements.deletedAt),
            ))
            .orderBy(asc(widgetPlacements.sortOrder));
        return { ...widget, placements };
    }
    return widget;
}

/** Get all active homepage widgets with sanitized HTML for storefront rendering.
 *  WIRE: api-app should call this from routes/widgets.ts (getActiveHomepageWidgetsRoute handler)
 *  replacing the inline DB query at lines 137-147. Same query shape + sanitization. */
export async function getActiveHomepageWidgets(db: Database) {
    return getActiveWidgetPlacements(db, { scope: WidgetPlacementScope.HOMEPAGE });
}

export async function getActiveWidgetPlacements(
    db: Database,
    options: {
        scope: WidgetPlacementScope;
        scopeId?: string | null;
        anchorIds?: string[];
    },
) {
    const placementConditions = [
        eq(widgets.isActive, true),
        eq(widgetPlacements.scope, options.scope),
        eq(widgetPlacements.isActive, true),
        isNull(widgets.deletedAt),
        isNull(widgetPlacements.deletedAt),
    ];

    if (options.scope !== WidgetPlacementScope.HOMEPAGE) {
        placementConditions.push(eq(widgetPlacements.scopeId, options.scopeId ?? ""));
    }

    if (options.anchorIds && options.anchorIds.length > 0) {
        placementConditions.push(inArray(widgetPlacements.anchorId, options.anchorIds));
    }

    const result = await db
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
            createdAt: widgets.createdAt,
            updatedAt: widgets.updatedAt,
            deletedAt: widgets.deletedAt,
            placement: widgetPlacements,
        })
        .from(widgetPlacements)
        .innerJoin(widgets, eq(widgetPlacements.widgetId, widgets.id))
        .where(and(...placementConditions));

    return sortPlacementRows(result).map((w) => ({
        ...w,
        htmlContent: w.htmlContent ? sanitizeWidgetHtml(w.htmlContent) : w.htmlContent,
        cssContent: w.cssContent ? sanitizeWidgetCss(w.cssContent) : w.cssContent,
        ...legacyFieldsFromPlacement(w.placement),
        placements: [w.placement],
    }));
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createWidget(db: Database, data: CreateWidgetInput) {
    const widgetId = "wid_" + nanoid();
    const requestedPlacements = data.placements ?? placementFromLegacyFields(data);
    const legacyFields = legacyFieldsFromPlacement(requestedPlacements[0]);

    const batchOps: unknown[] = [
        db.insert(widgets).values({
            id: widgetId,
            name: data.name,
            htmlContent: sanitizeWidgetHtml(data.htmlContent),
            cssContent: data.cssContent ? sanitizeWidgetCss(data.cssContent) : data.cssContent,
            isActive: data.isActive,
            displayTarget: legacyFields.displayTarget,
            placementRule: legacyFields.placementRule,
            referenceCollectionId: legacyFields.referenceCollectionId,
            sortOrder: legacyFields.sortOrder,
            aiContext: data.aiContext ? JSON.stringify(data.aiContext) : null,
        }),
    ];

    const placementInserts = normalizePlacementInserts(widgetId, requestedPlacements);
    if (placementInserts.length > 0) {
        batchOps.push(db.insert(widgetPlacements).values(placementInserts));
    }

    await db.batch(batchOps as any);
    const created = await getWidgetById(db, widgetId);
    if (!created) throw new NotFoundError("Widget not found after create");
    return created;
}

export async function updateWidget(db: Database, id: string, data: UpdateWidgetInput) {
    const existing = await getWidgetById(db, id);
    if (!existing) throw new NotFoundError("Widget not found");

    const updateData: Record<string, unknown> = { updatedAt: sql`unixepoch()` };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.htmlContent !== undefined) updateData.htmlContent = sanitizeWidgetHtml(data.htmlContent);
    if (data.cssContent !== undefined) updateData.cssContent = data.cssContent ? sanitizeWidgetCss(data.cssContent) : data.cssContent;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.aiContext !== undefined) updateData.aiContext = data.aiContext ? JSON.stringify(data.aiContext) : null;

    const shouldReplacePlacements =
        data.placements !== undefined ||
        data.placementRule !== undefined ||
        data.referenceCollectionId !== undefined ||
        data.sortOrder !== undefined;

    let requestedPlacements: WidgetPlacementInput[] | undefined;
    if (data.placements !== undefined) {
        requestedPlacements = data.placements;
    } else if (shouldReplacePlacements) {
        requestedPlacements = placementFromLegacyFields({
            placementRule: data.placementRule ?? existing.placementRule,
            referenceCollectionId:
                data.referenceCollectionId !== undefined
                    ? data.referenceCollectionId
                    : existing.referenceCollectionId,
            sortOrder: data.sortOrder ?? existing.sortOrder,
        });
    }

    if (requestedPlacements !== undefined) {
        const legacyFields = legacyFieldsFromPlacement(requestedPlacements[0]);
        updateData.displayTarget = legacyFields.displayTarget;
        updateData.placementRule = legacyFields.placementRule;
        updateData.referenceCollectionId = legacyFields.referenceCollectionId;
        updateData.sortOrder = legacyFields.sortOrder;
    }

    const batchOps: unknown[] = [
        db.update(widgets).set(updateData).where(eq(widgets.id, id)),
    ];

    if (requestedPlacements !== undefined) {
        batchOps.push(
            db.update(widgetPlacements)
                .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(and(eq(widgetPlacements.widgetId, id), isNull(widgetPlacements.deletedAt))),
        );
        const placementInserts = normalizePlacementInserts(id, requestedPlacements);
        if (placementInserts.length > 0) {
            batchOps.push(db.insert(widgetPlacements).values(placementInserts));
        }
    }

    await db.batch(batchOps as any);
    const updated = await getWidgetById(db, id);
    if (!updated) throw new NotFoundError("Widget not found after update");
    return updated;
}

export async function deleteWidget(db: Database, id: string): Promise<void> {
    const existing = await getWidgetById(db, id);
    if (!existing) throw new NotFoundError("Widget not found");

    await db.batch([
        db
            .update(widgets)
            .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(eq(widgets.id, id)),
        db
            .update(widgetPlacements)
            .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(and(eq(widgetPlacements.widgetId, id), isNull(widgetPlacements.deletedAt))),
    ] as any);
}

export async function bulkDeleteWidgets(db: Database, ids: string[], permanent = false): Promise<void> {
    if (ids.length === 0) return;
    if (permanent) {
        await db.delete(widgets).where(inArray(widgets.id, ids));
    } else {
        await db.batch([
            db
                .update(widgets)
                .set({ deletedAt: sql`unixepoch()` })
                .where(inArray(widgets.id, ids)),
            db
                .update(widgetPlacements)
                .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(and(inArray(widgetPlacements.widgetId, ids), isNull(widgetPlacements.deletedAt))),
        ] as any);
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
    await db.batch([
        db.update(widgets).set({ deletedAt: null, updatedAt: sql`unixepoch()` }).where(inArray(widgets.id, ids)),
        db.update(widgetPlacements).set({ deletedAt: null, updatedAt: sql`unixepoch()` }).where(inArray(widgetPlacements.widgetId, ids)),
    ] as any);
}

// ─────────────────────────────────────────
// History
// ─────────────────────────────────────────

export async function createHistoryEntry(
    db: Database,
    widgetId: string,
    reason: string = "Manual save",
    snapshot?: { htmlContent?: string; cssContent?: string | null },
): Promise<WidgetHistory> {
    const widget = await getWidgetById(db, widgetId);
    if (!widget) throw new NotFoundError("Widget not found");

    const htmlContent =
        snapshot?.htmlContent !== undefined
            ? sanitizeWidgetHtml(snapshot.htmlContent)
            : widget.htmlContent;
    const cssContent =
        snapshot?.cssContent !== undefined
            ? snapshot.cssContent
                ? sanitizeWidgetCss(snapshot.cssContent)
                : snapshot.cssContent
            : widget.cssContent;

    return db
        .insert(widgetHistory)
        .values({
            id: "whist_" + nanoid(),
            widgetId,
            htmlContent,
            cssContent,
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
