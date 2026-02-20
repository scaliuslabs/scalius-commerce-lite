// src/pages/api/orders/[id]/payments.ts
// Admin API: Get payment history for an order.
// GET - List all payment transactions and plan details for an order

import type { APIRoute } from "astro";
import { db } from "@/db";
import { orderPayments, paymentPlans } from "@/db/schema";
import { eq } from "drizzle-orm";

export const GET: APIRoute = async ({ params }) => {
  const { id: orderId } = params;
  if (!orderId) return Response.json({ error: "Order ID required" }, { status: 400 });

  try {
    const [payments, plan] = await Promise.all([
      db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId))
        .all(),
      db
        .select()
        .from(paymentPlans)
        .where(eq(paymentPlans.orderId, orderId))
        .get(),
    ]);

    return Response.json({ payments, plan: plan ?? null });
  } catch (error) {
    console.error("Error fetching order payments:", error);
    return Response.json({ error: "Failed to fetch payments" }, { status: 500 });
  }
};
