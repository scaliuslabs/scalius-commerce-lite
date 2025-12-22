
import type { APIRoute } from "astro";
import { db } from "@/db";
import { shippingMethods } from "@/db/schema";
import { nanoid } from "nanoid";
import { sql, eq, and, or, isNull, like, asc, desc } from "drizzle-orm";
import { z } from "zod";

// Zod schema for creating a shipping method
const createShippingMethodSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  fee: z.number().min(0, "Fee must be a positive number"),
  description: z.string().max(255).optional().nullable(),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
});

// GET: List all shipping methods
export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const search = searchParams.get("search") || "";
    const sortField = (searchParams.get("sort") || "sortOrder") as
      | "name"
      | "fee"
      | "isActive"
      | "sortOrder"
      | "createdAt"
      | "updatedAt";
    const sortOrder = (searchParams.get("order") || "asc") as "asc" | "desc";
    const showTrashed = searchParams.get("trashed") === "true";

    const offset = (page - 1) * limit;

    const whereConditions = [];
    if (showTrashed) {
      whereConditions.push(sql`${shippingMethods.deletedAt} IS NOT NULL`);
    } else {
      whereConditions.push(sql`${shippingMethods.deletedAt} IS NULL`);
    }

    if (search) {
      whereConditions.push(
        or(
          like(shippingMethods.name, `%${search}%`),
          like(shippingMethods.description, `%${search}%`),
        ),
      );
    }

    const combinedWhereClause =
      whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const results = await db
      .select()
      .from(shippingMethods)
      .where(combinedWhereClause)
      .orderBy(
        sortOrder === "asc"
          ? asc(shippingMethods[sortField])
          : desc(shippingMethods[sortField]),
      )
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(shippingMethods)
      .where(combinedWhereClause)
      .get();

    const total = countResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    return new Response(
      JSON.stringify({
        data: results,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching shipping methods:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch shipping methods" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

// POST: Create a new shipping method
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const validation = createShippingMethodSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { name, fee, description, isActive, sortOrder } = validation.data;

    // Check if name already exists (and is not deleted)
    const existingMethod = await db
      .select()
      .from(shippingMethods)
      .where(
        and(eq(shippingMethods.name, name), isNull(shippingMethods.deletedAt)),
      )
      .get();
    if (existingMethod) {
      return new Response(
        JSON.stringify({
          error: "A shipping method with this name already exists.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const newMethodId = "sm_" + nanoid();
    const [insertedMethod] = await db
      .insert(shippingMethods)
      .values({
        id: newMethodId,
        name,
        fee,
        description,
        isActive,
        sortOrder,
        createdAt: sql`(cast(strftime('%s','now') as int))`,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .returning();

    return new Response(JSON.stringify({ data: insertedMethod }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating shipping method:", error);
    // Check for unique constraint violation on name (SQLite specific)
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: shipping_methods.name")
    ) {
      return new Response(
        JSON.stringify({
          error: "A shipping method with this name already exists.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "Failed to create shipping method" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
