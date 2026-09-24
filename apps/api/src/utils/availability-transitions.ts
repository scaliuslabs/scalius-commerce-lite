// Availability-band transitions (band-only public stock): a stock write bumps
// the cache generation only when a SKU crosses a buyer-visible band. Kept apart
// from cache-generation.ts so the Worker entry does not load inventory.
import { effectiveLowStockThresholdSql } from "@scalius/core/modules/inventory";
import type { Database } from "@scalius/database/client";
import { productVariants } from "@scalius/database/schema";
import { inArray } from "drizzle-orm";
import { resolveTrackedBuyerAvailabilityBand } from "@scalius/shared/buyer-availability";

export interface CheckoutReservationAvailabilityInput {
  variantId: string;
  quantity: number;
}

export interface StockAvailabilityMutationInput {
  variantId: string;
  previousStock: number;
  newStock: number;
  pool?: "stock" | "preorderStock";
}

interface BuyerAvailabilityRow {
  id: string;
  stock: number;
  preorderStock: number;
  reservedStock: number;
  trackInventory: boolean;
  allowPreorder: boolean;
  lowStockThreshold: number | null;
}

export function hasBuyerAvailabilityBandTransition(input: {
  availableBefore: number;
  availableAfter: number;
  lowStockThreshold: number | null;
}): boolean {
  return resolveTrackedBuyerAvailabilityBand(
    input.availableBefore,
    input.lowStockThreshold,
  ) !== resolveTrackedBuyerAvailabilityBand(
    input.availableAfter,
    input.lowStockThreshold,
  );
}

async function loadBuyerAvailabilityRows(
  db: Database,
  variantIds: readonly string[],
): Promise<BuyerAvailabilityRow[]> {
  const rows: BuyerAvailabilityRow[] = [];
  for (let offset = 0; offset < variantIds.length; offset += 90) {
    rows.push(...await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        preorderStock: productVariants.preorderStock,
        reservedStock: productVariants.reservedStock,
        trackInventory: productVariants.trackInventory,
        allowPreorder: productVariants.allowPreorder,
        lowStockThreshold: effectiveLowStockThresholdSql(),
      })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds.slice(offset, offset + 90)))
      .all());
  }
  return rows;
}

/**
 * Post-commit band check for callers whose commit does not report its counter
 * after-state (storefront checkout reads it from its own batch). Conservatively
 * returns every affected variant if the read fails.
 */
export async function findCheckoutReservationAvailabilityTransitions(
  db: Database,
  entries: readonly CheckoutReservationAvailabilityInput[],
): Promise<string[]> {
  const quantities = new Map<string, number>();
  for (const entry of entries) {
    if (
      !entry.variantId
      || entry.variantId.length > 180
      || !Number.isSafeInteger(entry.quantity)
      || entry.quantity <= 0
    ) {
      continue;
    }
    quantities.set(
      entry.variantId,
      (quantities.get(entry.variantId) ?? 0) + entry.quantity,
    );
  }
  const variantIds = [...quantities.keys()];
  if (variantIds.length === 0) return [];

  try {
    const rows = await loadBuyerAvailabilityRows(db, variantIds);
    const found = new Set(rows.map((row) => row.id));
    const transitions = rows.filter((row) => {
      if (!row.trackInventory) return false;
      const availableAfter = Math.max(0, row.stock - row.reservedStock);
      return hasBuyerAvailabilityBandTransition({
        availableBefore: availableAfter + quantities.get(row.id)!,
        availableAfter,
        lowStockThreshold: row.lowStockThreshold,
      });
    }).map((row) => row.id);
    for (const variantId of variantIds) {
      if (!found.has(variantId)) transitions.push(variantId);
    }
    return [...new Set(transitions)];
  } catch (error) {
    console.error(
      "[Cache] Checkout availability transition read failed; bumping conservatively:",
      error,
    );
    return variantIds;
  }
}

/** Manual stock writes bump only when a buyer-visible band changes. */
export async function findStockMutationAvailabilityTransitions(
  db: Database,
  mutations: readonly StockAvailabilityMutationInput[],
): Promise<string[]> {
  const byVariant = new Map<string, StockAvailabilityMutationInput>();
  for (const mutation of mutations) {
    if (
      !mutation.variantId
      || mutation.variantId.length > 180
      || !Number.isSafeInteger(mutation.previousStock)
      || !Number.isSafeInteger(mutation.newStock)
    ) {
      continue;
    }
    byVariant.set(mutation.variantId, mutation);
  }
  const variantIds = [...byVariant.keys()];
  if (variantIds.length === 0) return [];

  try {
    const rows = await loadBuyerAvailabilityRows(db, variantIds);
    const found = new Set(rows.map((row) => row.id));
    const transitions = rows.filter((row) => {
      if (!row.trackInventory) return false;
      const mutation = byVariant.get(row.id)!;
      if (mutation.pool === "preorderStock") {
        if (!row.allowPreorder) return false;
        return (mutation.previousStock > 0) !== (mutation.newStock > 0);
      }
      return hasBuyerAvailabilityBandTransition({
        availableBefore: Math.max(
          0,
          mutation.previousStock - row.reservedStock,
        ),
        availableAfter: Math.max(0, mutation.newStock - row.reservedStock),
        lowStockThreshold: row.lowStockThreshold,
      });
    }).map((row) => row.id);
    for (const variantId of variantIds) {
      if (!found.has(variantId)) transitions.push(variantId);
    }
    return [...new Set(transitions)];
  } catch (error) {
    console.error(
      "[Cache] Stock availability transition read failed; bumping conservatively:",
      error,
    );
    return variantIds;
  }
}
