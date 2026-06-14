// src/modules/attributes/attributes.service.ts
// All DB queries and business logic for the product attributes domain.

import { productAttributes, productAttributeValues, products } from "@scalius/database/schema";
import { sql, eq, and, or, like, asc, desc, count, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ConflictError } from "@scalius/core/errors";

import type { CreateAttributeInput, UpdateAttributeInput } from "./attributes.validation";

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
    await db
        .delete(productAttributes)
        .where(eq(productAttributes.id, id));
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
        await db
            .delete(productAttributes)
            .where(inArray(productAttributes.id, ids));
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
    const {
        search,
        sort = "desc",
        page = 1,
        limit = 20,
    } = options;

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
    const attrOptions = (attribute.options as string[]) || [];

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
            total: count(sql`DISTINCT ${productAttributeValues.value}`),
        })
        .from(productAttributeValues)
        .innerJoin(products, eq(productAttributeValues.productId, products.id))
        .where(combinedWhere)
        .get();

    // Get paginated distinct values with counts using GROUP BY
    const dbValues = await db
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
        .limit(limit)
        .offset(offset)
        .all();

    // Batch fetch sample product names for all values on this page
    const pageValues = dbValues.map((v) => v.value);
    const sampleProductMap = new Map<string, string[]>();
    if (pageValues.length > 0) {
        const allSamples = await db
            .select({
                value: productAttributeValues.value,
                productName: products.name,
            })
            .from(productAttributeValues)
            .innerJoin(products, eq(productAttributeValues.productId, products.id))
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    inArray(productAttributeValues.value, pageValues),
                    isNull(products.deletedAt),
                )
            )
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
        isPreset: attrOptions.includes(row.value),
        sampleProducts: sampleProductMap.get(row.value) || [],
    }));

    // Count preset options that have no product usage (and match search if any)
    const unusedPresets = attrOptions
        .filter((opt) => {
            if (search && !opt.toLowerCase().includes(search.toLowerCase())) return false;
            return !dbValues.some((v) => v.value === opt);
        })
        .map((opt) => ({
            value: opt,
            productCount: 0,
            createdAt: attribute.updatedAt instanceof Date
                ? Math.floor(attribute.updatedAt.getTime() / 1000)
                : (attribute.updatedAt as number),
            isPreset: true,
            sampleProducts: [] as string[],
        }));

    const dbTotal = totalResult?.total ?? 0;
    const totalValues = dbTotal + unusedPresets.length;

    // Merge unused presets into results if we're on a page that would include them
    // (unused presets are appended after DB results)
    const dbTotalPages = Math.ceil(dbTotal / limit);
    let finalValues = values;
    if (page > dbTotalPages || (page === dbTotalPages && values.length < limit)) {
        // Calculate how many unused preset slots fit on this page
        const dbItemsOnPage = values.length;
        const slotsLeft = limit - dbItemsOnPage;
        const presetOffset = page <= dbTotalPages ? 0 : (page - dbTotalPages - 1) * limit + (limit - dbItemsOnPage);
        finalValues = [...values, ...unusedPresets.slice(presetOffset, presetOffset + slotsLeft)];
    }

    return {
        attributeId,
        attributeName: attribute.name,
        values: finalValues,
        totalValues,
        page,
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

    const currentOptions = (attribute.options as string[]) || [];
    if (currentOptions.includes(value)) {
        throw new ConflictError(`Value "${value}" already exists for this attribute`);
    }

    const newOptions = [...currentOptions, value];
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

    const batchOps: unknown[] = [
        db
            .update(productAttributeValues)
            .set({ value: newValue })
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    eq(productAttributeValues.value, oldValue)
                )
            ),
    ];

    const currentOptions = (attribute.options as string[]) || [];
    if (currentOptions.includes(oldValue)) {
        const newOptions = currentOptions.map((o) =>
            o === oldValue ? newValue : o
        );
        batchOps.push(
            db
                .update(productAttributes)
                .set({ options: newOptions })
                .where(eq(productAttributes.id, attributeId))
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(batchOps as any);
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

    const batchOps: unknown[] = [
        db
            .delete(productAttributeValues)
            .where(
                and(
                    eq(productAttributeValues.attributeId, attributeId),
                    eq(productAttributeValues.value, value)
                )
            ),
    ];

    const currentOptions = (attribute.options as string[]) || [];
    if (currentOptions.includes(value)) {
        const newOptions = currentOptions.filter((o) => o !== value);
        batchOps.push(
            db
                .update(productAttributes)
                .set({ options: newOptions })
                .where(eq(productAttributes.id, attributeId))
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(batchOps as any);
}
