// Strict ledger-v2 reservation release, prepared for a caller's atomic batch.
// Decrements reservedStock (and restores preorderStock for pre-order pool).

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import {
  buildBatchGuard,
  isBatchGuardError,
  type Database,
} from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { catalogBuyerStateRefreshStatementsForSkus } from "../products";
import type { ReservationEntry, StockOperationResult } from "./types";
import { validatePositiveQuantity } from "./validation";
import {
  buildInventoryLedgerV2Edge,
  getActiveReservationGeneration,
  getReservationGenerationBalances,
  type InventoryLedgerV2EdgeFields,
  type InventoryLedgerV2Event,
  ledgerVersionKeyRead,
} from "./ledger-v2";

type ReservationPool = "regular" | "preorder" | "backorder";
type SQLiteBatchItem = BatchItem<"sqlite">;

interface ReleaseVariantState {
  id: string;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  trackInventory: boolean;
  stockVersion: number;
}

interface ReleaseMovementStats {
  reservedQuantity: number;
  releasedQuantity: number;
  reservationGenerations: number;
  reservationGeneration: number;
}

interface ReleaseMovementClaim extends InventoryLedgerV2EdgeFields {
  id: string;
  variantId: string;
  orderId: string;
  quantity: number;
  notes: string;
}

interface StrictReleaseEntry {
  variantId: string;
  quantity: number;
  pool: ReservationPool;
}

export interface ReleaseReservedStockBatchOptions {
  releaseKey?: string;
  requireExact?: boolean;
}

export interface ReleaseReservedStockBatchResult {
  success: boolean;
  results: StockOperationResult[];
  error?: string;
  manualReconciliationRequired?: boolean;
}

const DEFAULT_RELEASE_KEY = "inventory-release:v1";
const INVENTORY_RELEASE_PLAN_CONFLICT = "inventory_release_plan_conflict";

export function isPreparedReservedStockReleaseConflictError(error: unknown): boolean {
  return isBatchGuardError(error, INVENTORY_RELEASE_PLAN_CONFLICT);
}

export interface PreparedReservedStockReleaseBatch extends ReleaseReservedStockBatchResult {
  statements: SQLiteBatchItem[];
}

/** Prepare strict ledger-v2 release statements for a larger atomic domain batch. */
export async function prepareReservedStockReleaseBatch(
  db: Database,
  entries: ReservationEntry[],
  orderId: string,
  options: ReleaseReservedStockBatchOptions = {},
): Promise<PreparedReservedStockReleaseBatch> {
  for (const entry of entries) validatePositiveQuantity(entry.quantity);
  if (entries.length === 0) return { success: true, results: [], statements: [] };

  const mergedEntries = mergeReleaseEntries(entries);
  const multiPoolVariant = findVariantWithMultipleReleasePools(mergedEntries);
  if (multiPoolVariant) {
    return {
      ...buildStrictReleaseFailure(
        mergedEntries,
        `Variant ${multiPoolVariant} cannot release multiple inventory pools in one counter mutation`,
        true,
      ),
      statements: [],
    };
  }

  const variantLoad = await loadReleaseVariantStates(db, mergedEntries);
  if (!variantLoad.success) return { ...variantLoad, statements: [] };
  const trackedEntries = mergedEntries.filter(
    (entry) => variantLoad.variants.get(entry.variantId)?.trackInventory !== false,
  );
  if (trackedEntries.length === 0) {
    return {
      success: true,
      results: buildReleaseSuccessResults(mergedEntries, variantLoad.variants, new Map()),
      statements: [],
    };
  }

  const stats = await loadReleaseMovementStats(db, orderId, trackedEntries);
  const entriesToRelease: StrictReleaseEntry[] = [];
  for (const entry of trackedEntries) {
    const stat = stats.get(entry.variantId);
    const outstandingQuantity = stat
      ? Math.max(0, stat.reservedQuantity - stat.releasedQuantity)
      : 0;
    if (
      !stat
      || stat.reservedQuantity <= 0
      || outstandingQuantity <= 0
      || (options.requireExact && outstandingQuantity < entry.quantity)
    ) {
      return {
        ...buildStrictReleaseFailure(
          mergedEntries,
          `Reservation evidence is insufficient for order ${orderId} and variant ${entry.variantId}`,
          true,
        ),
        statements: [],
      };
    }
    entriesToRelease.push({
      ...entry,
      quantity: Math.min(entry.quantity, outstandingQuantity),
    });
  }

  const releaseKey = options.releaseKey ?? DEFAULT_RELEASE_KEY;
  const claims = await Promise.all(entriesToRelease.map(async (entry) => {
    const variant = variantLoad.variants.get(entry.variantId)!;
    const stat = stats.get(entry.variantId)!;
    const edge = buildInventoryLedgerV2Edge({
      pool: entry.pool,
      reservationGeneration: stat.reservationGeneration,
      before: variant,
      after: {
        ...variant,
        reservedStock: variant.reservedStock - entry.quantity,
        preorderStock: entry.pool === "preorder"
          ? variant.preorderStock + entry.quantity
          : variant.preorderStock,
        stockVersion: variant.stockVersion + 1,
      },
    });
    return {
      id: await createReleaseMovementId({
        releaseKey,
        orderId,
        variantId: entry.variantId,
        pool: entry.pool,
        generation: stat.reservationGenerations,
      }),
      variantId: entry.variantId,
      orderId,
      quantity: -entry.quantity,
      notes: `Released ${entry.quantity} reserved units for order amendment ${orderId}`,
      ...edge,
    } satisfies ReleaseMovementClaim;
  }));

  const statements: SQLiteBatchItem[] = [];
  for (let index = 0; index < entriesToRelease.length; index += 1) {
    const entry = entriesToRelease[index]!;
    const claim = claims[index]!;
    statements.push(
      buildReleaseMovementInsert(db, claim, variantLoad.variants.get(entry.variantId)!),
      buildReleaseVariantUpdate(db, entry, variantLoad.variants.get(entry.variantId)!),
      buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${inventoryMovements}
        INNER JOIN ${productVariants}
          ON ${productVariants.id} = ${inventoryMovements.variantId}
        WHERE ${inventoryMovements.id} = ${claim.id}
          AND ${inventoryMovements.orderId} = ${orderId}
          AND ${inventoryMovements.stockVersionAfter} = ${productVariants.stockVersion}
          AND ${inventoryMovements.newReservedStock} = ${productVariants.reservedStock}
          AND ${inventoryMovements.newPreorderStock} = ${productVariants.preorderStock}
      )`, INVENTORY_RELEASE_PLAN_CONFLICT),
    );
  }
  // Buyer state reads the counters this batch just wrote.
  statements.push(...catalogBuyerStateRefreshStatementsForSkus(
    db,
    entriesToRelease.map((entry) => entry.variantId),
  ));

  return {
    success: true,
    results: buildReleaseSuccessResults(mergedEntries, variantLoad.variants, stats),
    statements,
  };
}

function mergeReleaseEntries(entries: ReservationEntry[]): StrictReleaseEntry[] {
  const merged = new Map<string, StrictReleaseEntry>();

  for (const entry of entries) {
    const pool = entry.pool ?? "regular";
    const key = `${entry.variantId}\0${pool}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += entry.quantity;
    } else {
      merged.set(key, {
        variantId: entry.variantId,
        quantity: entry.quantity,
        pool,
      });
    }
  }

  return Array.from(merged.values());
}

function findVariantWithMultipleReleasePools(entries: StrictReleaseEntry[]): string | null {
  const poolByVariant = new Map<string, ReservationPool>();
  for (const entry of entries) {
    const existing = poolByVariant.get(entry.variantId);
    if (existing && existing !== entry.pool) return entry.variantId;
    poolByVariant.set(entry.variantId, entry.pool);
  }
  return null;
}

async function loadReleaseVariantStates(
  db: Database,
  entries: StrictReleaseEntry[],
): Promise<
  | { success: true; variants: Map<string, ReleaseVariantState> }
  | { success: false; results: StockOperationResult[]; error: string; manualReconciliationRequired: true }
> {
  const variantIds = [...new Set(entries.map((entry) => entry.variantId))];
  const rows = await db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      preorderStock: productVariants.preorderStock,
      trackInventory: productVariants.trackInventory,
      stockVersion: productVariants.stockVersion,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds))
    .all();

  const variants = new Map<string, ReleaseVariantState>(rows.map((row) => [row.id, row]));
  const missingEntry = entries.find((entry) => !variants.has(entry.variantId));

  if (missingEntry) {
    return {
      success: false,
      results: entries.map((entry) => ({
        success: entry.variantId !== missingEntry.variantId,
        variantId: entry.variantId,
        previousStock: 0,
        newStock: 0,
        error: entry.variantId === missingEntry.variantId
          ? `Variant ${entry.variantId} not found`
          : undefined,
      })),
      error: `Variant ${missingEntry.variantId} not found`,
      manualReconciliationRequired: true,
    };
  }

  return { success: true, variants };
}

async function loadReleaseMovementStats(
  db: Database,
  orderId: string,
  entries: StrictReleaseEntry[],
): Promise<Map<string, ReleaseMovementStats>> {
  const stats = new Map<string, ReleaseMovementStats>();

  for (const entry of entries) {
    const v2Rows = await db
      .select({
        id: inventoryMovements.id,
        variantId: inventoryMovements.variantId,
        orderId: inventoryMovements.orderId,
        type: inventoryMovements.type,
        ledgerVersion: inventoryMovements.ledgerVersion,
        pool: inventoryMovements.pool,
        reservationGeneration: inventoryMovements.reservationGeneration,
        stockVersionBefore: inventoryMovements.stockVersionBefore,
        stockVersionAfter: inventoryMovements.stockVersionAfter,
        previousStock: inventoryMovements.previousStock,
        newStock: inventoryMovements.newStock,
        stockDelta: inventoryMovements.stockDelta,
        previousReservedStock: inventoryMovements.previousReservedStock,
        newReservedStock: inventoryMovements.newReservedStock,
        reservedStockDelta: inventoryMovements.reservedStockDelta,
        previousPreorderStock: inventoryMovements.previousPreorderStock,
        newPreorderStock: inventoryMovements.newPreorderStock,
        preorderStockDelta: inventoryMovements.preorderStockDelta,
      })
      .from(inventoryMovements)
      .where(and(
        eq(inventoryMovements.orderId, orderId),
        eq(inventoryMovements.variantId, entry.variantId),
        eq(inventoryMovements.ledgerVersion, 2),
        eq(inventoryMovements.pool, entry.pool),
      ))
      .all();

    const completeV2Rows = v2Rows.filter((row) => row.ledgerVersion === 2);
    if (completeV2Rows.length > 0) {
      const balances = getReservationGenerationBalances(
        completeV2Rows as InventoryLedgerV2Event[],
        { orderId, variantId: entry.variantId, pool: entry.pool },
      );
      const activeGeneration = getActiveReservationGeneration(balances);
      const generation = activeGeneration ?? balances.at(-1)?.generation ?? 1;
      const balance = balances.find((candidate) => candidate.generation === generation);
      stats.set(entry.variantId, {
        reservedQuantity: balance?.reserved ?? 0,
        releasedQuantity: balance?.consumed ?? 0,
        reservationGenerations: generation,
        reservationGeneration: generation,
      });
      continue;
    }

    stats.set(entry.variantId, { reservedQuantity: 0, releasedQuantity: 0, reservationGenerations: 0, reservationGeneration: 1 });
  }

  return stats;
}

async function createReleaseMovementId(input: {
  releaseKey: string;
  orderId: string;
  variantId: string;
  pool: ReservationPool;
  generation: number;
}): Promise<string> {
  const payload = [
    input.releaseKey,
    input.orderId,
    input.variantId,
    input.pool,
    String(input.generation),
  ].join("\0");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `release:${hex}`;
}

function buildReleaseMovementInsert(
  db: Database,
  claim: ReleaseMovementClaim,
  variant: ReleaseVariantState,
) {
  return db
    .insert(inventoryMovements)
    .select(sql`
      SELECT
        ${claim.id},
        ${claim.variantId},
        ${claim.orderId},
        'released',
        ${claim.quantity},
        ${claim.previousStock},
        ${claim.newStock},
        ${claim.notes},
        NULL,
        ${claim.ledgerVersion},
        ${claim.pool},
        ${claim.reservationGeneration},
        ${claim.stockVersionBefore},
        ${claim.stockVersionAfter},
        ${claim.stockDelta},
        ${claim.previousReservedStock},
        ${claim.newReservedStock},
        ${claim.reservedStockDelta},
        ${claim.previousPreorderStock},
        ${claim.newPreorderStock},
        ${claim.preorderStockDelta},
        unixepoch(),
        NULL
      FROM ${productVariants}
      WHERE ${productVariants.id} = ${claim.variantId}
        AND ${productVariants.stockVersion} = ${variant.stockVersion}
        AND ${productVariants.reservedStock} >= ${Math.abs(claim.quantity)}
        ${ledgerVersionKeyRead(claim.stockVersionAfter)}
    `)
    .returning({ id: inventoryMovements.id });
}

function buildReleaseVariantUpdate(
  db: Database,
  entry: StrictReleaseEntry,
  variant: ReleaseVariantState,
) {
  return db
    .update(productVariants)
    .set({
      reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${entry.quantity})`,
      ...(entry.pool === "preorder"
        ? { preorderStock: sql`${productVariants.preorderStock} + ${entry.quantity}` }
        : {}),
      stockVersion: sql`${productVariants.stockVersion} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(productVariants.id, entry.variantId),
        eq(productVariants.stockVersion, variant.stockVersion),
        gte(productVariants.reservedStock, entry.quantity),
      ),
    )
    .returning({ id: productVariants.id });
}

function buildReleaseSuccessResults(
  entries: StrictReleaseEntry[],
  variants: Map<string, ReleaseVariantState>,
  stats: Map<string, ReleaseMovementStats>,
): StockOperationResult[] {
  return entries.map((entry) => {
    const variant = variants.get(entry.variantId)!;
    const stat = stats.get(entry.variantId);
    const outstandingQuantity = stat
      ? Math.max(0, Math.min(entry.quantity, stat.reservedQuantity - stat.releasedQuantity))
      : entry.quantity;
    const releasedQuantity = variant.trackInventory === false ? 0 : outstandingQuantity;
    const previousStock = getReleasePreviousStock(variant, entry.pool);
    return {
      success: true,
      variantId: entry.variantId,
      previousStock,
      newStock: entry.pool === "preorder" ? previousStock + releasedQuantity : previousStock,
    };
  });
}

function buildStrictReleaseFailure(
  entries: StrictReleaseEntry[],
  error: string,
  manualReconciliationRequired: boolean,
): ReleaseReservedStockBatchResult {
  return {
    success: false,
    results: entries.map((entry) => ({
      success: false,
      variantId: entry.variantId,
      previousStock: 0,
      newStock: 0,
      error,
    })),
    error,
    manualReconciliationRequired,
  };
}

function getReleasePreviousStock(variant: ReleaseVariantState, pool: ReservationPool): number {
  return pool === "preorder" ? variant.preorderStock : variant.stock;
}

