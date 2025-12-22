import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { orders } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Order ID is required",
        }),
        { status: 400 }
      );
    }

    // Restore order
    await db
      .update(orders)
      .set({
        deletedAt: null,
      })
      .where(eq(orders.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error restoring order:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 }
    );
  }
}; 