// src/modules/attributes/attribute-values.ts
// An attribute's value vocabulary (`attribute_values`, `atv_` ids). Enum
// attributes pick only from these rows (`product_attribute_values.value_id`);
// for text attributes they are the merchant's presets. Number and yes/no
// attributes have none.
//
// Writes that change what products show (renaming an enum value, merging one
// into another, reordering enum values, which orders the facet) rewrite the
// referencing product rows 90 products per batch, each batch carrying the
// products' revision bump and the catalogue projection refresh.
import { attributeValues, productAttributeValues, products } from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { normalizeAttributeValue } from "@scalius/shared/catalog-attributes";

import {
    ATTRIBUTE_VALUE_UNIQUE_PATTERN,
    attributeValueInsertStatement,
    isUniqueViolation,
    readLiveAttributeDefinition,
    type LiveAttributeDefinition,
    type NewAttributeValueRow,
} from "./attribute-definition";
import {
    forEachAttributeProductChunk,
    jsonIdSet,
    productRevisionBumpStatement,
    type AttributeBatchItem,
    type CatalogProjectionRefresh,
} from "./projection-refresh";
import type {
    CreateAttributeValueRowInput,
    UpdateAttributeValueRowInput,
} from "./attributes.validation";

const VALUE_ROW_PAGE_LIMIT = 100;
/** Presets an attribute definition may carry through its `options` list. */
export const MAX_ATTRIBUTE_PRESET_ROWS = 5_000;

export function newAttributeValueId(): string {
    return `atv_${nanoid()}`;
}

function lowerSwatch(swatchHex: string | null | undefined): string | null | undefined {
    return swatchHex === undefined || swatchHex === null ? swatchHex : swatchHex.toLowerCase();
}

function assertHasVocabulary(attribute: LiveAttributeDefinition): void {
    if (attribute.valueType === "number" || attribute.valueType === "boolean") {
        throw new ValidationError("Number and yes/no attributes have no preset values.");
    }
}

async function readLiveValueRow(db: Database, attributeId: string, valueId: string) {
    const row = await db
        .select({
            id: attributeValues.id,
            value: attributeValues.value,
            normalizedValue: attributeValues.normalizedValue,
            sortOrder: attributeValues.sortOrder,
            swatchHex: attributeValues.swatchHex,
        })
        .from(attributeValues)
        .where(and(
            eq(attributeValues.id, valueId),
            eq(attributeValues.attributeId, attributeId),
            isNull(attributeValues.deletedAt),
        ))
        .get();
    if (!row) throw new NotFoundError("Attribute value not found");
    return row;
}

/** A live value of the attribute with the same normalised text, other than `excludeId`. */
async function findLiveValueByText(db: Database, attributeId: string, value: string, excludeId?: string) {
    return db
        .select({ id: attributeValues.id, value: attributeValues.value })
        .from(attributeValues)
        .where(and(
            eq(attributeValues.attributeId, attributeId),
            isNull(attributeValues.deletedAt),
            sql`${attributeValues.normalizedValue} = lower(trim(${value}))`,
            excludeId ? sql`${attributeValues.id} <> ${excludeId}` : undefined,
        ))
        .get();
}

/**
 * Rewrites the display text of the products whose rows name these enum values
 * to the values' current text, then refreshes their projections. With
 * `rewriteDisplay: false` (a reorder) only the projections are refreshed.
 */
export async function refreshProductsReferencingValues(
    db: Database,
    valueIds: readonly string[],
    refresh: CatalogProjectionRefresh,
    options: { rewriteDisplay: boolean },
): Promise<number> {
    if (valueIds.length === 0) return 0;
    const ids = [...new Set(valueIds)];
    const references = sql`${productAttributeValues.valueId} IN ${jsonIdSet(ids)}`;
    return forEachAttributeProductChunk(db, references, (productIds) => [
        ...(options.rewriteDisplay
            ? [
                db.update(productAttributeValues)
                    .set({
                        value: sql`(SELECT live_value.value FROM ${attributeValues} AS live_value WHERE live_value.id = ${productAttributeValues.valueId})`,
                    })
                    .where(and(
                        references,
                        sql`${productAttributeValues.productId} IN ${jsonIdSet(productIds)}`,
                        sql`${productAttributeValues.value} <> (SELECT live_value.value FROM ${attributeValues} AS live_value WHERE live_value.id = ${productAttributeValues.valueId})`,
                    )),
                productRevisionBumpStatement(db, productIds),
            ]
            : []),
        ...refresh(productIds),
    ]);
}

// ─────────────────────────────────────────
// Id-based vocabulary operations
// ─────────────────────────────────────────

export async function listAttributeValueRows(
    db: Database,
    attributeId: string,
    options: { search?: string; page?: number; limit?: number } = {},
) {
    const attribute = await readLiveAttributeDefinition(db, attributeId);
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const limit = Math.min(VALUE_ROW_PAGE_LIMIT, Math.max(1, Math.floor(options.limit ?? 50)));
    const search = options.search?.trim();
    const where = and(
        eq(attributeValues.attributeId, attributeId),
        isNull(attributeValues.deletedAt),
        search ? sql`${attributeValues.normalizedValue} LIKE '%' || lower(${search}) || '%'` : undefined,
    );
    const totalRow = await db.select({ total: count() }).from(attributeValues).where(where).get();
    const total = Number(totalRow?.total ?? 0);
    const rows = await db
        .select({
            id: attributeValues.id,
            value: attributeValues.value,
            normalizedValue: attributeValues.normalizedValue,
            sortOrder: attributeValues.sortOrder,
            swatchHex: attributeValues.swatchHex,
            createdAt: attributeValues.createdAt,
            updatedAt: attributeValues.updatedAt,
        })
        .from(attributeValues)
        .where(where)
        .orderBy(asc(attributeValues.sortOrder), asc(attributeValues.normalizedValue), asc(attributeValues.id))
        .limit(limit)
        .offset((page - 1) * limit)
        .all();

    const counts = new Map<string, number>();
    if (rows.length > 0 && attribute.valueType === "enum") {
        const usage = await db
            .select({ key: productAttributeValues.valueId, productCount: count() })
            .from(productAttributeValues)
            .innerJoin(products, and(eq(products.id, productAttributeValues.productId), isNull(products.deletedAt)))
            .where(sql`${productAttributeValues.valueId} IN ${jsonIdSet(rows.map((row) => row.id))}`)
            .groupBy(productAttributeValues.valueId)
            .all();
        for (const row of usage) if (row.key) counts.set(row.key, Number(row.productCount));
    } else if (rows.length > 0) {
        const key = sql<string>`lower(trim(${productAttributeValues.value}))`;
        const usage = await db
            .select({ key, productCount: count() })
            .from(productAttributeValues)
            .innerJoin(products, and(eq(products.id, productAttributeValues.productId), isNull(products.deletedAt)))
            .where(and(
                eq(productAttributeValues.attributeId, attributeId),
                sql`${key} IN ${jsonIdSet(rows.map((row) => row.normalizedValue))}`,
            ))
            .groupBy(key)
            .all();
        for (const row of usage) counts.set(row.key, Number(row.productCount));
    }

    return {
        attributeId,
        attributeName: attribute.name,
        valueType: attribute.valueType,
        values: rows.map((row) => ({
            ...row,
            productCount: counts.get(attribute.valueType === "enum" ? row.id : row.normalizedValue) ?? 0,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
    };
}

export async function createAttributeValueRow(
    db: Database,
    attributeId: string,
    input: CreateAttributeValueRowInput,
) {
    const attribute = await readLiveAttributeDefinition(db, attributeId);
    assertHasVocabulary(attribute);
    const value = input.value.trim();
    if (input.swatchHex && attribute.valueType !== "enum") {
        throw new ValidationError("Only enum values have a swatch colour.", { field: "swatchHex" });
    }
    if (await findLiveValueByText(db, attributeId, value)) {
        throw new ConflictError(`Value "${value}" already exists for this attribute`);
    }
    const id = newAttributeValueId();
    try {
        const [row] = await db.insert(attributeValues)
            .values({
                id,
                attributeId,
                value,
                normalizedValue: sql`lower(trim(${value}))`,
                sortOrder: input.sortOrder ?? sql`(SELECT COALESCE(MAX(existing.sort_order) + 1, 0) FROM ${attributeValues} AS existing WHERE existing.attribute_id = ${attributeId} AND existing.deleted_at IS NULL)`,
                swatchHex: lowerSwatch(input.swatchHex) ?? null,
            })
            .returning({
                id: attributeValues.id,
                value: attributeValues.value,
                normalizedValue: attributeValues.normalizedValue,
                sortOrder: attributeValues.sortOrder,
                swatchHex: attributeValues.swatchHex,
            });
        return { value: row! };
    } catch (error) {
        if (isUniqueViolation(error, ATTRIBUTE_VALUE_UNIQUE_PATTERN)) {
            throw new ConflictError(`Value "${value}" already exists for this attribute`);
        }
        throw error;
    }
}

/**
 * Renames, recolours or reorders one value. Renaming (or reordering) an enum
 * value rewrites the products that use it in bounded batches with their
 * projection refresh; renaming a text preset renames the preset only (the
 * string rename route rewrites matching product text).
 */
export async function updateAttributeValueRow(
    db: Database,
    attributeId: string,
    valueId: string,
    input: UpdateAttributeValueRowInput,
    refresh: CatalogProjectionRefresh,
) {
    const attribute = await readLiveAttributeDefinition(db, attributeId);
    assertHasVocabulary(attribute);
    const current = await readLiveValueRow(db, attributeId, valueId);
    if (input.swatchHex && attribute.valueType !== "enum") {
        throw new ValidationError("Only enum values have a swatch colour.", { field: "swatchHex" });
    }
    const value = input.value?.trim();
    if (value !== undefined && await findLiveValueByText(db, attributeId, value, valueId)) {
        throw new ConflictError(`Value "${value}" already exists for this attribute`);
    }
    const renamed = value !== undefined && value !== current.value;
    const reordered = input.sortOrder !== undefined && input.sortOrder !== current.sortOrder;
    try {
        await db.update(attributeValues)
            .set({
                ...(value !== undefined ? { value, normalizedValue: sql`lower(trim(${value}))` } : {}),
                ...(input.swatchHex !== undefined ? { swatchHex: lowerSwatch(input.swatchHex) } : {}),
                ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(attributeValues.id, valueId),
                eq(attributeValues.attributeId, attributeId),
                isNull(attributeValues.deletedAt),
            ))
            .run();
    } catch (error) {
        if (isUniqueViolation(error, ATTRIBUTE_VALUE_UNIQUE_PATTERN)) {
            throw new ConflictError(`Value "${value}" already exists for this attribute`);
        }
        throw error;
    }
    let productsUpdated = 0;
    if (attribute.valueType === "enum" && (renamed || reordered)) {
        productsUpdated = await refreshProductsReferencingValues(db, [valueId], refresh, { rewriteDisplay: renamed });
    }
    const row = await readLiveValueRow(db, attributeId, valueId);
    return { value: row, productsUpdated };
}

/**
 * Soft-deletes one value. An enum value that products use is refused unless
 * `mergeIntoValueId` names another live value of the same attribute: the
 * products are repointed to it (bounded, refreshed, revision-bumped) first.
 */
export async function deleteAttributeValueRow(
    db: Database,
    attributeId: string,
    valueId: string,
    options: { mergeIntoValueId?: string },
    refresh: CatalogProjectionRefresh,
) {
    const attribute = await readLiveAttributeDefinition(db, attributeId);
    assertHasVocabulary(attribute);
    const current = await readLiveValueRow(db, attributeId, valueId);
    let productsMerged = 0;

    if (options.mergeIntoValueId !== undefined) {
        if (attribute.valueType !== "enum") {
            throw new ValidationError("Only enum values can be merged.", { field: "mergeIntoValueId" });
        }
        if (options.mergeIntoValueId === valueId) {
            throw new ValidationError("Merge a value into a different value.", { field: "mergeIntoValueId" });
        }
        const target = await readLiveValueRow(db, attributeId, options.mergeIntoValueId);
        const references = sql`${productAttributeValues.valueId} = ${valueId}`;
        productsMerged = await forEachAttributeProductChunk(db, references, (productIds) => [
            db.update(productAttributeValues)
                .set({
                    valueId: target.id,
                    value: sql`(SELECT live_value.value FROM ${attributeValues} AS live_value WHERE live_value.id = ${target.id})`,
                })
                .where(and(references, sql`${productAttributeValues.productId} IN ${jsonIdSet(productIds)}`)),
            productRevisionBumpStatement(db, productIds),
            ...refresh(productIds),
        ]);
    } else if (attribute.valueType === "enum") {
        const usage = await db
            .select({ productCount: count() })
            .from(productAttributeValues)
            .where(eq(productAttributeValues.valueId, valueId))
            .get();
        const used = Number(usage?.productCount ?? 0);
        if (used > 0) {
            throw new ConflictError(
                `${used} ${used === 1 ? "product uses" : "products use"} "${current.value}". Merge it into another value or change those products first.`,
            );
        }
    }

    try {
        await safeBatch(db, [
            buildBatchGuard(db, sql`NOT EXISTS (
                SELECT 1 FROM ${productAttributeValues} WHERE ${productAttributeValues.valueId} = ${valueId}
            )`, "ATTRIBUTE_VALUE_IN_USE"),
            db.update(attributeValues)
                .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(and(eq(attributeValues.id, valueId), isNull(attributeValues.deletedAt))),
        ] as never);
    } catch (error) {
        if (isBatchGuardError(error, "ATTRIBUTE_VALUE_IN_USE")) {
            throw new ConflictError("Products started using this value while it was being deleted. Try again.");
        }
        throw error;
    }
    return { deleted: true as const, productsMerged };
}

/** Sets the sort order of up to 90 values; enum reorders refresh the facet order of their products. */
export async function reorderAttributeValueRows(
    db: Database,
    attributeId: string,
    items: ReadonlyArray<{ valueId: string; sortOrder: number }>,
    refresh: CatalogProjectionRefresh,
) {
    const attribute = await readLiveAttributeDefinition(db, attributeId);
    assertHasVocabulary(attribute);
    const ids = [...new Set(items.map((item) => item.valueId))];
    if (ids.length !== items.length) throw new ValidationError("Each value can appear only once.");
    const live = await db
        .select({ id: attributeValues.id, sortOrder: attributeValues.sortOrder })
        .from(attributeValues)
        .where(and(
            eq(attributeValues.attributeId, attributeId),
            isNull(attributeValues.deletedAt),
            sql`${attributeValues.id} IN ${jsonIdSet(ids)}`,
        ))
        .all();
    if (live.length !== ids.length) throw new NotFoundError("One or more values no longer exist. Refresh and try again.");
    const before = new Map(live.map((row) => [row.id, row.sortOrder]));
    const changed = items.filter((item) => before.get(item.valueId) !== item.sortOrder);
    if (changed.length === 0) return { updated: 0, productsRefreshed: 0 };
    const payload = JSON.stringify(changed.map((item) => ({ i: item.valueId, s: item.sortOrder })));
    await db.update(attributeValues)
        .set({
            sortOrder: sql`(SELECT CAST(json_extract(entry.value, '$.s') AS INTEGER) FROM json_each(${payload}) AS entry WHERE CAST(json_extract(entry.value, '$.i') AS TEXT) = ${attributeValues.id})`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(attributeValues.attributeId, attributeId),
            isNull(attributeValues.deletedAt),
            sql`${attributeValues.id} IN (SELECT CAST(json_extract(entry.value, '$.i') AS TEXT) FROM json_each(${payload}) AS entry)`,
        ))
        .run();
    const productsRefreshed = attribute.valueType === "enum"
        ? await refreshProductsReferencingValues(db, changed.map((item) => item.valueId), refresh, { rewriteDisplay: false })
        : 0;
    return { updated: changed.length, productsRefreshed };
}

// ─────────────────────────────────────────
// The definition's `options` list, stored as attribute_values
// ─────────────────────────────────────────

export type AttributeValuePresetPlan = {
    /** Guard, insert, update and soft-delete statements for the definition's batch. */
    statements: AttributeBatchItem[];
    /** Enum values whose text or order changed: their products need rewriting afterwards. */
    changedEnumValueIds: string[];
    renamedEnumValueIds: string[];
};

/**
 * Plans the value rows that make the attribute's live vocabulary equal
 * `options` (in order): missing ones are inserted, kept ones take the given
 * text and position, removed ones are soft-deleted. Removing an enum value
 * that products use is refused (and guarded in the batch).
 */
export async function planAttributeValuePresets(
    db: Database,
    attribute: Pick<LiveAttributeDefinition, "id" | "valueType">,
    options: readonly string[],
): Promise<AttributeValuePresetPlan> {
    if (attribute.valueType === "number" || attribute.valueType === "boolean") {
        if (options.length > 0) throw new ValidationError("Number and yes/no attributes have no preset values.", { field: "options" });
        return { statements: [], changedEnumValueIds: [], renamedEnumValueIds: [] };
    }
    const current = await db
        .select({ id: attributeValues.id, value: attributeValues.value, sortOrder: attributeValues.sortOrder })
        .from(attributeValues)
        .where(and(eq(attributeValues.attributeId, attribute.id), isNull(attributeValues.deletedAt)))
        .orderBy(asc(attributeValues.sortOrder), asc(attributeValues.id))
        .limit(MAX_ATTRIBUTE_PRESET_ROWS + 1)
        .all();
    if (current.length > MAX_ATTRIBUTE_PRESET_ROWS) {
        throw new ValidationError("This attribute has too many values to replace as a list. Edit its values one by one.");
    }
    const currentByKey = new Map(current.map((row) => [normalizeAttributeValue(row.value), row]));
    const desired: Array<{ value: string; sortOrder: number }> = [];
    const desiredKeys = new Set<string>();
    for (const option of options) {
        const value = option.trim();
        const key = normalizeAttributeValue(value);
        if (!value || desiredKeys.has(key)) continue;
        desiredKeys.add(key);
        desired.push({ value, sortOrder: desired.length });
    }

    const inserts: NewAttributeValueRow[] = [];
    const updates: Array<{ id: string; value: string; sortOrder: number }> = [];
    const renamedEnumValueIds: string[] = [];
    const changedEnumValueIds: string[] = [];
    for (const item of desired) {
        const existing = currentByKey.get(normalizeAttributeValue(item.value));
        if (!existing) {
            inserts.push({ id: newAttributeValueId(), value: item.value, sortOrder: item.sortOrder });
        } else if (existing.value !== item.value || existing.sortOrder !== item.sortOrder) {
            updates.push({ id: existing.id, value: item.value, sortOrder: item.sortOrder });
            if (attribute.valueType === "enum") {
                changedEnumValueIds.push(existing.id);
                if (existing.value !== item.value) renamedEnumValueIds.push(existing.id);
            }
        }
    }
    const removedIds = current
        .filter((row) => !desiredKeys.has(normalizeAttributeValue(row.value)))
        .map((row) => row.id);

    const statements: AttributeBatchItem[] = [];
    if (removedIds.length > 0) {
        if (attribute.valueType === "enum") {
            const used = await db
                .select({ value: attributeValues.value })
                .from(productAttributeValues)
                .innerJoin(attributeValues, eq(attributeValues.id, productAttributeValues.valueId))
                .where(sql`${productAttributeValues.valueId} IN ${jsonIdSet(removedIds)}`)
                .limit(5)
                .all();
            if (used.length > 0) {
                const names = [...new Set(used.map((row) => `"${row.value}"`))].join(", ");
                throw new ConflictError(`Products still use ${names}. Merge those values into others before removing them.`);
            }
            statements.push(buildBatchGuard(db, sql`NOT EXISTS (
                SELECT 1 FROM ${productAttributeValues}
                WHERE ${productAttributeValues.valueId} IN ${jsonIdSet(removedIds)}
            )`, "ATTRIBUTE_VALUE_IN_USE"));
        }
        statements.push(db.update(attributeValues)
            .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(and(
                eq(attributeValues.attributeId, attribute.id),
                isNull(attributeValues.deletedAt),
                sql`${attributeValues.id} IN ${jsonIdSet(removedIds)}`,
            )));
    }
    if (updates.length > 0) {
        const payload = JSON.stringify(updates.map((row) => ({ i: row.id, v: row.value, s: row.sortOrder })));
        const pick = (field: "v" | "s") => sql`(SELECT json_extract(entry.value, ${`$.${field}`}) FROM json_each(${payload}) AS entry WHERE CAST(json_extract(entry.value, '$.i') AS TEXT) = ${attributeValues.id})`;
        statements.push(db.update(attributeValues)
            .set({
                value: sql`CAST(${pick("v")} AS TEXT)`,
                normalizedValue: sql`lower(trim(CAST(${pick("v")} AS TEXT)))`,
                sortOrder: sql`CAST(${pick("s")} AS INTEGER)`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(attributeValues.attributeId, attribute.id),
                isNull(attributeValues.deletedAt),
                sql`${attributeValues.id} IN (SELECT CAST(json_extract(entry.value, '$.i') AS TEXT) FROM json_each(${payload}) AS entry)`,
            )));
    }
    for (let index = 0; index < inserts.length; index += 250) {
        statements.push(attributeValueInsertStatement(db, attribute.id, inserts.slice(index, index + 250)));
    }
    return { statements, changedEnumValueIds, renamedEnumValueIds };
}

/** Live preset text of an attribute, in order (the legacy `options` view). */
export async function readAttributePresetTexts(db: Database, attributeId: string): Promise<string[]> {
    const rows = await db
        .select({ value: attributeValues.value })
        .from(attributeValues)
        .where(and(eq(attributeValues.attributeId, attributeId), isNull(attributeValues.deletedAt)))
        .orderBy(asc(attributeValues.sortOrder), asc(attributeValues.normalizedValue), asc(attributeValues.id))
        .limit(MAX_ATTRIBUTE_PRESET_ROWS)
        .all();
    return rows.map((row) => row.value);
}
