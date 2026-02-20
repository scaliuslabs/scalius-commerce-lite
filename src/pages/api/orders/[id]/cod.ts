// src/pages/api/orders/[id]/cod.ts
// Admin API: COD (Cash on Delivery) collection and failure management.
//
// GET    - Get COD tracking status for an order
// POST   - Record a COD collection or failure

import type { APIRoute } from "astro";
import { db } from "@/db";
import { codTracking, orders, OrderStatus, PaymentStatus } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  recordCODCollection,
  recordCODFailure,
  markCODReturned,
} from "@/lib/payment/cod";

export const GET: APIRoute = async ({ params }) => {
  const { id: orderId } = params;
  if (!orderId) return Response.json({ error: "Order ID required" }, { status: 400 });

  try {
    const tracking = await db
      .select()
      .from(codTracking)
      .where(eq(codTracking.orderId, orderId))
      .get();

    return Response.json({ tracking: tracking ?? null });
  } catch (error) {
    console.error("Error fetching COD tracking:", error);
    return Response.json({ error: "Failed to fetch COD tracking" }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  const { id: orderId } = params;
  if (!orderId) return Response.json({ error: "Order ID required" }, { status: 400 });

  try {
    const body = await request.json() as {
      action: "collected" | "failed" | "returned";
      // Required for "collected"
      collectedBy?: string;
      collectedAmount?: number;
      receiptUrl?: string;
      // Required for "failed"
      reason?: "not_home" | "refused" | "no_cash" | "wrong_address" | "other";
      notes?: string;
    };

    if (!body.action) {
      return Response.json({ error: "action is required" }, { status: 400 });
    }

    switch (body.action) {
      case "collected": {
        if (!body.collectedBy || !body.collectedAmount) {
          return Response.json(
            { error: "collectedBy and collectedAmount are required for collection" },
            { status: 400 }
          );
        }
        const result = await recordCODCollection(db, {
          orderId,
          collectedBy: body.collectedBy,
          collectedAmount: body.collectedAmount,
          receiptUrl: body.receiptUrl,
        });
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 500 });
        }
        // Also update order status to delivered
        await db
          .update(orders)
          .set({ status: OrderStatus.DELIVERED, updatedAt: sql`unixepoch()` })
          .where(eq(orders.id, orderId));
        return Response.json({ success: true, message: "COD collection recorded" });
      }

      case "failed": {
        if (!body.reason) {
          return Response.json({ error: "reason is required for failed delivery" }, { status: 400 });
        }
        const result = await recordCODFailure(db, {
          orderId,
          reason: body.reason,
          notes: body.notes,
        });
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 500 });
        }
        return Response.json({ success: true, message: "COD failure recorded" });
      }

      case "returned": {
        const result = await markCODReturned(db, orderId);
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 500 });
        }
        await db
          .update(orders)
          .set({ status: OrderStatus.RETURNED, updatedAt: sql`unixepoch()` })
          .where(eq(orders.id, orderId));
        return Response.json({ success: true, message: "Order marked as returned" });
      }

      default:
        return Response.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Error processing COD action:", error);
    return Response.json({ error: "Failed to process COD action" }, { status: 500 });
  }
};
