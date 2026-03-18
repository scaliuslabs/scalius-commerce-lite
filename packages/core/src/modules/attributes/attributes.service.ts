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

    const sortField = sort as keyof typeof productAttributes._.columns;
    const attributes = await db
        .select()
        .from(productAttributes)
        .where(combinedWhereClause)
        .orderBy(
            order === "asc"
                ? asc(productAttributes[sortField])
                : desc(productAttributes[sortField]),
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
        .select()
        .from(productAttributes)
        .where(
            or(eq(productAttributes.name, name), eq(productAttributes.slug, slug)),
        )
        .get();

    if (existingAttribute) {
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

    await db
        .update(productAttributes)
        .set({ deletedAt: null })
        .where(eq(productAttributes.id, id));
}

export async function bulkDeleteAttributes(db: Database, ids: string[], permanent = false) {
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

    const allRows = await db
        .select({
            value: productAttributeValues.value,
            createdAt: productAttributeValues.createdAt,
            productName: products.name
        })
        .from(productAttributeValues)
        .innerJoin(products, eq(productAttributeValues.productId, products.id))
        .where(
            and(
                eq(productAttributeValues.attributeId, attributeId),
                isNull(products.deletedAt)
            )
        )
        .all();

    const valueMap = new Map<string, { value: string; productCount: number; createdAt: Date; isPreset: boolean; sampleProducts: string[] }>();

    for (const row of allRows) {
        const existing = valueMap.get(row.value) || {
            value: row.value,
            productCount: 0,
            createdAt: row.createdAt,
            isPreset: false,
            sampleProducts: [] as string[]
        };

        existing.productCount++;
        if (row.createdAt < existing.createdAt) {
            existing.createdAt = row.createdAt;
        }
        if (existing.sampleProducts.length < 5) {
            existing.sampleProducts.push(row.productName);
        }
        valueMap.set(row.value, existing);
    }

    const attrOptions = (attribute.options as string[]) || [];
    for (const option of attrOptions) {
        if (valueMap.has(option)) {
            valueMap.get(option)!.isPreset = true;
        } else {
            valueMap.set(option, {
                value: option,
                productCount: 0,
                createdAt: attribute.updatedAt,
                isPreset: true,
                sampleProducts: []
            });
        }
    }

    let allValues = Array.from(valueMap.values());
    if (search) {
        const lowerSearch = search.toLowerCase();
        allValues = allValues.filter((v) =>
            v.value.toLowerCase().includes(lowerSearch)
        );
    }

    allValues.sort((a, b) => {
        const timeA = a.createdAt.getTime();
        const timeB = b.createdAt.getTime();
        return sort === "asc" ? timeA - timeB : timeB - timeA;
    });

    const offset = (page - 1) * limit;
    const paginatedValues = allValues.slice(offset, offset + limit);

    return {
        attributeId,
        attributeName: attribute.name,
        values: paginatedValues,
        totalValues: allValues.length,
        page,
        totalPages: Math.ceil(allValues.length / limit)
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
    if (!currentOptions.includes(value)) {
        const newOptions = [...currentOptions, value];
        await db
            .update(productAttributes)
            .set({ options: newOptions })
            .where(eq(productAttributes.id, attributeId));
    }
}

export async function renameAttributeValue(
    db: Database,
    attributeId: string,
    oldValue: string,
    newValue: string,
) {
    await db
        .update(productAttributeValues)
        .set({ value: newValue })
        .where(
            and(
                eq(productAttributeValues.attributeId, attributeId),
                eq(productAttributeValues.value, oldValue)
            )
        );

    const attribute = await db
        .select()
        .from(productAttributes)
        .where(eq(productAttributes.id, attributeId))
        .get();

    if (attribute) {
        const currentOptions = (attribute.options as string[]) || [];
        if (currentOptions.includes(oldValue)) {
            const newOptions = currentOptions.map((o) =>
                o === oldValue ? newValue : o
            );
            await db
                .update(productAttributes)
                .set({ options: newOptions })
                .where(eq(productAttributes.id, attributeId));
        }
    }
}

export async function deleteAttributeValue(
    db: Database,
    attributeId: string,
    value: string,
) {
    await db
        .delete(productAttributeValues)
        .where(
            and(
                eq(productAttributeValues.attributeId, attributeId),
                eq(productAttributeValues.value, value)
            )
        );

    const attribute = await db
        .select()
        .from(productAttributes)
        .where(eq(productAttributes.id, attributeId))
        .get();

    if (attribute) {
        const currentOptions = (attribute.options as string[]) || [];
        if (currentOptions.includes(value)) {
            const newOptions = currentOptions.filter((o) => o !== value);
            await db
                .update(productAttributes)
                .set({ options: newOptions })
                .where(eq(productAttributes.id, attributeId));
        }
    }
}
