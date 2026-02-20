// src/pages/api/inventory/[variantId]/adjust.ts
// Admin API: Manually adjust stock for a variant (receive stock, correct count, write-off).
//
// POST - Apply a stock adjustment with reason and audit log

import type { APIRoute } from "astro";
import { db } from "@/db";
import { productVariants } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordMovement } from "@/lib/inventory/movements";
import { checkAndAlertLowStock } from "@/lib/inventory/alerts";

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { variantId } = params;
  if (!variantId) return Response.json({ error: "Variant ID required" }, { status: 400 });

  try {
    const body = await request.json() as {
      /** Positive = add stock, Negative = remove stock */
      delta: number;
      reason: "received" | "correction" | "damage" | "theft" | "return" | "other";
      notes?: string;
      /** For pre-order stock adjustments */
      pool?: "stock" | "preorderStock";
    };

    if (typeof body.delta !== "number") {
      return Response.json({ error: "delta (number) is required" }, { status: 400 });
    }
    if (!body.reason) {
      return Response.json({ error: "reason is required" }, { status: 400 });
    }

    const pool = body.pool ?? "stock";
    const delta = Math.round(body.delta); // Must be integer for SQLite

    // Fetch current state
    const variant = await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        preorderStock: productVariants.preorderStock,
      })
      .from(productVariants)
      .where(eq(productVariants.id, variantId))
      .get();

    if (!variant) return Response.json({ error: "Variant not found" }, { status: 404 });

    const previousStock = pool === "preorderStock" ? variant.preorderStock : variant.stock;

    // Apply the adjustment
    const updateSet =
      pool === "preorderStock"
        ? {
            preorderStock: sql`MAX(0, ${productVariants.preorderStock} + ${delta})`,
            version: sql`${productVariants.version} + 1`,
            updatedAt: sql`unixepoch()`,
          }
        : {
            stock: sql`MAX(0, ${productVariants.stock} + ${delta})`,
            version: sql`${productVariants.version} + 1`,
            updatedAt: sql`unixepoch()`,
          };

    await db
      .update(productVariants)
      .set(updateSet)
      .where(eq(productVariants.id, variantId));

    const newStock = Math.max(0, previousStock + delta);

    // Record in audit log
    const adminUser = locals.user as { id?: string } | null;
    await recordMovement(db, {
      variantId,
      type: "adjusted",
      quantity: delta,
      previousStock,
      newStock,
      notes: `Manual adjustment (${body.reason})${body.notes ? `: ${body.notes}` : ""}`,
      createdBy: adminUser?.id ?? undefined,
    });

    // Check low stock alerts if stock was reduced
    if (delta < 0 && pool === "stock") {
      await checkAndAlertLowStock(db, variantId);
    }

    return Response.json({
      success: true,
      variantId,
      previousStock,
      newStock,
      delta,
    });
  } catch (error) {
    console.error("Error adjusting inventory:", error);
    return Response.json({ error: "Failed to adjust inventory" }, { status: 500 });
  }
};
