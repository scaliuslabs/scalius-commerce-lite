// src/modules/attributes/category-attribute-sets.ts
// The specs a category uses, in order. A category inherits the sets of all
// its ancestors (category_closure, self included); its effective set is the
// union. Ordering rule (the storefront facet reader uses the same one):
// root-most first, i.e. order key = (3 - closure.depth) * 100000 + sort_order,
// the minimum key per attribute wins, ties by attribute name.
import {
    categories,
    categoryAttributeSets,
    categoryClosure,
    productAttributes,
} from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";

import { jsonIdSet } from "./projection-refresh";
import { MAX_ATTRIBUTE_REQUEST_IDS } from "./attributes.validation";

/** The key that orders an ancestor's set row (see the file comment). */
export function categoryAttributeSetOrderKey(closureDepth: number, sortOrder: number): number {
    return (3 - closureDepth) * 100_000 + sortOrder;
}

export interface CategoryAttributeSetEntry {
    attributeId: string;
    name: string;
    slug: string;
    valueType: "text" | "number" | "boolean" | "enum";
    unit: string | null;
    facetDisplay: "checkbox" | "range" | "swatch" | "search_list";
    filterable: boolean;
    keySpec: boolean;
    highlight: boolean;
    groupId: string | null;
    sortOrder: number;
    orderKey: number;
    /** The ancestor whose set row this is; null when it is the category's own. */
    inheritedFromCategoryId: string | null;
}

async function assertCategoryExists(db: Database, categoryId: string, live: boolean): Promise<void> {
    const category = await db
        .select({ id: categories.id, deletedAt: categories.deletedAt })
        .from(categories)
        .where(eq(categories.id, categoryId))
        .get();
    if (!category) throw new NotFoundError("Category not found");
    if (live && category.deletedAt !== null) {
        throw new ConflictError("Restore the category before changing its attributes.");
    }
}

/** The category's effective attribute set (own rows plus every ancestor's), live attributes only. */
export async function getCategoryAttributeSet(db: Database, categoryId: string) {
    await assertCategoryExists(db, categoryId, false);
    const orderKey = sql<number>`(3 - ${categoryClosure.depth}) * 100000 + ${categoryAttributeSets.sortOrder}`;
    const ranked = db
        .select({
            attributeId: categoryAttributeSets.attributeId,
            sourceCategoryId: sql<string>`${categoryAttributeSets.categoryId}`.as("source_category_id"),
            sortOrder: sql<number>`${categoryAttributeSets.sortOrder}`.as("set_sort_order"),
            orderKey: orderKey.as("order_key"),
            rank: sql<number>`ROW_NUMBER() OVER (
                PARTITION BY ${categoryAttributeSets.attributeId}
                ORDER BY ${orderKey}, ${categoryClosure.depth} DESC
            )`.as("set_rank"),
        })
        .from(categoryClosure)
        .innerJoin(categoryAttributeSets, eq(categoryAttributeSets.categoryId, categoryClosure.ancestorId))
        .where(eq(categoryClosure.descendantId, categoryId))
        .as("ranked_attribute_sets");
    const rows = await db
        .select({
            attributeId: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            valueType: productAttributes.valueType,
            unit: productAttributes.unit,
            facetDisplay: productAttributes.facetDisplay,
            filterable: productAttributes.filterable,
            keySpec: productAttributes.keySpec,
            highlight: productAttributes.highlight,
            groupId: productAttributes.groupId,
            sourceCategoryId: ranked.sourceCategoryId,
            sortOrder: ranked.sortOrder,
            orderKey: ranked.orderKey,
        })
        .from(ranked)
        .innerJoin(productAttributes, and(
            eq(productAttributes.id, ranked.attributeId),
            isNull(productAttributes.deletedAt),
        ))
        .where(sql`${ranked.rank} = 1`)
        .orderBy(sql`${ranked.orderKey}`, sql`lower(${productAttributes.name})`, productAttributes.id)
        .all();
    const attributes: CategoryAttributeSetEntry[] = rows.map(({ sourceCategoryId, ...row }) => ({
        ...row,
        sortOrder: Number(row.sortOrder),
        orderKey: Number(row.orderKey),
        inheritedFromCategoryId: sourceCategoryId === categoryId ? null : sourceCategoryId,
    }));
    return { categoryId, attributes };
}

/**
 * Replaces the category's OWN set (inherited rows are edited on their
 * ancestor). At most 90 live attributes; one batch, guarded against the
 * category or an attribute being trashed meanwhile.
 */
export async function replaceCategoryAttributeSet(
    db: Database,
    categoryId: string,
    items: ReadonlyArray<{ attributeId: string; sortOrder?: number }>,
) {
    if (items.length > MAX_ATTRIBUTE_REQUEST_IDS) {
        throw new ValidationError(`A category can list at most ${MAX_ATTRIBUTE_REQUEST_IDS} attributes.`);
    }
    const ids = [...new Set(items.map((item) => item.attributeId.trim()))];
    if (ids.length !== items.length) throw new ValidationError("Each attribute can be in a category's set only once.");
    await assertCategoryExists(db, categoryId, true);
    if (ids.length > 0) {
        const live = await db
            .select({ id: productAttributes.id })
            .from(productAttributes)
            .where(and(isNull(productAttributes.deletedAt), sql`${productAttributes.id} IN ${jsonIdSet(ids)}`))
            .all();
        if (live.length !== ids.length) {
            throw new ValidationError("One or more attributes are unavailable or in trash. Remove them and try again.", { field: "attributes" });
        }
    }
    const payload = JSON.stringify(items.map((item, index) => ({ a: item.attributeId.trim(), s: item.sortOrder ?? index })));
    try {
        await safeBatch(db, [
            buildBatchGuard(db, sql`
                EXISTS (SELECT 1 FROM ${categories} WHERE ${categories.id} = ${categoryId} AND ${categories.deletedAt} IS NULL)
                AND (SELECT count(*) FROM ${productAttributes}
                     WHERE ${productAttributes.deletedAt} IS NULL AND ${productAttributes.id} IN ${jsonIdSet(ids)}) = ${ids.length}
            `, "CATEGORY_ATTRIBUTE_SET_CONFLICT"),
            db.delete(categoryAttributeSets).where(eq(categoryAttributeSets.categoryId, categoryId)),
            ...(ids.length > 0
                ? [db.insert(categoryAttributeSets).select(sql`
                    SELECT ${categoryId},
                           CAST(json_extract(entry.value, '$.a') AS TEXT),
                           CAST(json_extract(entry.value, '$.s') AS INTEGER)
                    FROM json_each(${payload}) AS entry
                    WHERE 1 = 1
                `)]
                : []),
        ] as never);
    } catch (error) {
        if (isBatchGuardError(error, "CATEGORY_ATTRIBUTE_SET_CONFLICT")) {
            throw new ConflictError("The category or one of the attributes changed meanwhile. Refresh and try again.");
        }
        throw error;
    }
    return getCategoryAttributeSet(db, categoryId);
}
