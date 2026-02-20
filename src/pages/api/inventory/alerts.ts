// src/pages/api/inventory/alerts.ts
// Admin API: Low stock alerts management.
//
// GET   - List active/all low stock alerts
// PATCH - Acknowledge an alert (mark as seen)

import type { APIRoute } from "astro";
import { db } from "@/db";
import { productLowStockAlerts, productVariants, products } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { acknowledgeLowStockAlert } from "@/lib/inventory/alerts";

export const GET: APIRoute = async ({ url }) => {
  try {
    const status = url.searchParams.get("status") ?? "active";

    const alerts = await db
      .select({
        id: productLowStockAlerts.id,
        variantId: productLowStockAlerts.variantId,
        productId: productLowStockAlerts.productId,
        currentQty: productLowStockAlerts.currentQty,
        threshold: productLowStockAlerts.threshold,
        alertStatus: productLowStockAlerts.alertStatus,
        alertSentAt: productLowStockAlerts.alertSentAt,
        acknowledgedAt: productLowStockAlerts.acknowledgedAt,
        resolvedAt: productLowStockAlerts.resolvedAt,
        // Join product name for display
        productName: products.name,
        // Join variant details
        variantSku: productVariants.sku,
        variantSize: productVariants.size,
        variantColor: productVariants.color,
      })
      .from(productLowStockAlerts)
      .leftJoin(products, eq(products.id, productLowStockAlerts.productId))
      .leftJoin(productVariants, eq(productVariants.id, productLowStockAlerts.variantId))
      .where(
        status === "all"
          ? sql`1=1`
          : eq(productLowStockAlerts.alertStatus, status)
      )
      .all();

    return Response.json({ alerts });
  } catch (error) {
    console.error("Error fetching low stock alerts:", error);
    return Response.json({ error: "Failed to fetch alerts" }, { status: 500 });
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as { variantId: string };
    if (!body.variantId) {
      return Response.json({ error: "variantId is required" }, { status: 400 });
    }

    await acknowledgeLowStockAlert(db, body.variantId);
    return Response.json({ success: true });
  } catch (error) {
    console.error("Error acknowledging alert:", error);
    return Response.json({ error: "Failed to acknowledge alert" }, { status: 500 });
  }
};
