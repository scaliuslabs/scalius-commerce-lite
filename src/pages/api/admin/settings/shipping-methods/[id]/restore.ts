import type { APIRoute } from "astro";
import { db } from "@/db";
import { shippingMethods } from "@/db/schema";
import { sql, eq, and } from "drizzle-orm";

// POST: Restore a soft-deleted shipping method
export const POST: APIRoute = async ({ params }) => {
  const id = params.id;
  if (!id) {
    return new Response(
      JSON.stringify({ error: "ID is required for restore" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    // Check if the method exists and is soft-deleted
    const methodToRestore = await db
      .select({
        id: shippingMethods.id,
        deletedAt: shippingMethods.deletedAt,
      })
      .from(shippingMethods)
      .where(
        and(
          eq(shippingMethods.id, id),
          sql`${shippingMethods.deletedAt} IS NOT NULL`,
        ),
      )
      .get();

    if (!methodToRestore) {
      return new Response(
        JSON.stringify({ error: "Shipping method not found or not deleted" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Restore the shipping method by setting deletedAt to null
    await db
      .update(shippingMethods)
      .set({
        deletedAt: null,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .where(eq(shippingMethods.id, id));

    return new Response(
      JSON.stringify({ message: "Shipping method restored successfully" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error(`Error restoring shipping method ${id}:`, error);
    return new Response(
      JSON.stringify({ error: "Failed to restore shipping method" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// PUT: Alternative method for restore (some clients prefer PUT for state changes)
export const PUT: APIRoute = POST;
