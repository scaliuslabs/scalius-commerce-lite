import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import {
  inventoryOperations,
  productVariants,
} from "@scalius/database/schema";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import { and, eq, isNull, sql } from "drizzle-orm";
import { checkAndAlertLowStock } from "./alerts";
import { buildStockMovementClaim } from "./stock-movement-claims";
import {
  activeLocationOnHandFrom,
  inventoryLocationErrorFrom,
  isInventoryLevelShortfallError,
  isInventoryLocationRequiredError,
  selectActiveLocationOnHand,
  type InventoryLocationRef,
} from "./locations";
import {
  buildNotDigitalSkuGuard,
  catalogBuyerStateRefreshStatementsForSkus,
  digitalStockError,
  isDigitalKind,
  rethrowDigitalStockRuleViolation,
} from "../products";
import {
  validateAbsoluteStockCount,
  validateSignedStockAdjustment,
} from "./validation";
import { sha256Hex } from "@scalius/shared/hash";

const MAX_CAS_RETRIES = 3;
const BASE_BACKOFF_MS = 50;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export type InventoryOperationType =
  | "manual_adjustment"
  | "scanner_adjustment"
  | "stocktake"
  /** Licence keys imported into (+n) or revoked from (-n) a key pool: the pool is the variant's stock. */
  | "licence_keys";

const INVENTORY_OPERATION_TYPES: readonly InventoryOperationType[] = [
  "manual_adjustment",
  "scanner_adjustment",
  "stocktake",
  "licence_keys",
];

/** The companion guard: the counter edge of this batch committed, or nothing does. */
const COMPANION_CAS_MARKER = "INVENTORY_COMPANION_CAS";

export interface InventoryOperationOptions {
  /**
   * Statements that must commit in the same batch as the stock edge (the
   * licence keys an import adds or a revoke retires). They run after the
   * counter update, behind a guard that aborts the whole batch when the
   * compare-and-set lost, so they never commit without the edge. Only for
   * operations that change the counter (delta ≠ 0).
   */
  companionStatements?: readonly BatchItem<"sqlite">[];
  /**
   * Reads that ride at the end of the commit batch, so they see the committed
   * stock at no extra round trip (a stable stock write answering its SKU).
   * Their results land in `rows` only when this run's own batch committed; a
   * replay or a lost race leaves `rows` unset and the caller reads instead.
   */
  readAfter?: InventoryReadAfter;
}

export interface InventoryReadAfter {
  statements: readonly BatchItem<"sqlite">[];
  rows?: unknown[];
}

export type InventoryOperationPool = "stock" | "preorderStock";

export interface InventoryOperationResult {
  variantId: string;
  /** The SKU's on-hand across every location, before and after. */
  previousStock: number;
  newStock: number;
  delta: number;
  /** On-hand stock only: the location the units moved at, and its count before and after. */
  locationId?: string;
  locationPreviousStock?: number;
  locationNewStock?: number;
}

type InventoryOperationBase = {
  operationKey: string;
  operationType: InventoryOperationType;
  variantId: string;
  pool: InventoryOperationPool;
  reason: string;
  notes?: string;
  /**
   * On-hand stock only: the active location counted or adjusted (the default
   * when omitted). Part of the request hash; a stocktake counts that
   * location, and a relative change applies there.
   */
  locationId?: string | null;
  /**
   * The SKU's `stockVersion` the caller read: any stock change since refuses
   * (409) instead of applying. Exact: the write's own stockVersion CAS
   * covers it. Omit to apply whatever happened since.
   */
  expectedStockVersion?: number;
};

export type InventoryOperationInput =
  | (InventoryOperationBase & { mode: "relative"; delta: number })
  | (InventoryOperationBase & { mode: "stocktake"; newStock: number });

type InventoryVariantState = {
  id: string;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  stockVersion: number;
  fulfillmentKind?: string;
};

type ExistingOperationRow = {
  requestHash: string;
  resultPayload: string;
};

export function normalizeInventoryOperationKey(value: string): string {
  const operationKey = value.trim();
  if (!OPERATION_KEY_PATTERN.test(operationKey)) {
    throw new ValidationError(
      "operationKey must be 16-128 characters using letters, numbers, dots, colons, underscores, or hyphens",
    );
  }
  return operationKey;
}

export async function buildInventoryOperationRequestHash(
  input: InventoryOperationInput,
): Promise<string> {
  const canonical = normalizeInventoryOperationRequest(input);
  return hashNormalizedRequest(canonical);
}

/**
 * Commits a merchant inventory command and its replay record as one D1 batch.
 * No pending row is written before the counter edge, so an operation key can
 * never claim success without the matching ledger-v2 movement and CAS update.
 */
export async function executeInventoryOperation(
  db: Database,
  input: InventoryOperationInput,
  adminUserId?: string,
  options: InventoryOperationOptions = {},
): Promise<InventoryOperationResult> {
  const companionStatements = options.companionStatements ?? [];
  const normalized = normalizeInventoryOperationRequest(input);
  const requestHash = await hashNormalizedRequest(normalized);
  const physical = normalized.pool === "stock";
  // One read batch (one D1 call): the key's earlier result, the SKU and, for
  // physical stock, the location with the SKU's on-hand there. Every level
  // change bumps the SKU's stockVersion, so the on-hand is covered by the
  // same compare-and-set as the counters.
  const readState = async (withOperation: boolean) => {
    const rows = await safeBatch(db, [
      inventoryVariantQuery(db, normalized.variantId),
      ...(physical ? [selectActiveLocationOnHand(db, normalized.locationId, normalized.variantId)] : []),
      ...(withOperation ? [inventoryOperationQuery(db, normalized.operationKey)] : []),
    ] as never) as unknown[][];
    return {
      variant: (rows[0]?.[0] as InventoryVariantState | undefined) ?? null,
      location: physical ? rows[1] as Parameters<typeof activeLocationOnHandFrom>[0] : null,
      existing: withOperation ? (rows[physical ? 2 : 1]?.[0] as ExistingOperationRow | undefined) ?? null : null,
    };
  };
  let state = await readState(true);
  if (state.existing) {
    const replay = replayInventoryOperation(state.existing, requestHash);
    if (normalized.pool === "stock") {
      await checkAndAlertLowStock(db, normalized.variantId);
    }
    return replay;
  }

  const movementId = `imov_${(await sha256Hex(`inventory-operation:${normalized.operationKey}`)).slice(0, 48)}`;

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    if (attempt > 0) state = await readState(false);
    // Physical stock moves at a location; preorder allocation has none.
    const located = state.location ? activeLocationOnHandFrom(state.location, normalized.locationId) : null;
    const location: InventoryLocationRef | null = located ? { id: located.id, name: located.name } : null;
    const { variant } = state;
    if (!variant) throw new NotFoundError("Variant not found");
    if (input.expectedStockVersion !== undefined && variant.stockVersion !== input.expectedStockVersion) {
      throw new ConflictError("This SKU's stock changed since you read it. Read it again, then retry.");
    }
    const locationPreviousStock = located?.onHand;

    const previousStock = normalized.pool === "preorderStock"
      ? variant.preorderStock
      : variant.stock;
    // A stocktake counts the location; a relative change applies there.
    const counted = locationPreviousStock ?? previousStock;
    const countedAfter = normalized.mode === "relative"
      ? counted + normalized.delta
      : normalized.newStock;
    // A digital SKU's stock is its licence keys: only key import and revoke
    // move it (a count that matches changes nothing and is fine).
    if (
      normalized.operationType !== "licence_keys"
      && isDigitalKind(variant.fulfillmentKind)
      && countedAfter !== counted
    ) {
      throw digitalStockError({ variantId: normalized.variantId });
    }
    if (location && countedAfter < 0) {
      throw new ValidationError(
        `${location.name} has ${counted} on hand, so at most ${counted} can be removed there.`,
      );
    }
    validateAbsoluteStockCount(countedAfter, "resulting stock");
    const delta = countedAfter - counted;
    const newStock = previousStock + delta;
    validateAbsoluteStockCount(newStock, "resulting stock");
    if (
      normalized.pool === "stock"
      && newStock < previousStock
      && newStock < variant.reservedStock
    ) {
      throw new ValidationError(
        `Resulting stock cannot be lower than ${variant.reservedStock} reserved units`,
      );
    }
    if (companionStatements.length > 0 && delta === 0) {
      throw new ValidationError("An inventory operation with companion statements must change the stock.");
    }
    const result: InventoryOperationResult = {
      variantId: normalized.variantId,
      previousStock,
      newStock,
      delta,
      ...(location
        ? { locationId: location.id, locationPreviousStock: counted, locationNewStock: countedAfter }
        : {}),
    };

    try {
      const committed = delta === 0
        ? await commitNoopOperation(
          db,
          normalized,
          requestHash,
          result,
          variant,
          adminUserId,
          options.readAfter,
        )
        : await commitCounterOperation(
          db,
          normalized,
          requestHash,
          result,
          variant,
          movementId,
          location,
          adminUserId,
          companionStatements,
          options.readAfter,
        );

      if (committed) {
        if (normalized.pool === "stock") {
          await checkAndAlertLowStock(db, normalized.variantId);
        }
        return result;
      }
    } catch (error) {
      // The location lost the units (or was archived) since the read: the
      // whole batch rolled back, so say what the merchant can fix.
      if (isInventoryLevelShortfallError(error) || isInventoryLocationRequiredError(error)) {
        throw inventoryLocationErrorFrom(error, location?.name);
      }
      // The SKU turned digital since the read: its stock is now its keys.
      rethrowDigitalStockRuleViolation(error);
      const racedOperation = await selectInventoryOperation(
        db,
        normalized.operationKey,
      );
      if (racedOperation) {
        const replay = replayInventoryOperation(racedOperation, requestHash);
        if (normalized.pool === "stock") {
          await checkAndAlertLowStock(db, normalized.variantId);
        }
        return replay;
      }
      // A lost compare-and-set rolled the companions back: read and retry.
      if (!(companionStatements.length > 0 && isBatchGuardError(error, COMPANION_CAS_MARKER))) {
        throw error;
      }
    }

    const racedOperation = await selectInventoryOperation(
      db,
      normalized.operationKey,
    );
    if (racedOperation) {
      const replay = replayInventoryOperation(racedOperation, requestHash);
      if (normalized.pool === "stock") {
        await checkAndAlertLowStock(db, normalized.variantId);
      }
      return replay;
    }

    if (attempt < MAX_CAS_RETRIES - 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, BASE_BACKOFF_MS * (2 ** attempt));
      });
    }
  }

  throw new ConflictError(
    `Failed to commit inventory operation after ${MAX_CAS_RETRIES} retries due to concurrent modifications`,
  );
}

type NormalizedInventoryOperation = ReturnType<typeof normalizeInventoryOperationRequest>;

async function commitCounterOperation(
  db: Database,
  input: NormalizedInventoryOperation,
  requestHash: string,
  result: InventoryOperationResult,
  variant: InventoryVariantState,
  movementId: string,
  location: InventoryLocationRef | null,
  adminUserId?: string,
  companionStatements: readonly BatchItem<"sqlite">[] = [],
  readAfter?: InventoryReadAfter,
): Promise<boolean> {
  const nextVersion = variant.stockVersion + 1;
  const movementInsert = buildStockMovementClaim(db, {
    movementId,
    variantId: input.variantId,
    pool: input.pool === "preorderStock" ? "preorder" : "regular",
    quantity: result.delta,
    before: variant,
    after: {
      stock: input.pool === "stock" ? result.newStock : variant.stock,
      reservedStock: variant.reservedStock,
      preorderStock: input.pool === "preorderStock"
        ? result.newStock
        : variant.preorderStock,
      stockVersion: nextVersion,
    },
    notes: formatMovementNotes(input, result),
    adminUserId,
    ...(location ? { locationId: location.id } : {}),
  });
  const operationInsert = buildOperationInsert(db, {
    input,
    requestHash,
    result,
    movementId,
    stockVersionBefore: variant.stockVersion,
    stockVersionAfter: nextVersion,
    adminUserId,
  });
  const stockUpdate = db
    .update(productVariants)
    .set(input.pool === "preorderStock"
      ? {
        preorderStock: result.newStock,
        stockVersion: sql`${productVariants.stockVersion} + 1`,
        updatedAt: sql`unixepoch()`,
      }
      : {
        stock: result.newStock,
        stockVersion: sql`${productVariants.stockVersion} + 1`,
        updatedAt: sql`unixepoch()`,
      })
    .where(and(
      eq(productVariants.id, input.variantId),
      eq(productVariants.stockVersion, variant.stockVersion),
      isNull(productVariants.deletedAt),
      input.pool === "stock" && result.newStock < variant.stock
        ? sql`${productVariants.reservedStock} <= ${result.newStock}`
        : undefined,
    ))
    .returning({ id: productVariants.id });

  const results = await safeBatch(
    db,
    [
      movementInsert,
      operationInsert,
      stockUpdate,
      // Buyer state reads the counter this batch just wrote.
      ...catalogBuyerStateRefreshStatementsForSkus(db, [input.variantId]),
      // Only key import and revoke move a digital SKU: a kind change racing
      // this manual write aborts it.
      ...(input.operationType === "licence_keys" ? [] : [buildNotDigitalSkuGuard(db, input.variantId)]),
      ...(companionStatements.length > 0
        ? [
          buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${inventoryOperations}
            WHERE ${inventoryOperations.operationKey} = ${input.operationKey}
              AND ${inventoryOperations.movementId} = ${movementId}
          ) AND EXISTS (
            SELECT 1 FROM ${productVariants}
            WHERE ${productVariants.id} = ${input.variantId}
              AND ${productVariants.stockVersion} = ${nextVersion}
              AND ${input.pool === "preorderStock" ? productVariants.preorderStock : productVariants.stock} = ${result.newStock}
          )`, COMPANION_CAS_MARKER),
          ...companionStatements,
        ]
        : []),
      ...(readAfter?.statements ?? []),
    ] as never,
  ) as Array<Array<{ id?: string; operationKey?: string }>>;
  const [movementRows, operationRows, updateRows] = results;

  const committed = Boolean(
    movementRows?.[0]?.id &&
    operationRows?.[0]?.operationKey &&
    updateRows?.[0]?.id,
  );
  if (committed) keepReadAfter(readAfter, results);
  return committed;
}

function keepReadAfter(readAfter: InventoryReadAfter | undefined, results: unknown[]): void {
  if (readAfter && readAfter.statements.length > 0) readAfter.rows = results.slice(-readAfter.statements.length);
}

async function commitNoopOperation(
  db: Database,
  input: NormalizedInventoryOperation,
  requestHash: string,
  result: InventoryOperationResult,
  variant: InventoryVariantState,
  adminUserId?: string,
  readAfter?: InventoryReadAfter,
): Promise<boolean> {
  const operationInsert = buildOperationInsert(db, {
    input,
    requestHash,
    result,
    movementId: null,
    stockVersionBefore: variant.stockVersion,
    stockVersionAfter: variant.stockVersion,
    adminUserId,
  });
  const results = await safeBatch(
    db,
    [operationInsert, ...(readAfter?.statements ?? [])] as never,
  ) as Array<Array<{ operationKey?: string }>>;
  const committed = Boolean(results[0]?.[0]?.operationKey);
  if (committed) keepReadAfter(readAfter, results);
  return committed;
}

function buildOperationInsert(
  db: Database,
  params: {
    input: NormalizedInventoryOperation;
    requestHash: string;
    result: InventoryOperationResult;
    movementId: string | null;
    stockVersionBefore: number;
    stockVersionAfter: number;
    adminUserId?: string;
  },
) {
  return db
    .insert(inventoryOperations)
    .select(sql`
      SELECT
        ${params.input.operationKey},
        ${params.requestHash},
        ${params.input.operationType},
        ${params.input.variantId},
        ${params.movementId},
        ${JSON.stringify(params.result)},
        ${params.stockVersionBefore},
        ${params.stockVersionAfter},
        ${params.adminUserId ?? null},
        unixepoch()
      FROM ${productVariants}
      WHERE ${productVariants.id} = ${params.input.variantId}
        AND ${productVariants.stockVersion} = ${params.stockVersionBefore}
        AND ${productVariants.deletedAt} IS NULL
    `)
    .returning({ operationKey: inventoryOperations.operationKey });
}

function inventoryVariantQuery(db: Database, variantId: string) {
  return db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      preorderStock: productVariants.preorderStock,
      stockVersion: productVariants.stockVersion,
      fulfillmentKind: productVariants.fulfillmentKind,
    })
    .from(productVariants)
    .where(and(
      eq(productVariants.id, variantId),
      isNull(productVariants.deletedAt),
    ));
}

function inventoryOperationQuery(db: Database, operationKey: string) {
  return db
    .select({
      requestHash: inventoryOperations.requestHash,
      resultPayload: inventoryOperations.resultPayload,
    })
    .from(inventoryOperations)
    .where(eq(inventoryOperations.operationKey, operationKey));
}

async function selectInventoryOperation(
  db: Database,
  operationKey: string,
): Promise<ExistingOperationRow | null> {
  return (await inventoryOperationQuery(db, operationKey).get()) ?? null;
}

function replayInventoryOperation(
  row: ExistingOperationRow,
  requestHash: string,
): InventoryOperationResult {
  if (row.requestHash !== requestHash) {
    throw new ConflictError(
      "This inventory operation key was already used for a different request",
    );
  }

  try {
    const value = JSON.parse(row.resultPayload) as Partial<InventoryOperationResult>;
    if (
      typeof value.variantId !== "string" ||
      !Number.isSafeInteger(value.previousStock) ||
      !Number.isSafeInteger(value.newStock) ||
      !Number.isSafeInteger(value.delta)
    ) {
      throw new Error("Invalid inventory operation result");
    }
    return {
      variantId: value.variantId,
      previousStock: value.previousStock!,
      newStock: value.newStock!,
      delta: value.delta!,
      ...(typeof value.locationId === "string"
        && Number.isSafeInteger(value.locationPreviousStock)
        && Number.isSafeInteger(value.locationNewStock)
        ? {
          locationId: value.locationId,
          locationPreviousStock: value.locationPreviousStock!,
          locationNewStock: value.locationNewStock!,
        }
        : {}),
    };
  } catch {
    throw new ServiceUnavailableError(
      "Committed inventory operation result is unreadable; no stock change was retried",
    );
  }
}

function normalizeInventoryOperationRequest(input: InventoryOperationInput) {
  const operationKey = normalizeInventoryOperationKey(input.operationKey);
  const variantId = input.variantId.trim();
  const reason = input.reason.trim();
  const notes = input.notes?.trim() || null;
  const locationId = input.locationId?.trim() || null;
  if (!INVENTORY_OPERATION_TYPES.includes(input.operationType)) {
    throw new ValidationError("Unsupported inventory operation type");
  }
  if (input.pool !== "stock" && input.pool !== "preorderStock") {
    throw new ValidationError("Unsupported inventory pool");
  }
  if (!variantId) throw new ValidationError("variantId is required");
  if (!reason) throw new ValidationError("reason is required");
  if (reason.length > 500 || (notes?.length ?? 0) > 500) {
    throw new ValidationError("Inventory operation reason and notes must be at most 500 characters");
  }
  if (input.operationType === "stocktake" && input.mode !== "stocktake") {
    throw new ValidationError("Stocktake operations require an absolute count");
  }
  if (input.operationType !== "stocktake" && input.mode !== "relative") {
    throw new ValidationError("Relative inventory operations require an adjustment delta");
  }
  if (locationId && input.pool !== "stock") {
    throw new ValidationError("Preorder stock isn't held at a location");
  }
  if (locationId && locationId.length > 100) {
    throw new ValidationError("locationId is invalid");
  }
  if (input.mode === "relative") {
    validateSignedStockAdjustment(input.delta);
    return {
      schemaVersion: 2 as const,
      operationKey,
      operationType: input.operationType,
      variantId,
      pool: input.pool,
      locationId,
      mode: input.mode,
      delta: input.delta,
      reason,
      notes,
    };
  }
  validateAbsoluteStockCount(input.newStock);
  if (input.pool !== "stock") {
    throw new ValidationError("Stocktake currently supports on-hand stock only");
  }
  return {
    schemaVersion: 2 as const,
    operationKey,
    operationType: input.operationType,
    variantId,
    pool: input.pool,
    locationId,
    mode: input.mode,
    newStock: input.newStock,
    reason,
    notes,
  };
}

function formatMovementNotes(
  input: NormalizedInventoryOperation,
  result: InventoryOperationResult,
): string {
  const suffix = input.notes ? `: ${input.notes}` : "";
  if (input.operationType === "manual_adjustment") {
    return `Manual adjustment (${input.reason})${suffix}`;
  }
  if (input.operationType === "scanner_adjustment") {
    return `Scanner adjustment (${input.reason})${suffix}`;
  }
  if (input.operationType === "licence_keys") {
    return `Licence keys (${input.reason})${suffix}`;
  }
  // A stocktake counts one location: the note shows that location's count.
  return `Stocktake (${input.reason}): set from ${result.locationPreviousStock ?? result.previousStock} to ${result.locationNewStock ?? result.newStock}${suffix}`;
}

function hashNormalizedRequest(
  input: NormalizedInventoryOperation,
): Promise<string> {
  const { operationKey: _operationKey, ...canonicalRequest } = input;
  return sha256Hex(JSON.stringify(canonicalRequest));
}
