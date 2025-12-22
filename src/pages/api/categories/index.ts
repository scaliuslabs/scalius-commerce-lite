import type { APIRoute, APIContext } from "astro";
import { db } from "../../../db";
import { categories, products } from "../../../db/schema";
import { nanoid } from "nanoid";
import { sql, and, isNull, isNotNull, eq, desc, asc } from "drizzle-orm";
import { z } from "zod";
import { triggerReindex } from "@/lib/search/index";

const createCategorySchema = z.object({
  name: z
    .string()
    .min(3, "Category name must be at least 3 characters")
    .max(100, "Category name must be less than 100 characters"),
  description: z.string().nullable(),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  image: z
    .object({
      id: z.string(),
      url: z.string(),
      filename: z.string(),
      size: z.number(),
      createdAt: z
        .date()
        .or(z.string())
        .transform((val) => (val instanceof Date ? val : new Date(val))),
    })
    .nullable(),
});

export const GET: APIRoute = async ({ request }: APIContext) => {
  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "10");
    const search = url.searchParams.get("search") || "";
    const showTrashed = url.searchParams.get("trashed") === "true";
    const sort = url.searchParams.get("sort") || "updatedAt";
    const order = url.searchParams.get("order") || "desc";

    // Build where conditions
    const whereConditions = [];

    if (showTrashed) {
      // Show only trashed items
      whereConditions.push(isNotNull(categories.deletedAt));
    } else {
      // Show only non-trashed items
      whereConditions.push(isNull(categories.deletedAt));
    }

    if (search) {
      whereConditions.push(
        sql`(${categories.name} LIKE ${`%${search}%`} OR ${
          categories.description
        } LIKE ${`%${search}%`})`,
      );
    }

    // Get total count for pagination
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(categories)
      .where(whereConditions.length > 0 ? and(...whereConditions) : undefined);

    // Calculate pagination
    const offset = (page - 1) * limit;

    // Get paginated results with proper timestamp handling
    const results = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        description: categories.description,
        imageUrl: categories.imageUrl,
        metaTitle: categories.metaTitle,
        metaDescription: categories.metaDescription,
        createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
        updatedAt: sql<number>`CAST(${categories.updatedAt} AS INTEGER)`,
        deletedAt: sql<number>`CAST(${categories.deletedAt} AS INTEGER)`,
      })
      .from(categories)
      .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
      .limit(limit)
      .offset(offset)
      .orderBy(
        (() => {
          const sortField = (() => {
            switch (sort) {
              case "name":
                return categories.name;
              case "createdAt":
                return categories.createdAt;
              case "updatedAt":
              default:
                return categories.updatedAt;
            }
          })();
          return order === "asc" ? asc(sortField) : desc(sortField);
        })(),
      );

    // Get product counts for these categories in a separate query
    const productCounts = await db
      .select({
        categoryId: products.categoryId,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(products)
      .where(and(isNull(products.deletedAt), eq(products.isActive, true)))
      .groupBy(products.categoryId);

    // Create a map of category ID to product count
    const countMap = new Map(
      productCounts.map(({ categoryId, count }) => [categoryId, Number(count)]),
    );

    // Format dates and add product counts
    const formattedCategories = results.map((category) => ({
      ...category,
      createdAt: category.createdAt
        ? new Date(category.createdAt * 1000).toISOString()
        : null,
      updatedAt: category.updatedAt
        ? new Date(category.updatedAt * 1000).toISOString()
        : null,
      deletedAt: category.deletedAt
        ? new Date(category.deletedAt * 1000).toISOString()
        : null,
      productCount: countMap.get(category.id) || 0,
    }));

    return new Response(
      JSON.stringify({
        categories: formattedCategories,
        pagination: {
          total: count,
          page,
          limit,
          totalPages: Math.ceil(count / limit),
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error fetching categories:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createCategorySchema.parse(json);

    // Check if slug is unique
    const existingCategory = await db
      .select({ id: categories.id })
      .from(categories)
      .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
      .get();

    if (existingCategory) {
      return new Response(
        JSON.stringify({
          error: "A category with this slug already exists",
        }),
        { status: 400 },
      );
    }

    const categoryId = "cat_" + nanoid();

    // Create category
    const [_] = await db
      .insert(categories)
      .values({
        id: categoryId,
        name: data.name,
        description: data.description || null,
        slug: data.slug,
        imageUrl: data.image?.url || null,
        metaTitle: data.metaTitle || null,
        metaDescription: data.metaDescription || null,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        deletedAt: null,
      })
      .returning();

    // Trigger reindexing in the background
    // We don't await this to avoid delaying the response
    triggerReindex().catch((error) => {
      console.error(
        "Background reindexing failed after category creation:",
        error,
      );
    });

    return new Response(JSON.stringify({ id: categoryId }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error creating category:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid category data",
          details: error.errors,
        }),
        { status: 400 },
      );
    }

    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
