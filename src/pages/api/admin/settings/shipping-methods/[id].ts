import type { APIRoute } from "astro";
import { db } from "@/db";
import { shippingMethods } from "@/db/schema";
import { sql, eq, and, isNull } from "drizzle-orm";
import { z } from "zod";

// Zod schema for updating a shipping method
const updateShippingMethodSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).optional(),
  fee: z.number().min(0, "Fee must be a positive number").optional(),
  description: z.string().max(255).optional().nullable(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// GET: Fetch a specific shipping method by ID
export const GET: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    const method = await db
      .select()
      .from(shippingMethods)
      .where(and(eq(shippingMethods.id, id), isNull(shippingMethods.deletedAt)))
      .get();

    if (!method) {
      return new Response(
        JSON.stringify({ error: "Shipping method not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify({ data: method }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`Error fetching shipping method ${id}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch shipping method" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// PUT: Update a specific shipping method
export const PUT: APIRoute = async ({ params, request }) => {
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    const body = await request.json();
    const validation = updateShippingMethodSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const currentMethod = await db
      .select()
      .from(shippingMethods)
      .where(eq(shippingMethods.id, id))
      .get();
    if (!currentMethod) {
      return new Response(
        JSON.stringify({ error: "Shipping method not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    // If name is being changed, check if the new name already exists (and is not deleted)
    if (validation.data.name && validation.data.name !== currentMethod.name) {
      const existingMethodWithName = await db
        .select()
        .from(shippingMethods)
        .where(
          and(
            eq(shippingMethods.name, validation.data.name),
            isNull(shippingMethods.deletedAt),
            eq(shippingMethods.id, id),
          ),
        )
        .get();
      if (existingMethodWithName) {
        return new Response(
          JSON.stringify({
            error: "A shipping method with this name already exists.",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const [updatedMethod] = await db
      .update(shippingMethods)
      .set({
        ...validation.data,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(eq(shippingMethods.id, id))
      .returning();

    if (!updatedMethod) {
      return new Response(
        JSON.stringify({
          error: "Shipping method not found or no changes made",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ data: updatedMethod }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`Error updating shipping method ${id}:`, error);
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
      JSON.stringify({ error: "Failed to update shipping method" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// DELETE: Soft delete a shipping method
export const DELETE: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "ID is required" }), {
      status: 400,
    });
  }

  try {
    const existingMethod = await db
      .select({ id: shippingMethods.id })
      .from(shippingMethods)
      .where(and(eq(shippingMethods.id, id), isNull(shippingMethods.deletedAt)))
      .get();

    if (!existingMethod) {
      return new Response(
        JSON.stringify({
          error: "Shipping method not found or already deleted",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    await db
      .update(shippingMethods)
      .set({ deletedAt: sql`(cast(strftime('%s','now') as int))` })
      .where(eq(shippingMethods.id, id));

    return new Response(null, { status: 204 }); // No content
  } catch (error) {
    console.error(`Error deleting shipping method ${id}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to delete shipping method" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// Note: POST endpoint for restore has been moved to [id]/restore.ts for cleaner routing
