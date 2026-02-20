import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { discounts } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";

export const POST: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ error: "Discount ID is required" }),
        { status: 400 },
      );
    }

    // Check if discount exists and is deleted
    const discount = await db
      .select()
      .from(discounts)
      .where(eq(discounts.id, id))
      .get();
    if (!discount) {
      return new Response(JSON.stringify({ error: "Discount not found" }), {
        status: 404,
      });
    }
    if (!discount.deletedAt) {
      return new Response(
        JSON.stringify({ error: "Discount is not deleted" }),
        { status: 400 },
      );
    }

    // Restore discount
    await db
      .update(discounts)
      .set({ deletedAt: null, updatedAt: sql`unixepoch()` })
      .where(eq(discounts.id, id));

    // Get the updated (restored) discount data
    const restoredDiscount = await db
      .select()
      .from(discounts)
      .where(eq(discounts.id, id))
      .get();

    // Handle search index updates if necessary

    // Format dates for consistent API response
    const formattedDiscount = restoredDiscount
      ? {
          ...restoredDiscount,
          createdAt: restoredDiscount.createdAt
            ? new Date(Number(restoredDiscount.createdAt) * 1000).toISOString()
            : null,
          updatedAt: restoredDiscount.updatedAt
            ? new Date(Number(restoredDiscount.updatedAt) * 1000).toISOString()
            : null,
          deletedAt: null, // Explicitly set to null as it's restored
          startDate: restoredDiscount.startDate
            ? new Date(Number(restoredDiscount.startDate) * 1000).toISOString()
            : null,
          endDate: restoredDiscount.endDate
            ? new Date(Number(restoredDiscount.endDate) * 1000).toISOString()
            : null,
        }
      : null;

    return new Response(
      JSON.stringify({ success: true, discount: formattedDiscount }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error restoring discount:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
};
