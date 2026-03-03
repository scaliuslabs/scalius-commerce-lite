import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { orders } from "../../../../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { applyInventoryForStatusChange } from "@/modules/inventory/inventory-transitions";

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ error: "Order ID is required" }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const { status } = json;

    if (!status) {
      return new Response(
        JSON.stringify({ error: "Status is required" }),
        { status: 400 },
      );
    }

    // Read current order state for concurrency guard
    const existingOrder = await db
      .select({ status: orders.status, inventoryAction: orders.inventoryAction })
      .from(orders)
      .where(eq(orders.id, id))
      .get();

    if (!existingOrder) {
      return new Response(
        JSON.stringify({ error: "Order not found" }),
        { status: 404 },
      );
    }

    // Skip no-op updates
    if (existingOrder.status === status) {
      return new Response(
        JSON.stringify({ message: "Status unchanged" }),
        { status: 200 },
      );
    }

    // Apply inventory side-effects based on status transition (idempotent)
    const newInventoryAction = await applyInventoryForStatusChange(db, id, status);

    // Compare-and-swap: only update if status hasn't changed since we read it.
    // This prevents race conditions where two concurrent requests could both
    // trigger inventory operations (e.g. shipped + cancelled racing).
    const result = await db
      .update(orders)
      .set({
        status,
        inventoryAction: newInventoryAction,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(eq(orders.id, id), eq(orders.status, existingOrder.status)))
      .returning({ id: orders.id });

    if (result.length === 0) {
      return new Response(
        JSON.stringify({ error: "Order status was changed by another request. Please reload and try again." }),
        { status: 409 },
      );
    }

    return new Response(
      JSON.stringify({ message: "Order status updated successfully" }),
      { status: 200 },
    );
  } catch (error) {
    console.error("Error updating order status:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update order status" }),
      { status: 500 },
    );
  }
};
