import type { APIRoute } from "astro";
import { db } from "../../../db";
import { orders, orderItems, productVariants } from "../../../db/schema";
import { sql, eq } from "drizzle-orm";
import { z } from "zod";

const bulkDeleteSchema = z.object({
  orderIds: z.array(z.string()),
  permanent: z.boolean().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.orderIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No order IDs provided",
        }),
        { status: 400 },
      );
    }

    // Get all order items for the orders being deleted
    const items = await db
      .select({
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(sql`${orderItems.orderId} IN ${data.orderIds}`);

    // Restore stock for all variants in the orders
    for (const item of items) {
      if (item.variantId) {
        // Update variant stock
        await db
          .update(productVariants)
          .set({
            stock: sql`${productVariants.stock} + ${item.quantity}`,
            updatedAt: sql`unixepoch()`,
          })
          .where(eq(productVariants.id, item.variantId));
      }
    }

    if (data.permanent) {
      // Permanently delete orders
      await db.delete(orders).where(sql`${orders.id} IN ${data.orderIds}`);
      // Also delete order items
      await db
        .delete(orderItems)
        .where(sql`${orderItems.orderId} IN ${data.orderIds}`);
    } else {
      // Soft delete orders
      await db
        .update(orders)
        .set({
          deletedAt: sql`unixepoch()`,
        })
        .where(sql`${orders.id} IN ${data.orderIds}`);
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting orders:", error);

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
