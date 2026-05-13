// src/modules/widgets/widgets.service.ts
// All DB queries and business logic for the widgets domain.

import {
    widgets,
    widgetPlacements,
    widgetHistory,
    collections,
    categories,
    pages,
    products,
    WidgetPlacementAnchorType,
    WidgetPlacementRule,
    WidgetPlacementScope,
    WidgetPlacementSlot,
} from "@scalius/database/schema";
import type { WidgetHistory, WidgetPlacement } from "@scalius/database/schema";
import { isNull, asc, and, sql, inArray, eq, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import {
    createWidgetSchema,
    updateWidgetSchema,
    type CreateWidgetInput,
    type UpdateWidgetInput,
    type WidgetPlacementInput,
} from "./widgets.validation";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { sanitizeCssForStyleElement } from "@scalius/shared/css-sanitize";
import { normalizeWidgetParts } from "@scalius/shared/widget-rendering";
import { findDuplicateWidgetPlacementIndexes } from "@scalius/shared/widget-placement";

export { createWidgetSchema, updateWidgetSchema, type CreateWidgetInput, type UpdateWidgetInput };

type WidgetPlacementInsert = typeof widgetPlacements.$inferInsert;
export type WidgetPlacementTargetType = "page" | "product" | "category" | "collection";

export type WidgetPlacementTargetOption = {
    id: string;
    label: string;
    description: string | null;
    type: WidgetPlacementTargetType;
};

type LegacyPlacementFields = {
    displayTarget: "homepage";
    placementRule: WidgetPlacementRule;
    referenceCollectionId: string | null;
    sortOrder: number;
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

type PublicWidgetBase = Pick<
    typeof widgets.$inferSelect,
    | "id"
    | "name"
    | "htmlContent"
    | "cssContent"
    | "isActive"
    | "displayTarget"
    | "placementRule"
    | "referenceCollectionId"
    | "sortOrder"
    | "createdAt"
    | "updatedAt"
    | "deletedAt"
>;

type PublicWidgetPlacement = Pick<
    WidgetPlacement,
    | "id"
    | "widgetId"
    | "scope"
    | "scopeId"
    | "slot"
    | "anchorType"
    | "anchorId"
    | "sortOrder"
    | "isActive"
    | "createdAt"
    | "updatedAt"
    | "deletedAt"
>;

export type PublicWidget = PublicWidgetBase & {
    placements: PublicWidgetPlacement[];
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

function normalizePersistentWidgetContent(input: {
    htmlContent: string;
    cssContent?: string | null;
}): { htmlContent: string; cssContent?: string | null } {
    const normalized = normalizeWidgetParts(input);
    return {
        htmlContent: sanitizeWidgetHtml(normalized.html),
        cssContent: normalized.css ? sanitizeWidgetCss(normalized.css) : normalized.css || input.cssContent,
    };
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

function assertUniquePlacements(placements: WidgetPlacementInput[]): void {
    const [duplicate] = findDuplicateWidgetPlacementIndexes(placements);
    if (duplicate) {
        throw new ValidationError(
            `Duplicate widget placement target at positions ${duplicate.firstIndex + 1} and ${duplicate.duplicateIndex + 1}.`,
        );
    }
}

function hasRenderableWidgetContent(htmlContent: string | null | undefined): boolean {
    return typeof htmlContent === "string" && htmlContent.trim().length > 0;
}

function assertPublishableWidgetState(state: { htmlContent?: string | null }): void {
    if (!hasRenderableWidgetContent(state.htmlContent)) {
        throw new ValidationError("HTML content is required before publishing a widget.");
    }
}

async function validatePlacementReferences(
    db: Database,
    placements: WidgetPlacementInput[],
    options: { checkDuplicates?: boolean } = {},
): Promise<void> {
    if (options.checkDuplicates ?? true) {
        assertUniquePlacements(placements);
    }

    const pageIds = new Set<string>();
    const productIds = new Set<string>();
    const categoryIds = new Set<string>();
    const collectionIds = new Set<string>();

    for (const placement of placements) {
        if (placement.scope === WidgetPlacementScope.HOMEPAGE && placement.scopeId) {
            throw new ValidationError("Homepage widget placements must not include a page scope.");
        }

        if (placement.scope !== WidgetPlacementScope.HOMEPAGE && !placement.scopeId) {
            throw new ValidationError("Scoped widget placements require a target record.");
        }

        if (placement.scope === WidgetPlacementScope.PAGE) {
            if (!placement.scopeId) {
                throw new ValidationError("Page widget placements require a page.");
            }
            pageIds.add(placement.scopeId);
        }

        if (placement.scope === WidgetPlacementScope.PRODUCT && placement.scopeId) {
            productIds.add(placement.scopeId);
        }

        if (placement.scope === WidgetPlacementScope.CATEGORY && placement.scopeId) {
            categoryIds.add(placement.scopeId);
        }

        if (placement.scope === WidgetPlacementScope.COLLECTION && placement.scopeId) {
            collectionIds.add(placement.scopeId);
        }

        const isCollectionSlot =
            placement.slot === WidgetPlacementSlot.BEFORE_COLLECTION ||
            placement.slot === WidgetPlacementSlot.AFTER_COLLECTION;

        if (isCollectionSlot) {
            if (placement.anchorType !== WidgetPlacementAnchorType.COLLECTION || !placement.anchorId) {
                throw new ValidationError("Collection widget placements require a collection anchor.");
            }
            collectionIds.add(placement.anchorId);
        } else if (placement.anchorType != null || placement.anchorId != null) {
            throw new ValidationError("Only collection widget placements may include anchor fields.");
        }
    }

    if (pageIds.size > 0) {
        const ids = [...pageIds];
        const livePages = await db
            .select({ id: pages.id })
            .from(pages)
            .where(and(
                inArray(pages.id, ids),
                eq(pages.isPublished, true),
                isNull(pages.deletedAt),
            ));
        const found = new Set((livePages as Array<{ id: string }>).map((page) => page.id));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length > 0) {
            throw new ValidationError(
                `Widget placement references missing or unpublished pages: ${missing.join(", ")}.`,
            );
        }
    }

    if (productIds.size > 0) {
        const ids = [...productIds];
        const activeProducts = await db
            .select({ id: products.id })
            .from(products)
            .where(and(
                inArray(products.id, ids),
                eq(products.isActive, true),
                isNull(products.deletedAt),
            ));
        const found = new Set((activeProducts as Array<{ id: string }>).map((product) => product.id));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length > 0) {
            throw new ValidationError(
                `Widget placement references missing or inactive products: ${missing.join(", ")}.`,
            );
        }
    }

    if (categoryIds.size > 0) {
        const ids = [...categoryIds];
        const liveCategories = await db
            .select({ id: categories.id })
            .from(categories)
            .where(and(
                inArray(categories.id, ids),
                isNull(categories.deletedAt),
            ));
        const found = new Set((liveCategories as Array<{ id: string }>).map((category) => category.id));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length > 0) {
            throw new ValidationError(
                `Widget placement references missing categories: ${missing.join(", ")}.`,
            );
        }
    }

    if (collectionIds.size > 0) {
        const ids = [...collectionIds];
        const activeCollections = await db
            .select({ id: collections.id })
            .from(collections)
            .where(and(
                inArray(collections.id, ids),
                eq(collections.isActive, true),
                isNull(collections.deletedAt),
            ));
        const found = new Set((activeCollections as Array<{ id: string }>).map((collection) => collection.id));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length > 0) {
            throw new ValidationError(
                `Widget placement references missing or inactive collections: ${missing.join(", ")}.`,
            );
        }
    }
}

function toActivePlacementInputs(placements: WidgetPlacement[]): WidgetPlacementInput[] {
    return placements
        .filter((placement) => placement.isActive && placement.deletedAt == null)
        .map((placement) => ({
            id: placement.id,
            scope: placement.scope,
            scopeId: placement.scopeId,
            slot: placement.slot,
            anchorType: placement.anchorType,
            anchorId: placement.anchorId,
            sortOrder: placement.sortOrder,
            isActive: placement.isActive,
        }));
}

async function validateWidgetActivationBatch(db: Database, ids: string[]): Promise<void> {
    const requestedIds = [...new Set(ids)];
    if (requestedIds.length === 0) return;

    const widgetRows = await db
        .select({ id: widgets.id, name: widgets.name, htmlContent: widgets.htmlContent })
        .from(widgets)
        .where(and(inArray(widgets.id, requestedIds), isNull(widgets.deletedAt)));

    const widgetsById = new Map(
        (widgetRows as Array<{ id: string; name: string; htmlContent: string | null }>).map((widget) => [widget.id, widget]),
    );
    const missingIds = requestedIds.filter((id) => !widgetsById.has(id));
    if (missingIds.length > 0) {
        throw new ValidationError(`Cannot activate missing widgets: ${missingIds.join(", ")}.`);
    }

    for (const id of requestedIds) {
        const widget = widgetsById.get(id);
        if (!widget) continue;
        try {
            assertPublishableWidgetState({
                htmlContent: widget.htmlContent,
            });
        } catch (error) {
            if (error instanceof ValidationError) {
                throw new ValidationError(`Widget "${widget.name}" cannot be activated: ${error.message}`);
            }
            throw error;
        }
    }

    const activePlacements = await db
        .select()
        .from(widgetPlacements)
        .where(and(
            inArray(widgetPlacements.widgetId, requestedIds),
            eq(widgetPlacements.isActive, true),
            isNull(widgetPlacements.deletedAt),
        ));
    const placementsByWidget = groupPlacementsByWidget(activePlacements as WidgetPlacement[]);
    const placementInputs: WidgetPlacementInput[] = [];
    for (const id of requestedIds) {
        const activeWidgetPlacements = toActivePlacementInputs(placementsByWidget.get(id) ?? []);
        assertUniquePlacements(activeWidgetPlacements);
        placementInputs.push(...activeWidgetPlacements);
    }
    await validatePlacementReferences(db, placementInputs, { checkDuplicates: false });
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

function toPublicPlacement(placement: PublicWidgetPlacement): PublicWidgetPlacement {
    return {
        id: placement.id,
        widgetId: placement.widgetId,
        scope: placement.scope,
        scopeId: placement.scopeId,
        slot: placement.slot,
        anchorType: placement.anchorType,
        anchorId: placement.anchorId,
        sortOrder: placement.sortOrder,
        isActive: placement.isActive,
        createdAt: placement.createdAt,
        updatedAt: placement.updatedAt,
        deletedAt: placement.deletedAt,
    };
}

function legacyFieldsForPublicWidget(
    widget: PublicWidgetBase,
    placements: PublicWidgetPlacement[],
): LegacyPlacementFields {
    const primaryPlacement = placements[0];
    if (primaryPlacement) return legacyFieldsFromPlacement(primaryPlacement);

    return {
        displayTarget: "homepage",
        placementRule: widget.placementRule,
        referenceCollectionId: widget.referenceCollectionId ?? null,
        sortOrder: widget.sortOrder,
    };
}

function toPublicWidget(
    widget: PublicWidgetBase,
    placements: PublicWidgetPlacement[] = [],
): PublicWidget {
    const publicPlacements = placements.map(toPublicPlacement);
    const legacyFields = legacyFieldsForPublicWidget(widget, publicPlacements);

    return {
        id: widget.id,
        name: widget.name,
        htmlContent: widget.htmlContent ? sanitizeWidgetHtml(widget.htmlContent) : widget.htmlContent,
        cssContent: widget.cssContent ? sanitizeWidgetCss(widget.cssContent) : widget.cssContent,
        isActive: widget.isActive,
        displayTarget: legacyFields.displayTarget,
        placementRule: legacyFields.placementRule,
        referenceCollectionId: legacyFields.referenceCollectionId,
        sortOrder: legacyFields.sortOrder,
        createdAt: widget.createdAt,
        updatedAt: widget.updatedAt,
        deletedAt: widget.deletedAt,
        placements: publicPlacements,
    };
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

function renderableWidgetPlacementCondition(): SQL {
    return sql`(
        (
            ${widgetPlacements.scope} = ${WidgetPlacementScope.HOMEPAGE}
            OR (
                ${widgetPlacements.scope} = ${WidgetPlacementScope.PAGE}
                AND EXISTS (
                    SELECT 1 FROM ${pages}
                    WHERE ${pages.id} = ${widgetPlacements.scopeId}
                    AND ${pages.isPublished} = true
                    AND ${pages.deletedAt} IS NULL
                )
            )
            OR (
                ${widgetPlacements.scope} = ${WidgetPlacementScope.PRODUCT}
                AND EXISTS (
                    SELECT 1 FROM ${products}
                    WHERE ${products.id} = ${widgetPlacements.scopeId}
                    AND ${products.isActive} = true
                    AND ${products.deletedAt} IS NULL
                )
            )
            OR (
                ${widgetPlacements.scope} = ${WidgetPlacementScope.CATEGORY}
                AND EXISTS (
                    SELECT 1 FROM ${categories}
                    WHERE ${categories.id} = ${widgetPlacements.scopeId}
                    AND ${categories.deletedAt} IS NULL
                )
            )
            OR (
                ${widgetPlacements.scope} = ${WidgetPlacementScope.COLLECTION}
                AND EXISTS (
                    SELECT 1 FROM ${collections}
                    WHERE ${collections.id} = ${widgetPlacements.scopeId}
                    AND ${collections.isActive} = true
                    AND ${collections.deletedAt} IS NULL
                )
            )
        )
        AND (
            ${widgetPlacements.anchorId} IS NULL
            OR (
                ${widgetPlacements.anchorType} = ${WidgetPlacementAnchorType.COLLECTION}
                AND EXISTS (
                    SELECT 1 FROM ${collections}
                    WHERE ${collections.id} = ${widgetPlacements.anchorId}
                    AND ${collections.isActive} = true
                    AND ${collections.deletedAt} IS NULL
                )
            )
        )
    )`;
}

function normalizedSearchPattern(search?: string | null): string | null {
    const normalized = search?.trim().toLowerCase();
    if (!normalized) return null;
    const escaped = normalized.replace(/[\\%_]/g, (match) => `\\${match}`);
    return `%${escaped}%`;
}

function mergeTargetOptions(
    selected: WidgetPlacementTargetOption[],
    searched: WidgetPlacementTargetOption[],
): WidgetPlacementTargetOption[] {
    const seen = new Set<string>();
    const merged: WidgetPlacementTargetOption[] = [];
    for (const option of [...selected, ...searched]) {
        if (seen.has(option.id)) continue;
        seen.add(option.id);
        merged.push(option);
    }
    return merged;
}

async function getReferencedPlacementTargets(
    db: Database,
    placements: WidgetPlacement[],
) {
    const productIds = new Set<string>();
    const categoryIds = new Set<string>();

    for (const placement of placements) {
        if (placement.deletedAt != null) continue;
        if (placement.scope === WidgetPlacementScope.PRODUCT && placement.scopeId) {
            productIds.add(placement.scopeId);
        }
        if (placement.scope === WidgetPlacementScope.CATEGORY && placement.scopeId) {
            categoryIds.add(placement.scopeId);
        }
    }

    const [referencedProducts, referencedCategories] = await Promise.all([
        productIds.size === 0
            ? Promise.resolve([])
            : db
                .select({ id: products.id, name: products.name, slug: products.slug })
                .from(products)
                .where(and(inArray(products.id, [...productIds]), isNull(products.deletedAt))),
        categoryIds.size === 0
            ? Promise.resolve([])
            : db
                .select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(inArray(categories.id, [...categoryIds]), isNull(categories.deletedAt))),
    ]);

    return { referencedProducts, referencedCategories };
}

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listWidgets(db: Database, options?: { showTrashed?: boolean }) {
    const { showTrashed = false } = options ?? {};
    const [
        allWidgets,
        allPlacements,
        availableCollections,
        availablePages,
    ] = await Promise.all([
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
            .where(and(isNull(pages.deletedAt), eq(pages.isPublished, true)))
            .orderBy(asc(pages.sortOrder), asc(pages.title)),
    ]);

    const placementsByWidget = groupPlacementsByWidget(allPlacements as WidgetPlacement[]);
    const { referencedProducts, referencedCategories } = await getReferencedPlacementTargets(
        db,
        allPlacements as WidgetPlacement[],
    );

    return {
        widgets: allWidgets.map((widget) => ({
            ...widget,
            placements: placementsByWidget.get(widget.id) ?? [],
        })),
        availableCollections,
        availablePages,
        referencedProducts,
        referencedCategories,
    };
}

export async function listWidgetPlacementTargets(
    db: Database,
    options: {
        targetType: WidgetPlacementTargetType;
        search?: string | null;
        selectedIds?: string[];
        limit?: number;
    },
): Promise<WidgetPlacementTargetOption[]> {
    const { targetType, search, selectedIds = [], limit: rawLimit = 20 } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 50);
    const searchPattern = normalizedSearchPattern(search);
    const uniqueSelectedIds = [...new Set(selectedIds.filter(Boolean))].slice(0, 20);

    if (targetType === "page") {
        const selected = uniqueSelectedIds.length === 0
            ? []
            : await db
                .select({ id: pages.id, label: pages.title, description: pages.slug })
                .from(pages)
                .where(and(
                    inArray(pages.id, uniqueSelectedIds),
                    eq(pages.isPublished, true),
                    isNull(pages.deletedAt),
                ));
        const searchConditions: SQL[] = [
            eq(pages.isPublished, true),
            isNull(pages.deletedAt),
        ];
        if (searchPattern) {
            searchConditions.push(sql`(lower(${pages.title}) LIKE ${searchPattern} ESCAPE '\\' OR lower(${pages.slug}) LIKE ${searchPattern} ESCAPE '\\')`);
        }
        const searched = await db
            .select({ id: pages.id, label: pages.title, description: pages.slug })
            .from(pages)
            .where(and(...searchConditions))
            .orderBy(asc(pages.sortOrder), asc(pages.title))
            .limit(limit);
        return mergeTargetOptions(
            selected.map((item) => ({ ...item, type: "page" as const })),
            searched.map((item) => ({ ...item, type: "page" as const })),
        );
    }

    if (targetType === "product") {
        const selected = uniqueSelectedIds.length === 0
            ? []
            : await db
                .select({ id: products.id, label: products.name, description: products.slug })
                .from(products)
                .where(and(
                    inArray(products.id, uniqueSelectedIds),
                    eq(products.isActive, true),
                    isNull(products.deletedAt),
                ));
        const searchConditions: SQL[] = [
            eq(products.isActive, true),
            isNull(products.deletedAt),
        ];
        if (searchPattern) {
            searchConditions.push(sql`(lower(${products.name}) LIKE ${searchPattern} ESCAPE '\\' OR lower(${products.slug}) LIKE ${searchPattern} ESCAPE '\\')`);
        }
        const searched = await db
            .select({ id: products.id, label: products.name, description: products.slug })
            .from(products)
            .where(and(...searchConditions))
            .orderBy(asc(products.name), asc(products.slug))
            .limit(limit);
        return mergeTargetOptions(
            selected.map((item) => ({ ...item, type: "product" as const })),
            searched.map((item) => ({ ...item, type: "product" as const })),
        );
    }

    if (targetType === "category") {
        const selected = uniqueSelectedIds.length === 0
            ? []
            : await db
                .select({ id: categories.id, label: categories.name, description: categories.slug })
                .from(categories)
                .where(and(inArray(categories.id, uniqueSelectedIds), isNull(categories.deletedAt)));
        const searchConditions: SQL[] = [isNull(categories.deletedAt)];
        if (searchPattern) {
            searchConditions.push(sql`(lower(${categories.name}) LIKE ${searchPattern} ESCAPE '\\' OR lower(${categories.slug}) LIKE ${searchPattern} ESCAPE '\\')`);
        }
        const searched = await db
            .select({ id: categories.id, label: categories.name, description: categories.slug })
            .from(categories)
            .where(and(...searchConditions))
            .orderBy(asc(categories.name), asc(categories.slug))
            .limit(limit);
        return mergeTargetOptions(
            selected.map((item) => ({ ...item, type: "category" as const })),
            searched.map((item) => ({ ...item, type: "category" as const })),
        );
    }

    const selected = uniqueSelectedIds.length === 0
        ? []
        : await db
            .select({ id: collections.id, label: collections.name, description: collections.type })
            .from(collections)
            .where(and(
                inArray(collections.id, uniqueSelectedIds),
                eq(collections.isActive, true),
                isNull(collections.deletedAt),
            ));
    const searchConditions: SQL[] = [
        eq(collections.isActive, true),
        isNull(collections.deletedAt),
    ];
    if (searchPattern) {
        searchConditions.push(sql`lower(${collections.name}) LIKE ${searchPattern} ESCAPE '\\'`);
    }
    const searched = await db
        .select({ id: collections.id, label: collections.name, description: collections.type })
        .from(collections)
        .where(and(...searchConditions))
        .orderBy(asc(collections.sortOrder), asc(collections.name))
        .limit(limit);
    return mergeTargetOptions(
        selected.map((item) => ({ ...item, type: "collection" as const })),
        searched.map((item) => ({ ...item, type: "collection" as const })),
    );
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
        .select({
            id: widgets.id,
            name: widgets.name,
            htmlContent: widgets.htmlContent,
            cssContent: widgets.cssContent,
            isActive: widgets.isActive,
            displayTarget: widgets.displayTarget,
            placementRule: widgets.placementRule,
            referenceCollectionId: widgets.referenceCollectionId,
            sortOrder: widgets.sortOrder,
            createdAt: widgets.createdAt,
            updatedAt: widgets.updatedAt,
            deletedAt: widgets.deletedAt,
        })
        .from(widgets)
        .where(and(eq(widgets.id, id), eq(widgets.isActive, true), isNull(widgets.deletedAt)))
        .get() ?? null;

    if (widget) {
        const placements = await db
            .select({
                id: widgetPlacements.id,
                widgetId: widgetPlacements.widgetId,
                scope: widgetPlacements.scope,
                scopeId: widgetPlacements.scopeId,
                slot: widgetPlacements.slot,
                anchorType: widgetPlacements.anchorType,
                anchorId: widgetPlacements.anchorId,
                sortOrder: widgetPlacements.sortOrder,
                isActive: widgetPlacements.isActive,
                createdAt: widgetPlacements.createdAt,
                updatedAt: widgetPlacements.updatedAt,
                deletedAt: widgetPlacements.deletedAt,
            })
            .from(widgetPlacements)
            .where(and(
                eq(widgetPlacements.widgetId, id),
                eq(widgetPlacements.isActive, true),
                isNull(widgetPlacements.deletedAt),
                renderableWidgetPlacementCondition(),
            ))
            .orderBy(asc(widgetPlacements.sortOrder));
        return toPublicWidget(widget, placements);
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
        renderableWidgetPlacementCondition(),
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

    return sortPlacementRows(result).map(({ placement, ...widget }) =>
        toPublicWidget(widget, [placement]),
    );
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createWidget(db: Database, data: CreateWidgetInput) {
    const widgetId = "wid_" + nanoid();
    const requestedPlacements = data.placements ?? placementFromLegacyFields(data);
    const content = normalizePersistentWidgetContent({
        htmlContent: data.htmlContent,
        cssContent: data.cssContent,
    });
    await validatePlacementReferences(db, requestedPlacements);
    if (data.isActive) {
        assertPublishableWidgetState({
            htmlContent: content.htmlContent,
        });
    }
    const legacyFields = legacyFieldsFromPlacement(requestedPlacements[0]);

    const batchOps: unknown[] = [
        db.insert(widgets).values({
            id: widgetId,
            name: data.name,
            htmlContent: content.htmlContent,
            cssContent: content.cssContent,
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
    if (data.placements === undefined && hasLegacyPlacementProjection(data)) {
        throw new ValidationError("Use canonical placements to change widget placement.");
    }

    const updateData: Record<string, unknown> = { updatedAt: sql`unixepoch()` };
    if (data.name !== undefined) updateData.name = data.name;
    const content =
        data.htmlContent !== undefined || data.cssContent !== undefined
            ? normalizePersistentWidgetContent({
                htmlContent: data.htmlContent ?? existing.htmlContent,
                cssContent: data.cssContent !== undefined ? data.cssContent : existing.cssContent,
            })
            : null;
    if (content) {
        updateData.htmlContent = content.htmlContent;
        if (data.cssContent !== undefined || data.htmlContent !== undefined) {
            updateData.cssContent = content.cssContent;
        }
    }
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.aiContext !== undefined) updateData.aiContext = data.aiContext ? JSON.stringify(data.aiContext) : null;

    const requestedPlacements = data.placements;

    if (requestedPlacements !== undefined) {
        await validatePlacementReferences(db, requestedPlacements);
        const legacyFields = legacyFieldsFromPlacement(requestedPlacements[0]);
        updateData.displayTarget = legacyFields.displayTarget;
        updateData.placementRule = legacyFields.placementRule;
        updateData.referenceCollectionId = legacyFields.referenceCollectionId;
        updateData.sortOrder = legacyFields.sortOrder;
    }

    const nextIsActive = data.isActive ?? existing.isActive;
    if (nextIsActive) {
        assertPublishableWidgetState({
            htmlContent: content?.htmlContent ?? existing.htmlContent,
        });
        if (requestedPlacements === undefined) {
            await validatePlacementReferences(db, toActivePlacementInputs(existing.placements as WidgetPlacement[]));
        }
    }

    const batchOps: unknown[] = [
        db.update(widgets).set(updateData).where(eq(widgets.id, id)),
    ];

    if (requestedPlacements !== undefined) {
        batchOps.push(
            db.delete(widgetPlacements)
                .where(eq(widgetPlacements.widgetId, id)),
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

    const deletedAt = new Date();
    await db.batch([
        db
            .update(widgets)
            .set({ deletedAt, updatedAt: deletedAt })
            .where(eq(widgets.id, id)),
        db
            .update(widgetPlacements)
            .set({ deletedAt, updatedAt: deletedAt })
            .where(and(eq(widgetPlacements.widgetId, id), isNull(widgetPlacements.deletedAt))),
    ] as any);
}

export async function bulkDeleteWidgets(db: Database, ids: string[], permanent = false): Promise<void> {
    if (ids.length === 0) return;
    if (permanent) {
        await db.delete(widgets).where(inArray(widgets.id, ids));
    } else {
        const deletedAt = new Date();
        await db.batch([
            db
                .update(widgets)
                .set({ deletedAt, updatedAt: deletedAt })
                .where(inArray(widgets.id, ids)),
            db
                .update(widgetPlacements)
                .set({ deletedAt, updatedAt: deletedAt })
                .where(and(inArray(widgetPlacements.widgetId, ids), isNull(widgetPlacements.deletedAt))),
        ] as any);
    }
}

export async function bulkActivateWidgets(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await validateWidgetActivationBatch(db, ids);
    await db.update(widgets).set({ isActive: true }).where(inArray(widgets.id, ids));
}

export async function bulkDeactivateWidgets(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.update(widgets).set({ isActive: false }).where(inArray(widgets.id, ids));
}

export async function restoreWidgets(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.batch([
        db
            .update(widgetPlacements)
            .set({ deletedAt: null, updatedAt: sql`unixepoch()` })
            .where(and(
                inArray(widgetPlacements.widgetId, ids),
                sql`${widgetPlacements.deletedAt} = (
                    select ${widgets.deletedAt}
                    from ${widgets}
                    where ${widgets.id} = ${widgetPlacements.widgetId}
                )`,
            )),
        db.update(widgets).set({ deletedAt: null, updatedAt: sql`unixepoch()` }).where(inArray(widgets.id, ids)),
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
            ? normalizePersistentWidgetContent({
                htmlContent: snapshot.htmlContent,
                cssContent: snapshot.cssContent,
            }).htmlContent
            : widget.htmlContent;
    const cssContent =
        snapshot?.htmlContent !== undefined || snapshot?.cssContent !== undefined
            ? normalizePersistentWidgetContent({
                htmlContent: snapshot?.htmlContent ?? widget.htmlContent,
                cssContent: snapshot?.cssContent !== undefined ? snapshot.cssContent : widget.cssContent,
            }).cssContent
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
