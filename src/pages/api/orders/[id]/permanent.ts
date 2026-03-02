import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { orders, orderItems } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { applyInventoryForStatusChange } from "@/lib/inventory/inventory-transitions";

export const DELETE: APIRoute = async ({ params }) => {
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

    // Handle inventory before permanent deletion
    const orderToDelete = await db
      .select({ inventoryAction: orders.inventoryAction })
      .from(orders)
      .where(eq(orders.id, id))
      .get();

    if (orderToDelete && (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted")) {
      await applyInventoryForStatusChange(db, id, "cancelled");
    }

    // Delete order items first (foreign key constraint)
    await db.delete(orderItems).where(eq(orderItems.orderId, id));

    // Delete order
    await db.delete(orders).where(eq(orders.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error permanently deleting order:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 }
    );
  }
}; 