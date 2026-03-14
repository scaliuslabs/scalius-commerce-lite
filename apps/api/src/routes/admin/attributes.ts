// src/server/routes/admin/attributes.ts
// Admin OpenAPI routes for product attributes.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { sql, eq, and, or, like, asc, desc, count, inArray, isNull } from "drizzle-orm";
import { productAttributes, productAttributeValues, products } from "@scalius/database/schema";
import { NotFoundError, ConflictError } from "../../utils/api-error";

import { ok, created, noContent } from "../../utils/api-response";
const app = new OpenAPIHono();

const createAttributeSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters long"),
    slug: z
        .string()
        .min(2, "Slug must be at least 2 characters long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
    filterable: z.boolean().default(true),
    options: z.array(z.string()).optional()
});

const updateAttributeSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters long").optional(),
    slug: z
        .string()
        .min(2, "Slug must be at least 2 characters long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format")
        .optional(),
    filterable: z.boolean().optional(),
    options: z.array(z.string()).optional().nullable()
});

const bulkActionSchema = z.object({
    ids: z.array(z.string()).min(1, "No IDs provided"),
    permanent: z.boolean().default(false)
});

const addValueSchema = z.object({
    value: z.string().min(1, "Value is required")
});

const updateValueSchema = z.object({
    oldValue: z.string().min(1, "Old value is required"),
    newValue: z.string().min(1, "New value is required")
});

const deleteValueSchema = z.object({
    value: z.string().min(1, "Value is required")
});

// ── List Attributes ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Attributes"],
    summary: "List all product attributes",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            sort: z.string().optional().default("name").openapi({ description: "Sort field" }),
            order: z.string().optional().default("asc").openapi({ description: "Sort order" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" })
        })
    },
    responses: {
        200: { description: "Attribute list with pagination"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    try {
        const query = c.req.valid("query");
        const page = query.page;
        const limit = query.limit;
        const search = query.search || "";
        const sortField = (query.sort || "name") as string;
        const sortOrder = (query.order || "asc") as "asc" | "desc";
        const showTrashed = query.trashed === "true";

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

        const attributes = await db
            .select()
            .from(productAttributes)
            .where(combinedWhereClause)
            .orderBy(
                sortOrder === "asc"
                    ? asc(productAttributes[sortField as keyof typeof productAttributes._.columns])
                    : desc(productAttributes[sortField as keyof typeof productAttributes._.columns]),
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

        const data = attributes.map((attr) => ({
            ...attr,
            valueCount: valueCountMap.get(attr.id) || 0
        }));

        return ok(c, {
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error("Error fetching attributes:", error);
        return c.json({ error: "Failed to fetch attributes" }, 500);
    }
});

// ── Create Attribute ──

const createAttributeRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Attributes"],
    summary: "Create a product attribute",
    request: {
        body: { content: { "application/json": { schema: createAttributeSchema } } }
    },
    responses: {
        201: { description: "Attribute created"  }
    }
});

app.openapi(createAttributeRoute, async (c) => {
    const db = c.get("db");
    try {
        const data = c.req.valid("json");
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

        return created(c, { data: insertedAttribute });
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "ConflictError") throw error;
        console.error("Error creating attribute:", error);
        return c.json({ error: "Failed to create attribute" }, 500);
    }
});

// ── Update Attribute ──

const updateAttributeRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Attributes"],
    summary: "Update a product attribute",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateAttributeSchema } } }
    },
    responses: {
        200: { description: "Attribute updated"  }
    }
});

app.openapi(updateAttributeRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        const data = c.req.valid("json");

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

        return ok(c, { data: updatedAttribute });
    } catch (error: unknown) {
        if (error instanceof Error && (error.name === "NotFoundError" || error.name === "ConflictError")) throw error;
        console.error(`Error updating attribute ${id}:`, error);
        return c.json({ error: "Failed to update attribute" }, 500);
    }
});

// ── Delete Attribute ──

const deleteAttributeRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Attributes"],
    summary: "Soft-delete a product attribute",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Attribute deleted" }
    }
});

app.openapi(deleteAttributeRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
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
            return c.json({ error: "Attribute in use", message: errorMessage }, 409);
        }

        await db
            .update(productAttributes)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(eq(productAttributes.id, id));

        return noContent(c);
    } catch (error) {
        console.error(`Error deleting attribute ${id}:`, error);
        return c.json({ error: "Failed to delete attribute" }, 500);
    }
});

// ── Permanent Delete Attribute ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Attributes"],
    summary: "Permanently delete a product attribute",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: { description: "Attribute permanently deleted" }
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");

    try {
        await db
            .delete(productAttributes)
            .where(eq(productAttributes.id, id));

        return noContent(c);
    } catch (error) {
        console.error(`Error permanently deleting attribute ${id}:`, error);
        return c.json({ error: "Failed to permanently delete attribute" }, 500);
    }
});

// ── Bulk Delete Attributes ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Attributes"],
    summary: "Bulk delete attributes",
    request: {
        body: { content: { "application/json": { schema: bulkActionSchema } } }
    },
    responses: {
        204: { description: "Attributes deleted" }
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    try {
        const { ids, permanent } = c.req.valid("json");
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
        return noContent(c);
    } catch (error) {
        console.error("Error bulk deleting attributes:", error);
        return c.json({ error: "Failed to bulk delete attributes" }, 500);
    }
});

// ── Bulk Restore Attributes ──

const bulkRestoreRoute = createRoute({
    method: "post",
    path: "/bulk-restore",
    tags: ["Admin - Attributes"],
    summary: "Bulk restore attributes",
    request: {
        body: { content: { "application/json": { schema: bulkActionSchema } } }
    },
    responses: {
        204: { description: "Attributes restored" }
    }
});

app.openapi(bulkRestoreRoute, async (c) => {
    const db = c.get("db");
    try {
        const { ids } = c.req.valid("json");
        await db
            .update(productAttributes)
            .set({ deletedAt: null })
            .where(inArray(productAttributes.id, ids));
        return noContent(c);
    } catch (error) {
        console.error("Error bulk restoring attributes:", error);
        return c.json({ error: "Failed to bulk restore attributes" }, 500);
    }
});

// ── List Attribute Values ──

const listValuesRoute = createRoute({
    method: "get",
    path: "/{id}/values",
    tags: ["Admin - Attributes"],
    summary: "List all unique values for an attribute",
    request: {
        params: z.object({ id: z.string() }),
        query: z.object({
            search: z.string().optional().openapi({ description: "Filter values" }),
            sort: z.string().optional().default("desc").openapi({ description: "Sort order" }),
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().default(20).openapi({ description: "Items per page" })
        })
    },
    responses: {
        200: { description: "Attribute values"  }
    }
});

app.openapi(listValuesRoute, async (c) => {
    const db = c.get("db");
    const { id: attributeId } = c.req.valid("param");
    const query = c.req.valid("query");

    try {
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

        const valueMap = new Map<string, { value: string; productCount: number; createdAt: number; isPreset: boolean; sampleProducts: string[] }>();

        for (const row of allRows) {
            const existing = valueMap.get(row.value) || {
                value: row.value,
                productCount: 0,
                createdAt: row.createdAt,
                isPreset: false,
                sampleProducts: []
            };

            existing.productCount++;
            if (new Date(row.createdAt * 1000) < new Date(existing.createdAt * 1000)) {
                existing.createdAt = row.createdAt;
            }
            if (existing.sampleProducts.length < 5) {
                existing.sampleProducts.push(row.productName);
            }
            valueMap.set(row.value, existing);
        }

        const options = (attribute.options as string[]) || [];
        for (const option of options) {
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
        if (query.search) {
            const lowerSearch = query.search.toLowerCase();
            allValues = allValues.filter((v) =>
                v.value.toLowerCase().includes(lowerSearch)
            );
        }

        const sort = query.sort || "desc";
        allValues.sort((a, b) => {
            const timeA = new Date(a.createdAt * 1000).getTime();
            const timeB = new Date(b.createdAt * 1000).getTime();
            return sort === "asc" ? timeA - timeB : timeB - timeA;
        });

        const page = query.page;
        const limit = query.limit;
        const offset = (page - 1) * limit;
        const paginatedValues = allValues.slice(offset, offset + limit);

        return ok(c, {
            attributeId,
            attributeName: attribute.name,
            values: paginatedValues,
            totalValues: allValues.length,
            page,
            totalPages: Math.ceil(allValues.length / limit)
        });
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        console.error("Error fetching attribute values:", error);
        return c.json({ error: "Failed to fetch attribute values" }, 500);
    }
});

// ── Add Attribute Value ──

const addValueRoute = createRoute({
    method: "post",
    path: "/{id}/values",
    tags: ["Admin - Attributes"],
    summary: "Add a preset value to an attribute",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: addValueSchema } } }
    },
    responses: {
        200: { description: "Value added"  }
    }
});

app.openapi(addValueRoute, async (c) => {
    const db = c.get("db");
    const { id: attributeId } = c.req.valid("param");

    try {
        const { value } = c.req.valid("json");

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

        return ok(c, { success: true });
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        return c.json({ error: "Failed" }, 500);
    }
});

// ── Update Attribute Value ──

const updateValueRoute = createRoute({
    method: "put",
    path: "/{id}/values",
    tags: ["Admin - Attributes"],
    summary: "Rename an attribute value across all products",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateValueSchema } } }
    },
    responses: {
        200: { description: "Value updated"  }
    }
});

app.openapi(updateValueRoute, async (c) => {
    const db = c.get("db");
    const { id: attributeId } = c.req.valid("param");

    try {
        const { oldValue, newValue } = c.req.valid("json");

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

        return ok(c, {
            success: true,
            message: `Value "${oldValue}" renamed to "${newValue}"`
        });
    } catch (error) {
        console.error("Error updating attribute value:", error);
        return c.json({ error: "Failed to update attribute value" }, 500);
    }
});

// ── Delete Attribute Value ──

const deleteValueRoute = createRoute({
    method: "delete",
    path: "/{id}/values",
    tags: ["Admin - Attributes"],
    summary: "Delete an attribute value from all products",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: deleteValueSchema } } }
    },
    responses: {
        200: { description: "Value deleted"  }
    }
});

app.openapi(deleteValueRoute, async (c) => {
    const db = c.get("db");
    const { id: attributeId } = c.req.valid("param");

    try {
        const { value } = c.req.valid("json");

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

        return ok(c, {
            success: true,
            message: `Value "${value}" deleted from all products`
        });
    } catch (error) {
        console.error("Error deleting attribute value:", error);
        return c.json({ error: "Failed to delete attribute value" }, 500);
    }
});

export { app as adminAttributesRoutes };
