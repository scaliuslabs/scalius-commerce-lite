import type { APIRoute } from "astro";
import { db } from "../../../db";
import { orders, orderItems } from "../../../db/schema";
import { sql, eq } from "drizzle-orm";
import { z } from "zod";
import { applyInventoryForStatusChange } from "@/lib/inventory/inventory-transitions";

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

    // For each order, check inventoryAction before restoring stock
    for (const orderId of data.orderIds) {
      const order = await db
        .select({ id: orders.id, inventoryAction: orders.inventoryAction })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();

      if (!order) continue;

      // Centralized inventory handling:
      //   - "reserved" → releases reservations (reservedStock--)
      //   - "deducted" (shipped) → no-op (admin must manually adjust)
      if (order.inventoryAction === "reserved" || order.inventoryAction === "deducted") {
        await applyInventoryForStatusChange(db, orderId, "cancelled");
      }
      // "restored" or "none" → no-op (nothing to undo)
    }

    if (data.permanent) {
      // Permanently delete orders
      await db.delete(orders).where(sql`${orders.id} IN ${data.orderIds}`);
      // Also delete order items
      await db
        .delete(orderItems)
        .where(sql`${orderItems.orderId} IN ${data.orderIds}`);
    } else {
      // Soft delete orders and mark inventory as restored
      await db
        .update(orders)
        .set({
          deletedAt: sql`unixepoch()`,
          inventoryAction: "restored",
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
