import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { orders } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Order ID is required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const { status } = json;

    if (!status) {
      return new Response(
        JSON.stringify({
          error: "Status is required",
        }),
        { status: 400 },
      );
    }

    // Update order status
    await db
      .update(orders)
      .set({
        status,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, id));

    return new Response(
      JSON.stringify({
        message: "Order status updated successfully",
      }),
      { status: 200 },
    );
  } catch (error) {
    console.error("Error updating order status:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to update order status",
      }),
      { status: 500 },
    );
  }
};
