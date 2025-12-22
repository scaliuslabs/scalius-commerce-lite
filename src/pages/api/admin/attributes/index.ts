// src/pages/api/admin/attributes/index.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import { productAttributes, productAttributeValues } from "@/db/schema";
import { nanoid } from "nanoid";
import { sql, eq, and, or, like, asc, desc, count, inArray } from "drizzle-orm";
import { z } from "zod";

const createAttributeSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters long"),
  slug: z
    .string()
    .min(2, "Slug must be at least 2 characters long")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  filterable: z.boolean().default(true),
  options: z.array(z.string()).optional(), // Predefined values for this attribute
});

// GET: List all product attributes
export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const search = searchParams.get("search") || "";
    const sortField = (searchParams.get("sort") || "name") as
      | "name"
      | "slug"
      | "filterable"
      | "updatedAt";
    const sortOrder = (searchParams.get("order") || "asc") as "asc" | "desc";
    const showTrashed = searchParams.get("trashed") === "true";

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

    // Get total count for pagination
    const totalResult = await db
      .select({ count: count(productAttributes.id) })
      .from(productAttributes)
      .where(combinedWhereClause)
      .get();

    const total = totalResult?.count ?? 0;

    // Get paginated attributes
    const attributes = await db
      .select()
      .from(productAttributes)
      .where(combinedWhereClause)
      .orderBy(
        sortOrder === "asc"
          ? asc(productAttributes[sortField])
          : desc(productAttributes[sortField]),
      )
      .limit(limit)
      .offset(offset);

    // Get count of unique values for each attribute
    const attributeIds = attributes.map((attr) => attr.id);
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
      valueCounts.map((item) => [item.attributeId, item.valueCount]),
    );

    const data = attributes.map((attr) => ({
      ...attr,
      valueCount: valueCountMap.get(attr.id) || 0,
    }));

    return new Response(
      JSON.stringify({
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching attributes:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch attributes" }),
      { status: 500 },
    );
  }
};

// POST: Create a new product attribute
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const validation = createAttributeSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        { status: 400 },
      );
    }

    const { name, slug, filterable, options } = validation.data;

    // Check for uniqueness of name and slug
    const existingAttribute = await db
      .select()
      .from(productAttributes)
      .where(
        or(eq(productAttributes.name, name), eq(productAttributes.slug, slug)),
      )
      .get();

    if (existingAttribute) {
      return new Response(
        JSON.stringify({
          error: `An attribute with that name or slug already exists.`,
        }),
        { status: 409 },
      );
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

    return new Response(JSON.stringify({ data: insertedAttribute }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating attribute:", error);
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Invalid data", details: error.errors }),
        { status: 400 },
      );
    }
    return new Response(
      JSON.stringify({ error: "Failed to create attribute" }),
      { status: 500 },
    );
  }
};
