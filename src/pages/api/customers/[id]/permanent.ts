import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { customers, customerHistory, orders } from "../../../../db/schema";
import { eq, inArray } from "drizzle-orm";

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Customer ID is required",
        }),
        { status: 400 },
      );
    }

    await db.batch([
      db.update(orders).set({ customerId: null }).where(eq(orders.customerId, id)),
      db.delete(customerHistory).where(eq(customerHistory.customerId, id)),
      db.delete(customers).where(eq(customers.id, id)),
    ]);

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error permanently deleting customer:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
