import type { APIRoute } from "astro";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { isNull, isNotNull, max, like, and, asc, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

const createCollectionSchema = z.object({
  name: z
    .string()
    .min(3, "Collection name must be at least 3 characters")
    .max(100, "Collection name must be less than 100 characters"),
  type: z.enum(["collection1", "collection2"]),
  isActive: z.boolean(),
  config: z.object({
    categoryIds: z.array(z.string()).optional().default([]),
    productIds: z.array(z.string()).optional().default([]),
    featuredProductId: z.string().optional(),
    maxProducts: z.number().int().min(1).max(24).optional().default(8),
    title: z.string().optional(),
    subtitle: z.string().optional(),
  }),
});

export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const search = searchParams.get("search") || "";
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const trashed = searchParams.get("trashed") === "true";
    const sort = searchParams.get("sort") || "sortOrder";
    const order = searchParams.get("order") || "asc";

    const offset = (page - 1) * limit;

    // Build where conditions
    const whereConditions = [];
    if (trashed) {
      whereConditions.push(isNotNull(collections.deletedAt));
    } else {
      whereConditions.push(isNull(collections.deletedAt));
    }

    if (search) {
      whereConditions.push(like(collections.name, `%${search}%`));
    }

    // Get total count
    const totalResult = await db
      .select({ count: sql`count(*)` })
      .from(collections)
      .where(and(...whereConditions))
      .then((rows) => rows[0]);

    const total = Number(totalResult?.count || 0);

    // Determine sort column
    let sortColumn;
    switch (sort) {
      case "name":
        sortColumn = collections.name;
        break;
      case "type":
        sortColumn = collections.type;
        break;
      case "isActive":
        sortColumn = collections.isActive;
        break;
      case "updatedAt":
        sortColumn = collections.updatedAt;
        break;
      default:
        sortColumn = collections.sortOrder;
    }

    const sortFn = order === "desc" ? desc : asc;

    // Fetch collections with pagination
    const allCollections = await db
      .select()
      .from(collections)
      .where(and(...whereConditions))
      .orderBy(sortFn(sortColumn))
      .limit(limit)
      .offset(offset);

    return new Response(
      JSON.stringify({
        data: allCollections,
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
    console.error("Error fetching collections:", error);
    return new Response(
      JSON.stringify({ error: "Error fetching collections" }),
      { status: 500 },
    );
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createCollectionSchema.parse(json);

    // Get the maximum sort order
    const maxSortOrder = await db
      .select({ max: max(collections.sortOrder) })
      .from(collections)
      .where(isNull(collections.deletedAt))
      .then((result) => (result[0]?.max ?? -1) + 1);

    const collection = await db
      .insert(collections)
      .values({
        id: nanoid(),
        name: data.name,
        type: data.type,
        isActive: data.isActive,
        sortOrder: maxSortOrder,
        config: JSON.stringify(data.config),
      })
      .returning()
      .get();

    return new Response(JSON.stringify(collection), {
      status: 201,
    });
  } catch (error) {
    console.error("Error creating collection:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ message: "Error creating collection" }),
      { status: 500 },
    );
  }
};
