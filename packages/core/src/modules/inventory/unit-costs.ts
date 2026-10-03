// SKU unit cost ("cost per item", migration 0109): staff-only, never in a
// buyer projection. Merchants set it in the product editor and in bulk from
// Inventory; receiving a purchase order can move it to the weighted average
// (stock-commands.ts). Order lines snapshot it at creation (a trigger).
// Costs may carry minor units (paisa) even in BDT: they are not cash amounts.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { productVariants } from "@scalius/database/schema";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { type StoreCurrency } from "../settings";
import { readStoreCurrency } from "../markets";

/** Largest cost the API accepts, in major units (matches the money range of `toMinor`). */
export const UNIT_COST_MAX = 9_000_000_000;
export const SKU_COST_BATCH_LIMIT = 100;
const COST_CONFLICT = "SKU_COST_CHANGED";

/** A cost in major units of the store currency: finite, non-negative. */
export const unitCostAmountSchema = z.number().finite().min(0).max(UNIT_COST_MAX);

export const setSkuCostsSchema = z.object({
  items: z.array(z.object({
    variantId: z.string().trim().min(1).max(100),
    /** The new cost per item, or null to clear it. */
    cost: unitCostAmountSchema.nullable(),
    /**
     * The cost the merchant saw (null for none). When sent, the write applies
     * only if the SKU still has it, so a receipt's average is never clobbered.
     */
    expectedCost: unitCostAmountSchema.nullable().optional(),
  })).min(1).max(SKU_COST_BATCH_LIMIT),
});
export type SetSkuCostsInput = z.input<typeof setSkuCostsSchema>;

/** Major units to the store's minor units (half up); a cost keeps its minor units. */
export function unitCostToMinor(amount: number, currency: Pick<StoreCurrency, "decimalPlaces">): number {
  try {
    return toMinor(amount, currency.decimalPlaces);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Enter a valid cost.");
  }
}

export function unitCostFromMinor(amountMinor: number | null, decimalPlaces: number): number | null {
  return amountMinor === null ? null : fromMinor(amountMinor, decimalPlaces);
}

/**
 * Margin of a price over a cost, as a percentage with one decimal (null
 * without a cost or a positive price). Shown next to price in the editor.
 */
export function marginPercent(priceMinor: number, costMinor: number | null): number | null {
  if (costMinor === null || priceMinor <= 0) return null;
  return Math.round(((priceMinor - costMinor) * 1000) / priceMinor) / 10;
}

export interface SkuCostResult {
  variantId: string;
  cost: number | null;
}

/**
 * Sets the unit cost of up to 100 live SKUs in one batch. With
 * `expectedCost`, a SKU whose cost changed since the merchant read it (a
 * receipt, another tab) refuses the whole batch.
 */
export async function setSkuCosts(db: Database, input: SetSkuCostsInput): Promise<{ items: SkuCostResult[] }> {
  const parsed = setSkuCostsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid costs");
  const { items } = parsed.data;
  if (new Set(items.map((item) => item.variantId)).size !== items.length) {
    throw new ValidationError("Each SKU appears once.");
  }
  const currency = await readStoreCurrency(db);
  const planned = items.map((item) => ({
    variantId: item.variantId,
    costMinor: item.cost === null ? null : unitCostToMinor(item.cost, currency),
    expectedMinor: item.expectedCost === undefined
      ? undefined
      : item.expectedCost === null ? null : unitCostToMinor(item.expectedCost, currency),
  }));
  const live = await db.select({ id: productVariants.id })
    .from(productVariants)
    .where(and(inArray(productVariants.id, planned.map((item) => item.variantId)), isNull(productVariants.deletedAt)))
    .all();
  if (live.length !== planned.length) throw new NotFoundError("A SKU in this change no longer exists.");

  const statements = planned.flatMap((item) => [
    db.update(productVariants)
      .set({ costMinor: item.costMinor, updatedAt: sql`unixepoch()` })
      .where(and(
        eq(productVariants.id, item.variantId),
        isNull(productVariants.deletedAt),
        item.expectedMinor === undefined
          ? undefined
          : item.expectedMinor === null ? isNull(productVariants.costMinor) : eq(productVariants.costMinor, item.expectedMinor),
      )),
    buildBatchGuard(db, sql`EXISTS (
      SELECT 1 FROM ${productVariants}
      WHERE ${productVariants.id} = ${item.variantId}
        AND ${item.costMinor === null ? sql`${productVariants.costMinor} IS NULL` : sql`${productVariants.costMinor} = ${item.costMinor}`}
    )`, COST_CONFLICT),
  ]);
  try {
    await safeBatch(db, statements as never);
  } catch (error) {
    if (isBatchGuardError(error, COST_CONFLICT)) {
      throw new ConflictError("A SKU's cost changed since you opened it. Reload and try again.");
    }
    throw error;
  }
  return {
    items: planned.map((item) => ({ variantId: item.variantId, cost: unitCostFromMinor(item.costMinor, currency.decimalPlaces) })),
  };
}
