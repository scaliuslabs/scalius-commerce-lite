// src/lib/inventory/movements.ts
// Records stock movement audit log entries.

import { sql } from "drizzle-orm";
import { inventoryMovements } from "@/db/schema";
import type { Database } from "@/db";
import type { MovementEntry } from "./types";

/**
 * Record a stock movement in the audit log.
 * Called after every successful stock operation.
 * Errors are non-fatal — a failed log entry should not roll back the stock change.
 */
export async function recordMovement(
  db: Database,
  entry: MovementEntry
): Promise<void> {
  try {
    const id = crypto.randomUUID();
    await db.insert(inventoryMovements).values({
      id,
      variantId: entry.variantId,
      orderId: entry.orderId ?? null,
      type: entry.type,
      quantity: entry.quantity,
      previousStock: entry.previousStock,
      newStock: entry.newStock,
      notes: entry.notes ?? null,
      createdBy: entry.createdBy ?? null,
      createdAt: new Date(),
    });
  } catch (err) {
    // Log but don't throw — movement logging is best-effort
    console.error("[inventory/movements] Failed to record movement:", err);
  }
}
