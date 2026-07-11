// src/modules/attributes/attributes.service.ts
// All DB queries and business logic for the product attributes domain.

import { productAttributes, productAttributeValues, products } from "@scalius/database/schema";
import { sql, eq, and, or, like, asc, desc, count, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";

import type { CreateAttributeInput, UpdateAttributeInput } from "./attributes.validation";

function productRevisionBumpForAttributeValues(
    db: Database,
    condition: SQL,
) {
    return db.update(products)
        .set({
            aggregateRevision: sql`${products.aggregateRevision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(sql`${products.id} IN (
            SELECT ${productAttributeValues.productId}
            FROM ${productAttributeValues}
            WHERE ${condition}
        )`);
}

// ─────────────────────────────────────────
// Queries
// ─────────────────────────────────────────

export async function listAttributes(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        sort?: string;
        order?: "asc" | "desc";
        showTrashed?: boolean;
    } = {},
) {
    const {
        page = 1,
        limit = 10,
        search = "",
        sort = "name",
        order = "asc",
        showTrashed = false,
    } = options;

    const offset = (page - 1) * limit;

    const whereConditions = [];
    if (showTrashed) {
        whereConditions.push(sql`${productAttributes.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${productAttributes.deletedAt} IS NULL`);
    }

    if (search) {
        whereConditions.push(
            or(
                like(productAttributes.name, `%${search}%`),
                like(productAttributes.slug, `%${search}%`),
            ),
        );
    }

    const combinedWhereClause =
        whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const totalResult = await db
        .select({ count: count(productAttributes.id) })
        .from(productAttributes)
        .where(combinedWhereClause)
        .get();

    const total = totalResult?.count ?? 0;

    const ALLOWED_SORT_FIELDS = ["name", "slug", "filterable", "createdAt", "updatedAt"] as const;
    type SortField = typeof ALLOWED_SORT_FIELDS[number];
    const safeSortField: SortField = ALLOWED_SORT_FIELDS.includes(sort as SortField) ? sort as SortField : "name";
    const sortColumn = productAttributes[safeSortField];
    const attributes = await db
        .select()
        .from(productAttributes)
        .where(combinedWhereClause)
        .orderBy(
            order === "asc"
                ? asc(sortColumn)
                : desc(sortColumn),
        )
        .limit(limit)
        .offset(offset);

    const attributeIds = attributes.map((attr) => attr.id);
    const valueCounts =
        attributeIds.length > 0
            ? await db
                .select({
                    attributeId: productAttributeValues.attributeId,
                    valueCount: count(sql`DISTINCT ${productAttributeValues.value}`)
                })
                .from(productAttributeValues)
                .where(inArray(productAttributeValues.attributeId, attributeIds))
                .groupBy(productAttributeValues.attributeId)
                .all()
            : [];

    const valueCountMap = new Map(
        valueCounts.map((item) => [item.attributeId, item.valueCount]),
    );

    const enrichedAttributes = attributes.map((attr) => ({
        ...attr,
        valueCount: valueCountMap.get(attr.id) || 0
    }));

    return {
        attributes: enrichedAttributes,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createAttribute(
    db: Database,
    data: CreateAttributeInput,
) {
    const { name, slug, filterable, options } = data;

    const existingAttribute = await db
        .select({ id: productAttributes.id, deletedAt: productAttributes.deletedAt })
        .from(productAttributes)
        .where(
            or(eq(productAttributes.name, name), eq(productAttributes.slug, slug)),
        )
        .get();

    if (existingAttribute) {
        if (existingAttribute.deletedAt) {
            throw new ConflictError(
                "A deleted attribute with that name or slug exists. Restore it from the trash or permanently delete it first."
            );
        }
        throw new ConflictError("An attribute with that name or slug already exists.");
    }

    const newAttributeId = "attr_" + nanoid();
    const [insertedAttribute] = await db
        .insert(productAttributes)
        .values({
            id: newAttributeId,
            name,
            slug,
            filterable,
            options: options || null,
            createdAt: sql`(cast(strftime('%s','now') as int))`,
            updatedAt: sql`(cast(strftime('%s','now') as int))`
        })
        .returning();

    return { attribute: insertedAttribute };
}

export async function updateAttribute(
    db: Database,
    id: string,
    data: UpdateAttributeInput,
) {
    if (data.name || data.slug) {
        const orConditions = [];
        if (data.name) orConditions.push(eq(productAttributes.name, data.name));
        if (data.slug) orConditions.push(eq(productAttributes.slug, data.slug));

        const existingAttribute = await db
            .select()
            .from(productAttributes)
            .where(and(or(...orConditions), sql`${productAttributes.id} != ${id}`))
            .get();

        if (existingAttribute) {
            throw new ConflictError("An attribute with that name or slug already exists.");
        }
    }

    const [updatedAttribute] = await db
        .update(productAttributes)
        .set({
            ...data,
            updatedAt: sql`(cast(strftime('%s','now') as int))`
        })
        .where(eq(productAttributes.id, id))
        .returning();

    if (!updatedAttribute) throw new NotFoundError("Attribute not found");

    return { attribute: updatedAttribute };
}

export async function deleteAttribute(db: Database, id: string) {
    const usage = await db
        .select({
            productName: products.name,
            productId: products.id
        })
        .from(productAttributeValues)
        .leftJoin(products, eq(productAttributeValues.productId, products.id))
        .where(eq(productAttributeValues.attributeId, id))
        .limit(5);

    if (usage.length > 0) {
        const productNames = usage.map((p) => p.productName).join(", ");
        const errorMessage = `Cannot delete. Attribute is used by ${usage.length}${usage.length < 5 ? "" : "+"} product(s), including: ${productNames}.`;
        throw new ConflictError(errorMessage);
    }

    await db
        .update(productAttributes)
        .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
        .where(eq(productAttributes.id, id));
}

export async function permanentlyDeleteAttribute(db: Database, id: string) {
    await permanentlyDeleteAttributes(db, [id]);
}

async function permanentlyDeleteAttributes(db: Database, ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;
    if (uniqueIds.length > 90) {
        throw new ValidationError("Delete at most 90 attributes at a time.");
    }
    await safeBatch(db, [
        productRevisionBumpForAttributeValues(
            db,
            inArray(productAttributeValues.attributeId, uniqueIds),
        ),
        db.delete(productAttributes).where(inArray(productAttributes.id, uniqueIds)),
    ] as never);
}

export async function restoreAttribute(db: Database, id: string) {
    const attribute = await db
        .select()
        .from(productAttributes)
        .where(eq(productAttributes.id, id))
        .get();

    if (!attribute) throw new NotFoundError("Attribute not found");

    const conflict = await db
        .select({ id: productAttributes.id })
        .from(productAttributes)
        .where(
            and(
                or(
                    eq(productAttributes.name, attribute.name),
                    eq(productAttributes.slug, attribute.slug),
                ),
                isNull(productAttributes.deletedAt),
                sql`${productAttributes.id} != ${id}`,
            ),
        )
        .get();

    if (conflict) {
        throw new ConflictError("Cannot restore: an active attribute with the same name or slug already exists");
    }

    await db
        .update(productAttributes)
        .set({ deletedAt: null })
        .where(eq(productAttributes.id, id));
}

export async function bulkDeleteAttributes(db: Database, ids: string[], permanent = false) {
    if (ids.length === 0) return;

    if (permanent) {
        await permanentlyDeleteAttributes(db, ids);
    } else {
        await db
            .update(productAttributes)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(inArray(productAttributes.id, ids));
    }
}

export async function bulkRestoreAttributes(db: Database, ids: string[]) {
    if (ids.length === 0) return;

    await db
        .update(productAttributes)
        .set({ deletedAt: null })
        .where(inArray(productAttributes.id, ids));
}

// ─────────────────────────────────────────
// Attribute Values
// ─────────────────────────────────────────

const ATTRIBUTE_VALUE_PAGE_LIMIT = 100;

function attributeValueKey(value: string): string {
    return value.trim().toLowerCase();
}

function dedupeAttributeOptions(options: string[]): string[] {
    const uniqueOptions: string[] = [];
    const seenKeys = new Set<string>();
    for (const option of options) {
        const normalizedOption = option.trim();
        const key = attributeValueKey(normalizedOption);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        uniqueOptions.push(normalizedOption);
    }
    return uniqueOptions;
}

function normalizeAttributeValue(value: string): string {
    const normalizedValue = value.trim();
    if (!normalizedValue) throw new ValidationError("Attribute value is required");
    return normalizedValue;
}

function requireExistingAttributeValue(value: string): string {
    if (!value.trim()) throw new ValidationError("Attribute value is required");
    return value;
}

export async function listAttributeValues(
    db: Database,
    attributeId: string,
    options: {
        search?: string;
        sort?: string;
        page?: number;
        limit?: number;
    } = {},
) {
    const search = options.search?.trim() || undefined;
    const sort = options.sort === "asc" ? "asc" : "desc";
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const limit = Math.min(
        ATTRIBUTE_VALUE_PAGE_LIMIT,
        Math.max(1, Math.floor(options.limit ?? 20)),
    );

    const attribute = await db
        .select()
        .from(productAttributes)
        .where(
            and(
                eq(productAttributes.id, attributeId),
                isNull(productAttributes.deletedAt)
            )
        )
        .get();

    if (!attribute) throw new NotFoundError("Attribute not found");

    const offset = (page - 1) * limit;
    const attrOptions = dedupeAttributeOptions((attribute.options as string[]) || []);
    const attrOptionKeys = new Set(attrOptions.map(attributeValueKey));

    // Build WHERE conditions for DB-level filtering
    const whereConditions = [
        eq(productAttributeValues.attributeId, attributeId),
        isNull(products.deletedAt),
    ];
    if (search) {
        whereConditions.push(like(productAttributeValues.value, `%${search}%`));
    }

    const combinedWhere = and(...whereConditions);

    // Get total count of distinct values at DB level
    const totalResult = await db
        .select({
            totalValues: count(sql`DISTINCT ${productAttributeValues.value}`),
            totalProducts: count(productAttributeValues.productId),
        })
        .from(productAttributeValues)
        .innerJoin(products, eq(productAttributeValues.productId, products.id))
        .where(combinedWhere)
        .get();

    // Get paginated distinct values with counts using GROUP BY
    const dbTotal = totalResult?.totalValues ?? 0;
    const dbItemsToFetch = offset < dbTotal
        ? Math.min(limit, dbTotal - offset)
        : 0;
    const dbValues = dbItemsToFetch > 0
        ? await db
            .select({
                value: productAttributeValues.value,
                productCount: count(productAttributeValues.productId),
                earliestCreatedAt: sql<number>`MIN(${productAttributeValues.createdAt})`,
            })
            .from(productAttributeValues)
            .innerJoin(products, eq(productAttributeValues.productId, products.id))
            .where(combinedWhere)
            .groupBy(productAttributeValues.value)
            .orderBy(
                sort === "asc"
                    ? asc(sql`MIN(${productAttributeValues.createdAt})`)
                    : desc(sql`MIN(${productAttributeValues.createdAt})`)
            )
            .limit(dbItemsToFetch)
            .offset(offset)
            .all()
        : [];

    // Batch fetch sample product names for all values on this page
    const pageValues = dbValues.map((v) => v.value);
    const sampleProductMap = new Map<string, string[]>();
    if (pageValues.length > 0) {
        const rankedSamples = db
            .select({
                value: productAttributeValues.value,
                productName: products.name,
                sampleRank: sql<number>`ROW_NUMBER() OVER (
                    PARTITION BY ${productAttributeValues.value}
                    ORDER BY ${products.name}, ${products.id}
                )`.as("sample_rank"),
            })
            .from(productAttributeValues)
            .innerJoin(products, eq(productAttributeValues.productId, products.id))
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    sql`${productAttributeValues.value} IN (
                        SELECT CAST(value AS TEXT)
                        FROM json_each(${JSON.stringify(pageValues)})
                    )`,
                    isNull(products.deletedAt),
                )
            )
            .as("ranked_attribute_value_samples");

        const allSamples = await db
            .select({
                value: rankedSamples.value,
                productName: rankedSamples.productName,
            })
            .from(rankedSamples)
            .where(lte(rankedSamples.sampleRank, 5))
            .all();

        // Group by value, keeping at most 5 sample names per value
        for (const row of allSamples) {
            const existing = sampleProductMap.get(row.value) || [];
            if (existing.length < 5) {
                existing.push(row.productName);
                sampleProductMap.set(row.value, existing);
            }
        }
    }

    const values = dbValues.map((row) => ({
        value: row.value,
        productCount: row.productCount,
        createdAt: row.earliestCreatedAt,
        isPreset: attrOptionKeys.has(attributeValueKey(row.value)),
        sampleProducts: sampleProductMap.get(row.value) || [],
    }));

    // Reconcile presets against every used value, not only the current page.
    // Bind the candidate set as one JSON value so a large preset list cannot
    // cross D1's 100-bound-parameter ceiling.
    const normalizedSearch = search ? attributeValueKey(search) : undefined;
    const matchingPresetOptions = normalizedSearch
        ? attrOptions.filter((option) => attributeValueKey(option).includes(normalizedSearch))
        : attrOptions;
    const matchingPresetKeys = matchingPresetOptions.map(attributeValueKey);
    const usedRows = matchingPresetOptions.length > 0
        ? await db
            .select({
                valueKey: sql<string>`lower(trim(${productAttributeValues.value}))`,
            })
            .from(productAttributeValues)
            .innerJoin(products, eq(productAttributeValues.productId, products.id))
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    sql`lower(trim(${productAttributeValues.value})) IN (
                        SELECT CAST(value AS TEXT)
                        FROM json_each(${JSON.stringify(matchingPresetKeys)})
                    )`,
                    isNull(products.deletedAt),
                ),
            )
            .groupBy(sql`lower(trim(${productAttributeValues.value}))`)
            .all()
        : [];
    const usedPresetKeys = new Set(usedRows.map((row) => row.valueKey));

    const unusedPresets = matchingPresetOptions
        .filter((option) => !usedPresetKeys.has(attributeValueKey(option)))
        .map((opt) => ({
            value: opt,
            productCount: 0,
            createdAt: attribute.updatedAt instanceof Date
                ? Math.floor(attribute.updatedAt.getTime() / 1000)
                : (attribute.updatedAt as number),
            isPreset: true,
            sampleProducts: [] as string[],
        }));

    const totalValues = dbTotal + unusedPresets.length;

    // Used values keep their database order; unused presets follow in their
    // merchant-defined order and fill the remainder of the requested page.
    const presetOffset = Math.max(0, offset - dbTotal);
    const presetSlots = limit - values.length;
    const finalValues = presetSlots > 0
        ? [...values, ...unusedPresets.slice(presetOffset, presetOffset + presetSlots)]
        : values;

    return {
        attributeId,
        attributeName: attribute.name,
        values: finalValues,
        totalValues,
        totalProducts: totalResult?.totalProducts ?? 0,
        page,
        limit,
        totalPages: Math.ceil(totalValues / limit)
    };
}

export async function addAttributeValue(
    db: Database,
    attributeId: string,
    value: string,
) {
    const attribute = await db
        .select()
        .from(productAttributes)
        .where(eq(productAttributes.id, attributeId))
        .get();

    if (!attribute) throw new NotFoundError("Attribute not found");

    const normalizedValue = normalizeAttributeValue(value);
    const currentOptions = dedupeAttributeOptions((attribute.options as string[]) || []);
    if (currentOptions.some((option) => attributeValueKey(option) === attributeValueKey(normalizedValue))) {
        throw new ConflictError(`Value "${normalizedValue}" already exists for this attribute`);
    }

    const newOptions = [...currentOptions, normalizedValue];
    await db
        .update(productAttributes)
        .set({ options: newOptions })
        .where(eq(productAttributes.id, attributeId));
}

export async function renameAttributeValue(
    db: Database,
    attributeId: string,
    oldValue: string,
    newValue: string,
) {
    const attribute = await db
        .select()
        .from(productAttributes)
        .where(eq(productAttributes.id, attributeId))
        .get();

    if (!attribute) throw new NotFoundError("Attribute not found");

    const normalizedOldValue = requireExistingAttributeValue(oldValue);
    const normalizedNewValue = normalizeAttributeValue(newValue);
    const oldValueKey = attributeValueKey(normalizedOldValue);
    const newValueKey = attributeValueKey(normalizedNewValue);
    const rawOptions = (attribute.options as string[]) || [];
    if (
        oldValueKey !== newValueKey &&
        rawOptions.some((option) => attributeValueKey(option) === newValueKey)
    ) {
        throw new ConflictError(
            `Value "${normalizedNewValue}" already exists for this attribute`,
        );
    }

    const affectedValueCondition = and(
            eq(productAttributeValues.attributeId, attributeId),
            sql`lower(trim(${productAttributeValues.value})) = ${oldValueKey}`,
        )!;
    const batchOps: unknown[] = [
        productRevisionBumpForAttributeValues(db, affectedValueCondition),
        db
            .update(productAttributeValues)
            .set({ value: normalizedNewValue })
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    sql`lower(trim(${productAttributeValues.value})) = ${oldValueKey}`,
                )
            ),
    ];

    const currentOptions = dedupeAttributeOptions(rawOptions);
    if (currentOptions.some((option) => attributeValueKey(option) === oldValueKey)) {
        const newOptions = dedupeAttributeOptions(currentOptions.map((option) =>
            attributeValueKey(option) === oldValueKey ? normalizedNewValue : option
        ));
        batchOps.push(
            db
                .update(productAttributes)
                .set({ options: newOptions })
                .where(eq(productAttributes.id, attributeId))
        );
    }

    await safeBatch(db, batchOps as never);
}

export async function deleteAttributeValue(
    db: Database,
    attributeId: string,
    value: string,
) {
    const attribute = await db
        .select()
        .from(productAttributes)
        .where(eq(productAttributes.id, attributeId))
        .get();

    if (!attribute) throw new NotFoundError("Attribute not found");

    const normalizedValue = requireExistingAttributeValue(value);
    const normalizedValueKey = attributeValueKey(normalizedValue);
    const affectedValueCondition = and(
            eq(productAttributeValues.attributeId, attributeId),
            sql`lower(trim(${productAttributeValues.value})) = ${normalizedValueKey}`,
        )!;
    const batchOps: unknown[] = [
        productRevisionBumpForAttributeValues(db, affectedValueCondition),
        db
            .delete(productAttributeValues)
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    sql`lower(trim(${productAttributeValues.value})) = ${normalizedValueKey}`,
                )
            ),
    ];

    const currentOptions = dedupeAttributeOptions((attribute.options as string[]) || []);
    if (currentOptions.some((option) => attributeValueKey(option) === normalizedValueKey)) {
        const newOptions = currentOptions.filter(
            (option) => attributeValueKey(option) !== normalizedValueKey,
        );
        batchOps.push(
            db
                .update(productAttributes)
                .set({ options: newOptions })
                .where(eq(productAttributes.id, attributeId))
        );
    }

    await safeBatch(db, batchOps as never);
}
