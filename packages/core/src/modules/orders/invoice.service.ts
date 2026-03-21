// src/modules/orders/invoice.service.ts
// Invoice number assignment with CAS-based sequential counter.
// Numbers are assigned on first invoice view (not on order creation).
// The counter lives in the settings table; the assigned number is cached on the order row.

import { orders, settings } from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

/**
 * Format an invoice number with prefix and zero-padded digits.
 * Example: formatInvoiceNumber("INV", 42) => "INV-00042"
 */
export function formatInvoiceNumber(prefix: string, num: number): string {
  return `${prefix}-${String(num).padStart(5, "0")}`;
}

/**
 * Get or assign an invoice number for an order.
 *
 * - If the order already has an invoice number, returns it immediately (idempotent).
 * - If not, reads the counter from settings, increments via CAS, writes to order.
 * - CAS retry: if the first attempt fails due to concurrent conflict, retries once.
 * - Prefix resolution: uses provided prefix, falls back to business_info setting, then "INV".
 */
export async function getOrAssignInvoiceNumber(
  db: Database,
  orderId: string,
  prefix?: string,
): Promise<{ invoiceNumber: number; formatted: string }> {
  // 1. Check if order exists and already has an invoice number
  const order = await db
    .select({ invoiceNumber: orders.invoiceNumber })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();

  if (!order) {
    throw new Error("Order not found");
  }

  // Resolve prefix: provided > business settings > default "INV"
  const resolvedPrefix = prefix ?? (await resolveInvoicePrefix(db));

  // 2. If already assigned, return immediately
  if (order.invoiceNumber !== null) {
    return {
      invoiceNumber: order.invoiceNumber,
      formatted: formatInvoiceNumber(resolvedPrefix, order.invoiceNumber),
    };
  }

  // 3. Assign a new invoice number with CAS
  const newNumber = await assignNextNumber(db, orderId);

  return {
    invoiceNumber: newNumber,
    formatted: formatInvoiceNumber(resolvedPrefix, newNumber),
  };
}

// ─────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────

/**
 * Resolve the invoice prefix from business settings, defaulting to "INV".
 */
async function resolveInvoicePrefix(db: Database): Promise<string> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.category, "business_info"),
        eq(settings.key, "invoice_prefix"),
      ),
    )
    .get();

  return row?.value || "INV";
}

/**
 * CAS-based counter increment with one retry on conflict.
 * Reads the current counter value, increments it, and writes both the counter and the order.
 */
async function assignNextNumber(
  db: Database,
  orderId: string,
): Promise<number> {
  // First attempt
  const result = await tryAssign(db, orderId);
  if (result !== null) return result;

  // CAS conflict — retry once
  const retry = await tryAssign(db, orderId);
  if (retry !== null) return retry;

  throw new Error("Invoice number conflict — please retry");
}

/**
 * Single CAS attempt to increment the counter and assign to order.
 * Returns the new invoice number, or null if CAS failed.
 */
async function tryAssign(
  db: Database,
  orderId: string,
): Promise<number | null> {
  // Read current counter
  const counterRow = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.category, "invoice_counter"),
        eq(settings.key, "current_value"),
      ),
    )
    .get();

  const oldValue = counterRow?.value ?? "0";
  const newValue = parseInt(oldValue, 10) + 1;

  // CAS write: update or insert counter
  if (counterRow) {
    // Update with WHERE guard on old value, returning to verify CAS succeeded
    const updated = await db
      .update(settings)
      .set({ value: String(newValue), updatedAt: sql`(cast(strftime('%s','now') as int))` })
      .where(
        and(
          eq(settings.category, "invoice_counter"),
          eq(settings.key, "current_value"),
          eq(settings.value, oldValue),
        ),
      )
      .returning({ id: settings.id });

    // If no rows returned, CAS failed (concurrent conflict)
    if (updated.length === 0) {
      return null; // CAS conflict
    }
  } else {
    // First invoice ever — insert counter row
    await db.insert(settings).values({
      id: crypto.randomUUID(),
      key: "current_value",
      value: String(newValue),
      type: "string",
      category: "invoice_counter",
    });
  }

  // Write invoice number to order
  await db
    .update(orders)
    .set({ invoiceNumber: newValue })
    .where(eq(orders.id, orderId));

  return newValue;
}
