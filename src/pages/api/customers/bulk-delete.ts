import type { APIRoute } from "astro";
import { db } from "../../../db";
import { customers, customerHistory, orders } from "../../../db/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";

const bulkDeleteSchema = z.object({
  customerIds: z.array(z.string()),
  permanent: z.boolean().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.customerIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No customer IDs provided",
        }),
        { status: 400 },
      );
    }

    // Start a transaction
    await db.transaction(async (tx) => {
      if (data.permanent) {
        // First update orders to remove customer references
        await tx
          .update(orders)
          .set({ customerId: null })
          .where(sql`${orders.customerId} IN ${data.customerIds}`);

        // Delete customer history
        await tx
          .delete(customerHistory)
          .where(sql`${customerHistory.customerId} IN ${data.customerIds}`);

        // Finally delete customers
        await tx
          .delete(customers)
          .where(sql`${customers.id} IN ${data.customerIds}`);
      } else {
        // Soft delete customers
        await tx
          .update(customers)
          .set({
            deletedAt: sql`unixepoch()`,
          })
          .where(sql`${customers.id} IN ${data.customerIds}`);
      }
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting customers:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid request data",
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
