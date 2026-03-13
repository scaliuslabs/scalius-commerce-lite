// src/server/routes/admin/attributes.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { sql, eq, and, or, like, asc, desc, count, inArray, isNull } from "drizzle-orm";
import { productAttributes, productAttributeValues, products } from "@scalius/database/schema";

const app = new Hono<{
    Variables: {
        db: any;
    };
}>();

const createAttributeSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters long"),
    slug: z
        .string()
        .min(2, "Slug must be at least 2 characters long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
    filterable: z.boolean().default(true),
    options: z.array(z.string()).optional(),
});

const updateAttributeSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters long").optional(),
    slug: z
        .string()
        .min(2, "Slug must be at least 2 characters long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format")
        .optional(),
    filterable: z.boolean().optional(),
    options: z.array(z.string()).optional().nullable(),
});

app.get("/", async (c) => {
    const db = c.get("db");
    try {
        const page = parseInt(c.req.query("page") || "1");
        const limit = parseInt(c.req.query("limit") || "10");
        const search = c.req.query("search") || "";
        const sortField = (c.req.query("sort") || "name") as any;
        const sortOrder = (c.req.query("order") || "asc") as "asc" | "desc";
        const showTrashed = c.req.query("trashed") === "true";

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

        const attributeIds = attributes.map((attr: any) => attr.id);
        const valueCounts =
            attributeIds.length > 0
                ? await db
                    .select({
                        attributeId: productAttributeValues.attributeId,
                        valueCount: count(sql`DISTINCT ${productAttributeValues.value}`),
                    })
                    .from(productAttributeValues)
                    .where(inArray(productAttributeValues.attributeId, attributeIds))
                    .groupBy(productAttributeValues.attributeId)
                    .all()
                : [];

        const valueCountMap = new Map(
            valueCounts.map((item: any) => [item.attributeId, item.valueCount]),
        );

        const data = attributes.map((attr: any) => ({
            ...attr,
            valueCount: valueCountMap.get(attr.id) || 0,
        }));

        return c.json({
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error("Error fetching attributes:", error);
        return c.json({ error: "Failed to fetch attributes" }, 500);
    }
});

app.post("/", zValidator("json", createAttributeSchema), async (c) => {
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
            return c.json({ error: "An attribute with that name or slug already exists." }, 409);
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
                updatedAt: sql`(cast(strftime('%s','now') as int))`,
            })
            .returning();

        return c.json({ data: insertedAttribute }, 201);
    } catch (error: any) {
        console.error("Error creating attribute:", error);
        return c.json({ error: "Failed to create attribute" }, 500);
    }
});

app.put("/:id", zValidator("json", updateAttributeSchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

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
                return c.json({ error: "An attribute with that name or slug already exists." }, 409);
            }
        }

        const [updatedAttribute] = await db
            .update(productAttributes)
            .set({
                ...data,
                updatedAt: sql`(cast(strftime('%s','now') as int))`,
            })
            .where(eq(productAttributes.id, id))
            .returning();

        if (!updatedAttribute) {
            return c.json({ error: "Attribute not found" }, 404);
        }

        return c.json({ data: updatedAttribute }, 200);
    } catch (error) {
        console.error(`Error updating attribute ${id}:`, error);
        return c.json({ error: "Failed to update attribute" }, 500);
    }
});

app.delete("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    try {
        const usage = await db
            .select({
                productName: products.name,
                productId: products.id,
            })
            .from(productAttributeValues)
            .leftJoin(products, eq(productAttributeValues.productId, products.id))
            .where(eq(productAttributeValues.attributeId, id))
            .limit(5);

        if (usage.length > 0) {
            const productNames = usage.map((p: any) => p.productName).join(", ");
            const errorMessage = `Cannot delete. Attribute is used by ${usage.length}${usage.length < 5 ? "" : "+"} product(s), including: ${productNames}.`;

            return c.json({ error: "Attribute in use", message: errorMessage }, 409);
        }

        await db
            .update(productAttributes)
            .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
            .where(eq(productAttributes.id, id));

        return new Response(null, { status: 204 });
    } catch (error) {
        console.error(`Error deleting attribute ${id}:`, error);
        return c.json({ error: "Failed to delete attribute" }, 500);
    }
});

app.delete("/:id/permanent", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    try {
        await db
            .delete(productAttributes)
            .where(eq(productAttributes.id, id));

        return new Response(null, { status: 204 });
    } catch (error) {
        console.error(`Error permanently deleting attribute ${id}:`, error);
        return c.json({ error: "Failed to permanently delete attribute" }, 500);
    }
});

const bulkActionSchema = z.object({
    ids: z.array(z.string()).min(1, "No IDs provided"),
    permanent: z.boolean().default(false),
});

app.post("/bulk-delete", zValidator("json", bulkActionSchema), async (c) => {
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
        return new Response(null, { status: 204 });
    } catch (error) {
        console.error("Error bulk deleting attributes:", error);
        return c.json({ error: "Failed to bulk delete attributes" }, 500);
    }
});

app.post("/bulk-restore", zValidator("json", bulkActionSchema), async (c) => {
    const db = c.get("db");
    try {
        const { ids } = c.req.valid("json");
        await db
            .update(productAttributes)
            .set({ deletedAt: null })
            .where(inArray(productAttributes.id, ids));
        return new Response(null, { status: 204 });
    } catch (error) {
        console.error("Error bulk restoring attributes:", error);
        return c.json({ error: "Failed to bulk restore attributes" }, 500);
    }
});

// GET: List all unique values for an attribute with product counts
app.get("/:id/values", async (c) => {
    const db = c.get("db");
    const attributeId = c.req.param("id");

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

        if (!attribute) {
            return c.json({ error: "Attribute not found" }, 404);
        }

        const allRows = await db
            .select({
                value: productAttributeValues.value,
                createdAt: productAttributeValues.createdAt, // We want oldest
                productName: products.name,
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

        const valueMap = new Map<string, any>();

        for (const row of allRows) {
            const existing = valueMap.get(row.value) || {
                value: row.value,
                productCount: 0,
                createdAt: row.createdAt,
                isPreset: false,
                sampleProducts: [],
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
                    sampleProducts: [],
                });
            }
        }

        let allValues = Array.from(valueMap.values());
        const search = c.req.query("search");
        if (search) {
            const lowerSearch = search.toLowerCase();
            allValues = allValues.filter((v) =>
                v.value.toLowerCase().includes(lowerSearch)
            );
        }

        const sort = c.req.query("sort") || "desc";
        allValues.sort((a, b) => {
            const timeA = new Date(a.createdAt * 1000).getTime();
            const timeB = new Date(b.createdAt * 1000).getTime();
            return sort === "asc" ? timeA - timeB : timeB - timeA;
        });

        const page = parseInt(c.req.query("page") || "1");
        const limit = parseInt(c.req.query("limit") || "20");
        const offset = (page - 1) * limit;
        const paginatedValues = allValues.slice(offset, offset + limit);

        return c.json({
            attributeId,
            attributeName: attribute.name,
            values: paginatedValues,
            totalValues: allValues.length,
            page,
            totalPages: Math.ceil(allValues.length / limit),
        });
    } catch (error) {
        console.error("Error fetching attribute values:", error);
        return c.json({ error: "Failed to fetch attribute values" }, 500);
    }
});

const addValueSchema = z.object({
    value: z.string().min(1, "Value is required"),
});

app.post("/:id/values", zValidator("json", addValueSchema), async (c) => {
    const db = c.get("db");
    const attributeId = c.req.param("id");

    try {
        const { value } = c.req.valid("json");

        const attribute = await db
            .select()
            .from(productAttributes)
            .where(eq(productAttributes.id, attributeId))
            .get();

        if (!attribute) return c.json({ error: "Attribute not found" }, 404);

        const currentOptions = (attribute.options as string[]) || [];
        if (!currentOptions.includes(value)) {
            const newOptions = [...currentOptions, value];
            await db
                .update(productAttributes)
                .set({ options: newOptions })
                .where(eq(productAttributes.id, attributeId));
        }

        return c.json({ success: true }, 200);
    } catch (error) {
        return c.json({ error: "Failed" }, 500);
    }
});

const updateValueSchema = z.object({
    oldValue: z.string().min(1, "Old value is required"),
    newValue: z.string().min(1, "New value is required"),
});

app.put("/:id/values", zValidator("json", updateValueSchema), async (c) => {
    const db = c.get("db");
    const attributeId = c.req.param("id");

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

        return c.json({
            success: true,
            message: `Value "${oldValue}" renamed to "${newValue}"`,
        }, 200);
    } catch (error) {
        console.error("Error updating attribute value:", error);
        return c.json({ error: "Failed to update attribute value" }, 500);
    }
});

const deleteValueSchema = z.object({
    value: z.string().min(1, "Value is required"),
});

app.delete("/:id/values", zValidator("json", deleteValueSchema), async (c) => {
    const db = c.get("db");
    const attributeId = c.req.param("id");

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

        return c.json({
            success: true,
            message: `Value "${value}" deleted from all products`,
        }, 200);
    } catch (error) {
        console.error("Error deleting attribute value:", error);
        return c.json({ error: "Failed to delete attribute value" }, 500);
    }
});

export { app as adminAttributesRoutes };
