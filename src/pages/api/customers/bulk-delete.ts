import type { APIRoute } from "astro";
import { db } from "../../../db";
import { customers, customerHistory, orders } from "../../../db/schema";
import { sql, inArray } from "drizzle-orm";
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

    if (data.permanent) {
      await db.batch([
        db.update(orders).set({ customerId: null }).where(inArray(orders.customerId, data.customerIds)),
        db.delete(customerHistory).where(inArray(customerHistory.customerId, data.customerIds)),
        db.delete(customers).where(inArray(customers.id, data.customerIds)),
      ]);
    } else {
      // Soft delete customers
      await db
        .update(customers)
        .set({ deletedAt: sql`unixepoch()` })
        .where(inArray(customers.id, data.customerIds));
    }

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
