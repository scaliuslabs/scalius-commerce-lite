// src/lib/inventory/reserve.ts
// Optimistic-locking stock reservation.
// Reserves stock by incrementing reservedStock WITHOUT decrementing stock.
// Stock is permanently deducted only on payment confirmation.

import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { inventoryMovements, products, productVariants } from "@scalius/database/schema";
import {
  availableRegularStockSql,
  coordinatedRegularReservedStockSql,
  effectiveRegularReservedStockSql,
} from "@scalius/database/inventory-authority";
import {
  buildBatchGuard,
  isBatchGuardError,
  isTursoConflictError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { recordMovement } from "./movements";
import type { ReservationEntry, StockOperationResult } from "./types";
import { validatePositiveQuantity } from "./validation";
import {
  buildInventoryLedgerV2Edge,
  getNextReservationGeneration,
  getReservationGenerationBalances,
  type InventoryLedgerV2EdgeFields,
  type InventoryLedgerV2Event,
} from "./ledger-v2";

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 50;
const INVENTORY_RESERVATION_CONFLICT = "INVENTORY_RESERVATION_CONFLICT";
type ReservationPool = "regular" | "preorder" | "backorder";
type SQLiteBatchItem = BatchItem<"sqlite">;

/**
 * Reserve stock for a single variant using optimistic locking.
 * Uses the `version` field to detect concurrent modifications and retries.
 *
 * For pre-orders: deducts from preorderStock instead of regular stock.
 * For backorders: allows order even when stock = 0 (up to backorderLimit).
 */
export async function reserveStock(
  db: Database,
  variantId: string,
  quantity: number,
  orderId?: string,
  pool: "regular" | "preorder" | "backorder" = "regular"
): Promise<StockOperationResult> {
  validatePositiveQuantity(quantity);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Read current state with version
    const variant = await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        reservedStock: effectiveRegularReservedStockSql(),
        preorderStock: productVariants.preorderStock,
        allowPreorder: productVariants.allowPreorder,
        allowBackorder: productVariants.allowBackorder,
        backorderLimit: productVariants.backorderLimit,
        trackInventory: productVariants.trackInventory,
        stockVersion: productVariants.stockVersion,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.id, variantId),
          isNull(productVariants.deletedAt),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      )
      .get();

    if (!variant) {
      return {
        success: false,
        variantId,
        previousStock: 0,
        newStock: 0,
        error: `Variant ${variantId} not found`,
      };
    }

    if (!variant.trackInventory) {
      return {
        success: true,
        variantId,
        previousStock: variant.stock,
        newStock: variant.stock,
      };
    }

    // 2. Check available stock based on pool
    if (pool === "preorder") {
      if (!variant.allowPreorder) {
        return {
          success: false,
          variantId,
          previousStock: variant.preorderStock,
          newStock: variant.preorderStock,
          error: `Pre-order not allowed for variant ${variantId}`,
        };
      }
      if (variant.preorderStock < quantity) {
        return {
          success: false,
          variantId,
          previousStock: variant.preorderStock,
          newStock: variant.preorderStock,
          error: `Insufficient pre-order stock for variant ${variantId}. Available: ${variant.preorderStock}, Requested: ${quantity}`,
        };
      }
    } else if (pool === "backorder") {
      if (!variant.allowBackorder) {
        return {
          success: false,
          variantId,
          previousStock: variant.stock,
          newStock: variant.stock,
          error: `Backorder not allowed for variant ${variantId}`,
        };
      }
      // Check backorder limit (0 = unlimited)
      if (variant.backorderLimit > 0 && variant.reservedStock + quantity > variant.backorderLimit) {
        return {
          success: false,
          variantId,
          previousStock: variant.stock,
          newStock: variant.stock,
          error: `Backorder limit exceeded for variant ${variantId}`,
        };
      }
    } else {
      // Regular stock: available = stock - reservedStock
      const available = variant.stock - variant.reservedStock;
      if (available < quantity) {
        return {
          success: false,
          variantId,
          previousStock: variant.stock,
          newStock: variant.stock,
          error: `Insufficient stock for variant ${variantId}. Available: ${available}, Requested: ${quantity}`,
        };
      }
    }

    // 3. Attempt optimistic update with version check
    const previousStock = pool === "preorder" ? variant.preorderStock : variant.stock;

    const updateSet =
      pool === "preorder"
        ? {
          preorderStock: sql`${productVariants.preorderStock} - ${quantity}`,
          reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        }
        : {
          reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        };
    const mutationAvailability = pool === "preorder"
      ? sql`${productVariants.allowPreorder} = 1
          AND ${productVariants.preorderStock} >= ${quantity}`
      : pool === "backorder"
        ? sql`${productVariants.allowBackorder} = 1
            AND (
              ${productVariants.backorderLimit} = 0
              OR ${effectiveRegularReservedStockSql()} + ${quantity}
                <= ${productVariants.backorderLimit}
            )`
        : sql`${availableRegularStockSql()} >= ${quantity}`;

    const result = await db
      .update(productVariants)
      .set(updateSet)
      .where(
          and(
            eq(productVariants.id, variantId),
            isNull(productVariants.deletedAt),
            eq(productVariants.stockVersion, variant.stockVersion),
            mutationAvailability,
          )
        )
      .returning({ id: productVariants.id });

    if (result.length > 0) {
      // Success — log movement
      const newStock = pool === "preorder"
        ? variant.preorderStock - quantity
        : variant.stock;

      await recordMovement(db, {
        variantId,
        orderId,
        type: pool === "preorder" ? "preorder_reserved" : "reserved",
        quantity,
        previousStock,
        newStock,
        notes: `Reserved ${quantity} units for order${orderId ? ` ${orderId}` : ""}`,
      });

      return { success: true, variantId, previousStock, newStock };
    }

    // Concurrent modification detected — wait and retry
    if (attempt < MAX_RETRIES - 1) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  return {
    success: false,
    variantId,
    previousStock: 0,
    newStock: 0,
    error: `Failed to reserve stock after ${MAX_RETRIES} retries due to concurrent modifications`,
  };
}

/**
 * Reserve stock for multiple variants atomically.
 * If any reservation fails, rolls back all successful reservations.
 */
export async function reserveMultiple(
  db: Database,
  entries: ReservationEntry[],
  orderId?: string
): Promise<{ success: boolean; results: StockOperationResult[]; error?: string }> {
  for (const entry of entries) validatePositiveQuantity(entry.quantity);

  const results: StockOperationResult[] = [];
  const toRollback: ReservationEntry[] = [];

  for (const entry of entries) {
    const result = await reserveStock(db, entry.variantId, entry.quantity, orderId, entry.pool ?? "regular");
    results.push(result);

    if (!result.success) {
      // Rollback all previous successful reservations
      for (const rolledBack of toRollback) {
        await releaseReservationInternal(db, rolledBack.variantId, rolledBack.quantity, orderId, rolledBack.pool ?? "regular");
      }
      return {
        success: false,
        results,
        error: result.error ?? `Failed to reserve stock for variant ${entry.variantId}`,
      };
    }

    toRollback.push(entry);
  }

  return { success: true, results };
}

export type ReservationBatchItem = {
  variantId: string;
  quantity: number;
  orderId?: string;
  /**
   * Stable idempotency namespace for strict reservation movement claims.
   * Existing callers omit this and keep legacy random movement IDs.
   */
  reservationKey?: string;
  /**
   * Explicit movement claim ID. Prefer reservationKey for normal callers so
   * releases can advance the generated claim generation.
   */
  movementId?: string;
};

export interface ReserveStockBatchOptions {
  /**
   * Stable idempotency namespace for callers that need replay-safe reservation
   * claims. Queued checkout ingest uses this; admin/order-edit flows remain
   * non-deterministic unless they explicitly opt in.
   */
  reservationKey?: string;
  /**
   * Order identities proven to have no prior ledger edges. Checkout may set
   * this only for a new in-memory attempt whose attempt/order/inventory facts
   * will share one transaction. Retried or legacy identities must read their
   * existing generation.
   */
  freshOrderIds?: ReadonlySet<string>;
}

export type ReserveStockBatchResult = {
  success: boolean;
  results: StockOperationResult[];
  error?: string;
  manualReconciliationRequired?: boolean;
};

/**
 * A validated reservation plan whose statements can be composed into a larger
 * atomic checkout batch. Preparing performs reads only; callers decide when to
 * execute the guarded ledger and counter writes.
 */
export interface PreparedStockReservationBatch extends ReserveStockBatchResult {
  statements: SQLiteBatchItem[];
  resolveIdempotentReplay(error: unknown): Promise<ReserveStockBatchResult | null>;
}

type ReservationMovementClaim = {
  id: string;
  deterministic: boolean;
  variantId: string;
  orderId?: string;
  type: "reserved" | "preorder_reserved";
  quantity: number;
  previousStock: number;
  newStock: number;
  notes: string;
} & InventoryLedgerV2EdgeFields;

/**
 * Prepare guarded ledger-v2 reservation statements without executing them.
 * This is the checkout composition seam: inventory, order, promotion, outbox,
 * and idempotency writes can all share one database transaction.
 */
export async function prepareStockReservationBatch(
  db: Database,
  items: ReservationBatchItem[],
  pool: ReservationPool = "regular",
  options: ReserveStockBatchOptions = {},
): Promise<PreparedStockReservationBatch> {
  for (const item of items) validatePositiveQuantity(item.quantity);

  if (items.length === 0) {
    return {
      success: true,
      results: [],
      statements: [],
      resolveIdempotentReplay: async () => null,
    };
  }

  // Deduplicate stock counter updates by variant. Audit movements are grouped
  // separately by variant + order so every order keeps its own reservation trail.
  const entries = mergeReservationItemsByVariant(items);
  const movementEntries = groupReservationMovementsForAudit(items);
  const multiOrderVariant = findVariantWithMultipleReservationOrders(movementEntries);
  if (multiOrderVariant) {
    return {
      success: false,
      results: entries.map((entry) => ({
        success: false,
        variantId: entry.variantId,
        previousStock: 0,
        newStock: 0,
        error: `Variant ${multiOrderVariant} cannot be reserved for multiple orders in one counter mutation`,
      })),
      error: `Variant ${multiOrderVariant} cannot be reserved for multiple orders in one counter mutation`,
      manualReconciliationRequired: true,
      statements: [],
      resolveIdempotentReplay: async () => null,
    };
  }

  const variantLoad = await loadReservationVariantStates(db, entries);
  if (!variantLoad.success) {
    return {
      ...variantLoad,
      statements: [],
      resolveIdempotentReplay: async () => null,
    };
  }
  const variants = variantLoad.variants;

  const validationErrors = getStockAvailabilityErrors(entries, variants, pool);
  if (validationErrors.length > 0) {
    return {
      success: false,
      results: validationErrors,
      error: validationErrors[0]?.error,
      statements: [],
      resolveIdempotentReplay: async () => null,
    };
  }

  const trackedEntries = entries.filter((entry) => variants.get(entry.variantId)?.trackInventory !== false);
  const trackedMovementEntries = movementEntries.filter((entry) => variants.get(entry.variantId)?.trackInventory !== false);
  const results = buildReservationSuccessResults(entries, variants, pool);
  if (trackedEntries.length === 0) {
    return {
      success: true,
      results,
      statements: [],
      resolveIdempotentReplay: async () => null,
    };
  }

  const movementClaims = await buildReservationMovementClaims(
    db,
    trackedMovementEntries,
    variants,
    pool,
    options,
  );
  const useCurrentTransactionState = Boolean(options.freshOrderIds) &&
    trackedMovementEntries.every((entry) =>
      entry.orderId !== undefined && options.freshOrderIds!.has(entry.orderId)
    );

  if (useCurrentTransactionState) {
    const movementQueries = movementClaims.map((claim) =>
      buildFreshReservationMovementInsert(db, claim, pool)
    );
    const updateQueries = movementClaims.map((claim) =>
      buildFreshReservationCounterUpdate(db, claim)
    );
    const finalGuards = movementClaims.map((claim) =>
      buildFreshReservationFinalGuard(db, claim)
    );

    return {
      success: true,
      results,
      statements: [
        ...movementQueries,
        ...updateQueries,
        ...finalGuards,
      ] as SQLiteBatchItem[],
      resolveIdempotentReplay: (error) => resolveDuplicateReservationBatch(
        db,
        movementClaims,
        entries,
        variants,
        pool,
        error,
      ),
    };
  }

  const guardQueries = trackedEntries.map((entry) =>
    buildReservationBatchGuard(db, entry, variants.get(entry.variantId)!, pool)
  );
  const movementQueries = movementClaims.map((claim) =>
    buildReservationMovementInsert(db, claim, variants.get(claim.variantId)!)
  );
  const updateQueries = trackedEntries.map((entry) => {
    const variant = variants.get(entry.variantId)!;
    const updateSet = pool === "preorder"
      ? {
          preorderStock: sql`${productVariants.preorderStock} - ${entry.quantity}`,
          reservedStock: sql`${productVariants.reservedStock} + ${entry.quantity}`,
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        }
      : {
          reservedStock: sql`${productVariants.reservedStock} + ${entry.quantity}`,
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        };

    return db
      .update(productVariants)
      .set(updateSet)
      .where(and(
        eq(productVariants.id, entry.variantId),
        isNull(productVariants.deletedAt),
        eq(productVariants.stockVersion, variant.stockVersion),
      ))
      .returning({ id: productVariants.id });
  });

  return {
    success: true,
    results,
    statements: [...guardQueries, ...movementQueries, ...updateQueries] as SQLiteBatchItem[],
    resolveIdempotentReplay: (error) => resolveDuplicateReservationBatch(
      db,
      movementClaims,
      entries,
      variants,
      pool,
      error,
    ),
  };
}

/**
 * Reserve stock as a standalone atomic operation. Checkout uses the preparation
 * API above and composes these statements with its own durable writes.
 */
export async function reserveStockBatch(
  db: Database,
  items: ReservationBatchItem[],
  pool: ReservationPool = "regular",
  options: ReserveStockBatchOptions = {},
): Promise<ReserveStockBatchResult> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const plan = await prepareStockReservationBatch(db, items, pool, options);
    if (!plan.success || plan.statements.length === 0) return plan;

    try {
      await safeBatch(db, plan.statements);
      return { success: true, results: plan.results };
    } catch (error: unknown) {
      const idempotentResult = await plan.resolveIdempotentReplay(error);
      if (idempotentResult) return idempotentResult;

      if (isInventoryReservationConflictError(error) && attempt < MAX_RETRIES - 1) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }

      if (!isInventoryReservationConflictError(error)) {
        console.error("[inventory/reserve] Batch execution failed:", error);
        return {
          success: false,
          results: plan.results.map((result) => ({
            ...result,
            success: false,
            error: "Batch execution failed",
          })),
          error: "Batch execution failed",
        };
      }

      return {
        success: false,
        results: plan.results.map((result) => ({
          ...result,
          success: false,
          error: `Concurrent inventory change for variant ${result.variantId}`,
        })),
        error: `Failed to reserve stock batch after ${MAX_RETRIES} retries due to concurrent modifications`,
      };
    }
  }

  return {
    success: false,
    results: [],
    error: `Failed to reserve stock batch after ${MAX_RETRIES} retries`,
  };
}

type ReservationVariantState = {
  id: string;
  stock: number;
  legacyReservedStock?: number;
  reservedStock: number;
  preorderStock: number;
  allowPreorder: boolean;
  allowBackorder: boolean;
  backorderLimit: number;
  trackInventory: boolean;
  stockVersion: number;
};

function buildReservationBatchGuard(
  db: Database,
  entry: ReservationBatchItem,
  variant: ReservationVariantState,
  pool: ReservationPool,
): SQLiteBatchItem {
  const availability = pool === "preorder"
    ? sql`${productVariants.allowPreorder} = 1
        AND ${productVariants.preorderStock} >= ${entry.quantity}`
    : pool === "backorder"
      ? sql`${productVariants.allowBackorder} = 1
          AND (
            ${productVariants.backorderLimit} = 0
            OR ${effectiveRegularReservedStockSql()} + ${entry.quantity} <= ${productVariants.backorderLimit}
          )`
      : sql`${availableRegularStockSql()} >= ${entry.quantity}`;

  return buildBatchGuard(db, sql`EXISTS (
    SELECT 1
    FROM ${productVariants}
    INNER JOIN ${products}
      ON ${sql.raw('"products"."id"')} = ${sql.raw('"product_variants"."product_id"')}
    WHERE ${sql.raw('"product_variants"."id"')} = ${entry.variantId}
      AND ${sql.raw('"product_variants"."stock_version"')} = ${variant.stockVersion}
      AND ${sql.raw('"product_variants"."track_inventory"')} = 1
      AND ${sql.raw('"product_variants"."deleted_at"')} IS NULL
      AND ${sql.raw('"products"."is_active"')} = 1
      AND ${sql.raw('"products"."deleted_at"')} IS NULL
      AND ${availability}
  )`, INVENTORY_RESERVATION_CONFLICT);
}

export function isInventoryReservationConflictError(error: unknown): boolean {
  return isTursoConflictError(error)
    || isBatchGuardError(error, INVENTORY_RESERVATION_CONFLICT);
}

function reservationMovementType(pool: ReservationPool): "reserved" | "preorder_reserved" {
  return pool === "preorder" ? "preorder_reserved" : "reserved";
}

async function createReservationMovementId(input: {
  reservationKey: string;
  orderId: string;
  variantId: string;
  pool: ReservationPool;
  generation: number;
}): Promise<string> {
  const payload = [
    input.reservationKey,
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
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `reservation:${hex}`;
}

async function loadReservationReleaseGeneration(
  db: Database,
  orderId: string,
  variantId: string,
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.orderId, orderId),
        eq(inventoryMovements.variantId, variantId),
        eq(inventoryMovements.type, "released"),
      ),
    )
    .get();

  return result?.count ?? 0;
}

async function loadReservationLedgerGeneration(
  db: Database,
  orderId: string,
  variantId: string,
  pool: ReservationPool,
): Promise<number> {
  const rows = await db
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
      eq(inventoryMovements.variantId, variantId),
      eq(inventoryMovements.ledgerVersion, 2),
      eq(inventoryMovements.pool, pool),
    ))
    .all();

  const v2Rows = rows.filter((row) => row.ledgerVersion === 2);
  if (v2Rows.length > 0) {
    const balances = getReservationGenerationBalances(
      v2Rows as InventoryLedgerV2Event[],
      { orderId, variantId, pool },
    );
    return getNextReservationGeneration(balances);
  }

  // Legacy deterministic reservation IDs used zero-based release counts.
  // Keep that hash generation via (ledger generation - 1) so an in-flight
  // pre-migration checkout replay resolves its existing claim instead of
  // reserving twice.
  return (await loadReservationReleaseGeneration(db, orderId, variantId)) + 1;
}

async function buildReservationMovementClaims(
  db: Database,
  movementEntries: ReservationBatchItem[],
  variants: Map<string, ReservationVariantState>,
  pool: ReservationPool,
  options: ReserveStockBatchOptions,
): Promise<ReservationMovementClaim[]> {
  const claims: ReservationMovementClaim[] = [];
  const type = reservationMovementType(pool);

  for (const entry of movementEntries) {
    const variant = variants.get(entry.variantId)!;
    const legacyReservedStock = variant.legacyReservedStock ?? variant.reservedStock;
    const reservationKey = entry.reservationKey ?? options.reservationKey;
    const deterministic = Boolean(entry.movementId || (reservationKey && entry.orderId));
    const reservationGeneration = entry.orderId
      ? options.freshOrderIds?.has(entry.orderId)
        ? 1
        : await loadReservationLedgerGeneration(db, entry.orderId, entry.variantId, pool)
      : null;
    const legacyHashGeneration = reservationGeneration == null
      ? 0
      : reservationGeneration - 1;
    const id = entry.movementId
      ?? (reservationKey && entry.orderId
        ? await createReservationMovementId({
            reservationKey,
            orderId: entry.orderId,
            variantId: entry.variantId,
            pool,
            generation: legacyHashGeneration,
          })
        : crypto.randomUUID());

    const edge = buildInventoryLedgerV2Edge({
      pool,
      reservationGeneration,
      before: {
        stock: variant.stock,
        reservedStock: legacyReservedStock,
        preorderStock: variant.preorderStock,
        stockVersion: variant.stockVersion,
      },
      after: {
        stock: variant.stock,
        reservedStock: legacyReservedStock + entry.quantity,
        preorderStock: pool === "preorder"
          ? variant.preorderStock - entry.quantity
          : variant.preorderStock,
        stockVersion: variant.stockVersion + 1,
      },
    });

    claims.push({
      id,
      deterministic,
      variantId: entry.variantId,
      orderId: entry.orderId,
      type,
      quantity: entry.quantity,
      notes: `Reserved ${entry.quantity} units (batch)${entry.orderId ? ` for order ${entry.orderId}` : ""}`,
      ...edge,
    });
  }

  return claims;
}

function buildReservationMovementInsert(
  db: Database,
  claim: ReservationMovementClaim,
  variant: ReservationVariantState,
) {
  return db
    .insert(inventoryMovements)
    .select(sql`
      SELECT
        ${claim.id},
        ${claim.variantId},
        ${claim.orderId ?? null},
        ${claim.type},
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
        unixepoch()
      FROM ${productVariants}
      WHERE ${productVariants.id} = ${claim.variantId}
        AND ${productVariants.stockVersion} = ${variant.stockVersion}
    `)
    .returning({ id: inventoryMovements.id });
}

/**
 * Brand-new checkout orders do not need a stale application-side CAS value.
 * Derive the complete ledger edge from the row visible inside the transaction
 * so a provider-level BEGIN CONCURRENT retry can safely re-evaluate it after a
 * competing checkout commits.
 */
function buildFreshReservationMovementInsert(
  db: Database,
  claim: ReservationMovementClaim,
  pool: ReservationPool,
) {
  const variant = {
    id: sql.raw('"product_variants"."id"'),
    productId: sql.raw('"product_variants"."product_id"'),
    stock: sql.raw('"product_variants"."stock"'),
    reservedStock: sql.raw('"product_variants"."reserved_stock"'),
    preorderStock: sql.raw('"product_variants"."preorder_stock"'),
    trackInventory: sql.raw('"product_variants"."track_inventory"'),
    stockVersion: sql.raw('"product_variants"."stock_version"'),
    allowPreorder: sql.raw('"product_variants"."allow_preorder"'),
    allowBackorder: sql.raw('"product_variants"."allow_backorder"'),
    backorderLimit: sql.raw('"product_variants"."backorder_limit"'),
    deletedAt: sql.raw('"product_variants"."deleted_at"'),
  };
  const product = {
    id: sql.raw('"products"."id"'),
    isActive: sql.raw('"products"."is_active"'),
    deletedAt: sql.raw('"products"."deleted_at"'),
  };
  const availability = pool === "preorder"
    ? sql`${variant.allowPreorder} = 1
        AND ${variant.preorderStock} >= ${claim.quantity}`
    : pool === "backorder"
      ? sql`${variant.allowBackorder} = 1
          AND (
            ${variant.backorderLimit} = 0
            OR ${variant.reservedStock}
              + ${coordinatedRegularReservedStockSql(variant.id)}
              + ${claim.quantity} <= ${variant.backorderLimit}
          )`
      : sql`${variant.stock} - ${variant.reservedStock}
          - ${coordinatedRegularReservedStockSql(variant.id)} >= ${claim.quantity}`;
  const nextPreorderStock = pool === "preorder"
    ? sql`${variant.preorderStock} - ${claim.quantity}`
    : sql`${variant.preorderStock}`;
  const preorderDelta = pool === "preorder" ? -claim.quantity : 0;

  return db
    .insert(inventoryMovements)
    .select(sql`
      SELECT
        ${claim.id},
        ${variant.id},
        ${claim.orderId ?? null},
        ${claim.type},
        ${claim.quantity},
        ${variant.stock},
        ${variant.stock},
        ${claim.notes},
        NULL,
        2,
        ${pool},
        ${claim.reservationGeneration},
        ${variant.stockVersion},
        ${variant.stockVersion} + 1,
        0,
        ${variant.reservedStock},
        ${variant.reservedStock} + ${claim.quantity},
        ${claim.quantity},
        ${variant.preorderStock},
        ${nextPreorderStock},
        ${preorderDelta},
        unixepoch()
      FROM ${productVariants}
      INNER JOIN ${products}
        ON ${product.id} = ${variant.productId}
      WHERE ${variant.id} = ${claim.variantId}
        AND ${variant.trackInventory} = 1
        AND ${variant.deletedAt} IS NULL
        AND ${product.isActive} = 1
        AND ${product.deletedAt} IS NULL
        AND ${availability}
    `)
    .returning({ id: inventoryMovements.id });
}

function buildFreshReservationCounterUpdate(
  db: Database,
  claim: ReservationMovementClaim,
) {
  const movement = {
    id: sql.raw('"inventory_movements"."id"'),
    variantId: sql.raw('"inventory_movements"."variant_id"'),
    stockVersionBefore: sql.raw('"inventory_movements"."stock_version_before"'),
  };
  const variant = {
    id: sql.raw('"product_variants"."id"'),
    stockVersion: sql.raw('"product_variants"."stock_version"'),
  };
  const movementMatchesCurrentVersion = sql`EXISTS (
    SELECT 1
    FROM ${inventoryMovements}
    WHERE ${movement.id} = ${claim.id}
      AND ${movement.variantId} = ${variant.id}
      AND ${movement.stockVersionBefore} = ${variant.stockVersion}
  )`;

  return db
    .update(productVariants)
    .set({
      reservedStock: sql`${productVariants.reservedStock} + ${claim.quantity}`,
      ...(claim.pool === "preorder"
        ? {
            preorderStock: sql`${productVariants.preorderStock} - ${claim.quantity}`,
          }
        : {}),
      stockVersion: sql`${productVariants.stockVersion} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(productVariants.id, claim.variantId),
      isNull(productVariants.deletedAt),
      movementMatchesCurrentVersion,
    ))
    .returning({
      id: productVariants.id,
      stock: productVariants.stock,
      reservedStock: effectiveRegularReservedStockSql(),
    });
}

function buildFreshReservationFinalGuard(
  db: Database,
  claim: ReservationMovementClaim,
): SQLiteBatchItem {
  const variant = {
    id: sql.raw('"product_variants"."id"'),
    stock: sql.raw('"product_variants"."stock"'),
    reservedStock: sql.raw('"product_variants"."reserved_stock"'),
    preorderStock: sql.raw('"product_variants"."preorder_stock"'),
    stockVersion: sql.raw('"product_variants"."stock_version"'),
  };
  const movement = {
    id: sql.raw('"inventory_movements"."id"'),
    variantId: sql.raw('"inventory_movements"."variant_id"'),
    orderId: sql.raw('"inventory_movements"."order_id"'),
    type: sql.raw('"inventory_movements"."type"'),
    quantity: sql.raw('"inventory_movements"."quantity"'),
    pool: sql.raw('"inventory_movements"."pool"'),
    reservationGeneration: sql.raw('"inventory_movements"."reservation_generation"'),
    stockVersionAfter: sql.raw('"inventory_movements"."stock_version_after"'),
    newStock: sql.raw('"inventory_movements"."new_stock"'),
    newReservedStock: sql.raw('"inventory_movements"."new_reserved_stock"'),
    newPreorderStock: sql.raw('"inventory_movements"."new_preorder_stock"'),
  };
  return buildBatchGuard(db, sql`EXISTS (
    SELECT 1
    FROM ${productVariants}
    INNER JOIN ${inventoryMovements}
      ON ${movement.variantId} = ${variant.id}
    WHERE ${variant.id} = ${claim.variantId}
      AND ${movement.id} = ${claim.id}
      AND ${movement.orderId} = ${claim.orderId ?? null}
      AND ${movement.type} = ${claim.type}
      AND ${movement.quantity} = ${claim.quantity}
      AND ${movement.pool} = ${claim.pool}
      AND ${movement.reservationGeneration} = ${claim.reservationGeneration}
      AND ${variant.stockVersion} = ${movement.stockVersionAfter}
      AND ${variant.stock} = ${movement.newStock}
      AND ${variant.reservedStock} = ${movement.newReservedStock}
      AND ${variant.preorderStock} = ${movement.newPreorderStock}
  )`, INVENTORY_RESERVATION_CONFLICT);
}

function findVariantWithMultipleReservationOrders(
  entries: ReservationBatchItem[],
): string | null {
  const ordersByVariant = new Map<string, Set<string>>();
  for (const entry of entries) {
    const orderKey = entry.orderId ?? "__no_order__";
    const orders = ordersByVariant.get(entry.variantId) ?? new Set<string>();
    orders.add(orderKey);
    ordersByVariant.set(entry.variantId, orders);
    if (orders.size > 1) return entry.variantId;
  }
  return null;
}

function isDuplicateReservationMovementClaimError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("reservation:") ||
    (message.includes("UNIQUE constraint failed") &&
      message.includes("inventory_movements"))
  );
}

async function resolveDuplicateReservationBatch(
  db: Database,
  movementClaims: ReservationMovementClaim[],
  entries: ReservationBatchItem[],
  variants: Map<string, ReservationVariantState>,
  pool: ReservationPool,
  err: unknown,
): Promise<ReserveStockBatchResult | null> {
  const deterministicClaims = movementClaims.filter((claim) => claim.deterministic);
  if (
    deterministicClaims.length === 0 ||
    deterministicClaims.length !== movementClaims.length ||
    !isDuplicateReservationMovementClaimError(err)
  ) {
    return null;
  }

  const existingRows = await db
    .select({
      id: inventoryMovements.id,
      variantId: inventoryMovements.variantId,
      orderId: inventoryMovements.orderId,
      type: inventoryMovements.type,
      quantity: inventoryMovements.quantity,
    })
    .from(inventoryMovements)
    .where(inArray(inventoryMovements.id, deterministicClaims.map((claim) => claim.id)))
    .all();
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const mismatched = deterministicClaims.find((claim) => {
    const row = existingById.get(claim.id);
    return !row ||
      row.variantId !== claim.variantId ||
      row.orderId !== (claim.orderId ?? null) ||
      row.type !== claim.type ||
      row.quantity !== claim.quantity;
  });

  if (mismatched) {
    return {
      success: false,
      results: entries.map((entry) => ({
        success: false,
        variantId: entry.variantId,
        previousStock: 0,
        newStock: 0,
        error: "Reservation claim mismatch requires manual inventory reconciliation",
      })),
      error: "Reservation claim mismatch requires manual inventory reconciliation",
      manualReconciliationRequired: true,
    };
  }

  return {
    success: true,
    results: buildReservationSuccessResults(entries, variants, pool),
  };
}

export async function validateStockBatchAvailability(
  db: Database,
  items: ReservationBatchItem[],
  pool: ReservationPool = "regular",
): Promise<{ success: boolean; results: StockOperationResult[]; error?: string }> {
  if (items.length === 0) {
    return { success: true, results: [] };
  }

  const entries = mergeReservationItemsByVariant(items);
  const variantLoad = await loadReservationVariantStates(db, entries);
  if (!variantLoad.success) return variantLoad;

  const validationErrors = getStockAvailabilityErrors(entries, variantLoad.variants, pool);
  if (validationErrors.length > 0) {
    return {
      success: false,
      results: validationErrors,
      error: validationErrors[0]?.error,
    };
  }

  return {
    success: true,
    results: buildReservationSuccessResults(entries, variantLoad.variants, pool),
  };
}

function buildReservationSuccessResults(
  entries: ReservationBatchItem[],
  variants: Map<string, ReservationVariantState>,
  pool: ReservationPool,
): StockOperationResult[] {
  return entries.map((entry) => {
    const variant = variants.get(entry.variantId)!;
    return {
      success: true,
      variantId: entry.variantId,
      previousStock: pool === "preorder" ? variant.preorderStock : variant.stock,
      newStock:
        pool === "preorder" && variant.trackInventory
          ? variant.preorderStock - entry.quantity
          : variant.stock,
    };
  });
}

function mergeReservationItemsByVariant(items: ReservationBatchItem[]): ReservationBatchItem[] {
  const merged = new Map<string, ReservationBatchItem>();
  for (const item of items) {
    const existing = merged.get(item.variantId);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      merged.set(item.variantId, { ...item });
    }
  }
  return Array.from(merged.values());
}

async function loadReservationVariantStates(
  db: Database,
  entries: ReservationBatchItem[],
): Promise<
  | { success: true; variants: Map<string, ReservationVariantState> }
  | { success: false; results: StockOperationResult[]; error: string }
> {
  const requestedVariantIds = entries.map((entry) => entry.variantId);
  const rows = await db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
      legacyReservedStock: productVariants.reservedStock,
      reservedStock: effectiveRegularReservedStockSql(),
      preorderStock: productVariants.preorderStock,
      allowPreorder: productVariants.allowPreorder,
      allowBackorder: productVariants.allowBackorder,
      backorderLimit: productVariants.backorderLimit,
      trackInventory: productVariants.trackInventory,
      stockVersion: productVariants.stockVersion,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        inArray(productVariants.id, requestedVariantIds),
        isNull(productVariants.deletedAt),
        eq(products.isActive, true),
        isNull(products.deletedAt),
      ),
    )
    .all();

  const variants = new Map<string, ReservationVariantState>(
    rows.map((variant) => [variant.id, variant]),
  );
  const missingEntries = entries.filter((entry) => !variants.has(entry.variantId));

  if (missingEntries.length > 0) {
    return {
      success: false,
      results: missingEntries.map((entry) => ({
        success: false,
        variantId: entry.variantId,
        previousStock: 0,
        newStock: 0,
        error: `Variant ${entry.variantId} not found`,
      })),
      error: `Variant ${missingEntries[0]!.variantId} not found`,
    };
  }

  return { success: true, variants };
}

function getStockAvailabilityErrors(
  entries: ReservationBatchItem[],
  variants: Map<string, ReservationVariantState>,
  pool: "regular" | "preorder" | "backorder",
): StockOperationResult[] {
  const validationErrors: StockOperationResult[] = [];
  for (const entry of entries) {
    const variant = variants.get(entry.variantId)!;
    const error = validateStockAvailability(variant, entry.quantity, pool);
    if (error) {
      validationErrors.push({
        success: false,
        variantId: entry.variantId,
        previousStock: pool === "preorder" ? variant.preorderStock : variant.stock,
        newStock: pool === "preorder" ? variant.preorderStock : variant.stock,
        error,
      });
    }
  }
  return validationErrors;
}

export function groupReservationMovementsForAudit(
  items: ReservationBatchItem[],
): ReservationBatchItem[] {
  const grouped = new Map<string, ReservationBatchItem>();

  for (const item of items) {
    const orderKey = item.orderId ?? "";
    const key = `${item.variantId}\0${orderKey}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.quantity += item.quantity;
    } else {
      grouped.set(key, { ...item });
    }
  }

  return Array.from(grouped.values());
}

/**
 * Validate stock availability for a single variant.
 * Returns an error string if insufficient, or null if OK.
 */
function validateStockAvailability(
  variant: {
    id: string;
    stock: number;
    reservedStock: number;
    preorderStock: number;
    allowPreorder: boolean;
    allowBackorder: boolean;
    backorderLimit: number;
    trackInventory: boolean;
  },
  quantity: number,
  pool: "regular" | "preorder" | "backorder"
): string | null {
  if (!variant.trackInventory) {
    return null;
  }

  if (pool === "preorder") {
    if (!variant.allowPreorder) {
      return `Pre-order not allowed for variant ${variant.id}`;
    }
    if (variant.preorderStock < quantity) {
      return `Insufficient pre-order stock for variant ${variant.id}. Available: ${variant.preorderStock}, Requested: ${quantity}`;
    }
  } else if (pool === "backorder") {
    if (!variant.allowBackorder) {
      return `Backorder not allowed for variant ${variant.id}`;
    }
    if (variant.backorderLimit > 0 && variant.reservedStock + quantity > variant.backorderLimit) {
      return `Backorder limit exceeded for variant ${variant.id}`;
    }
  } else {
    const available = variant.stock - variant.reservedStock;
    if (available < quantity) {
      return `Insufficient stock for variant ${variant.id}. Available: ${available}, Requested: ${quantity}`;
    }
  }
  return null;
}

// Internal helper to avoid circular import with release module
async function releaseReservationInternal(
  db: Database,
  variantId: string,
  quantity: number,
  orderId?: string,
  pool: "regular" | "preorder" | "backorder" = "regular"
): Promise<void> {
  await db
    .update(productVariants)
    .set({
      reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${quantity})`,
      ...(pool === "preorder"
        ? { preorderStock: sql`${productVariants.preorderStock} + ${quantity}` }
        : {}),
      stockVersion: sql`${productVariants.stockVersion} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(productVariants.id, variantId));

  // Log the rollback
  await recordMovement(db, {
    variantId,
    orderId,
    type: "released",
    quantity: -quantity,
    previousStock: 0, // Approximate — not critical for rollback logs
    newStock: 0,
    notes: `Reservation rollback (batch failure)`,
  });
}
