import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import {
  inventoryOperations,
  productVariants,
} from "@scalius/database/schema";
import { effectiveRegularReservedStockSql } from "@scalius/database/inventory-authority";
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
  validateAbsoluteStockCount,
  validateSignedStockAdjustment,
} from "./validation";

const MAX_CAS_RETRIES = 3;
const BASE_BACKOFF_MS = 50;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export type InventoryOperationType =
  | "manual_adjustment"
  | "scanner_adjustment"
  | "stocktake";

export type InventoryOperationPool = "stock" | "preorderStock";

export interface InventoryOperationResult {
  variantId: string;
  previousStock: number;
  newStock: number;
  delta: number;
}

type InventoryOperationBase = {
  operationKey: string;
  operationType: InventoryOperationType;
  variantId: string;
  pool: InventoryOperationPool;
  reason: string;
  notes?: string;
};

export type InventoryOperationInput =
  | (InventoryOperationBase & { mode: "relative"; delta: number })
  | (InventoryOperationBase & { mode: "stocktake"; newStock: number });

type InventoryVariantState = {
  id: string;
  stock: number;
  reservedStock: number;
  effectiveReservedStock: number;
  preorderStock: number;
  stockVersion: number;
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
): Promise<InventoryOperationResult> {
  const normalized = normalizeInventoryOperationRequest(input);
  const requestHash = await hashNormalizedRequest(normalized);
  const existing = await selectInventoryOperation(db, normalized.operationKey);
  if (existing) {
    const replay = replayInventoryOperation(existing, requestHash);
    if (normalized.pool === "stock") {
      await checkAndAlertLowStock(db, normalized.variantId);
    }
    return replay;
  }

  const movementId = `imov_${(await sha256Hex(`inventory-operation:${normalized.operationKey}`)).slice(0, 48)}`;

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const variant = await selectInventoryVariant(db, normalized.variantId);
    if (!variant) throw new NotFoundError("Variant not found");

    const previousStock = normalized.pool === "preorderStock"
      ? variant.preorderStock
      : variant.stock;
    const newStock = normalized.mode === "relative"
      ? previousStock + normalized.delta
      : normalized.newStock;
    validateAbsoluteStockCount(newStock, "resulting stock");
    if (
      normalized.pool === "stock"
      && newStock < previousStock
      && newStock < variant.effectiveReservedStock
    ) {
      throw new ValidationError(
        `Resulting stock cannot be lower than ${variant.effectiveReservedStock} reserved units`,
      );
    }
    const delta = newStock - previousStock;
    const result: InventoryOperationResult = {
      variantId: normalized.variantId,
      previousStock,
      newStock,
      delta,
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
        )
        : await commitCounterOperation(
          db,
          normalized,
          requestHash,
          result,
          variant,
          movementId,
          adminUserId,
        );

      if (committed) {
        if (normalized.pool === "stock") {
          await checkAndAlertLowStock(db, normalized.variantId);
        }
        return result;
      }
    } catch (error) {
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
      throw error;
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
  adminUserId?: string,
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
        ? sql`${effectiveRegularReservedStockSql()} <= ${result.newStock}`
        : undefined,
    ))
    .returning({ id: productVariants.id });

  const [movementRows, operationRows, updateRows] = await safeBatch(
    db,
    [movementInsert, operationInsert, stockUpdate] as never,
  ) as Array<Array<{ id?: string; operationKey?: string }>>;

  return Boolean(
    movementRows?.[0]?.id &&
    operationRows?.[0]?.operationKey &&
    updateRows?.[0]?.id,
  );
}

async function commitNoopOperation(
  db: Database,
  input: NormalizedInventoryOperation,
  requestHash: string,
  result: InventoryOperationResult,
  variant: InventoryVariantState,
  adminUserId?: string,
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
  const [operationRows] = await safeBatch(
    db,
    [operationInsert] as never,
  ) as Array<Array<{ operationKey?: string }>>;
  return Boolean(operationRows?.[0]?.operationKey);
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

async function selectInventoryVariant(
  db: Database,
  variantId: string,
): Promise<InventoryVariantState | null> {
  const row = await db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      effectiveReservedStock: effectiveRegularReservedStockSql(),
      preorderStock: productVariants.preorderStock,
      stockVersion: productVariants.stockVersion,
    })
    .from(productVariants)
    .where(and(
      eq(productVariants.id, variantId),
      isNull(productVariants.deletedAt),
    ))
    .get();
  return row ?? null;
}

async function selectInventoryOperation(
  db: Database,
  operationKey: string,
): Promise<ExistingOperationRow | null> {
  const row = await db
    .select({
      requestHash: inventoryOperations.requestHash,
      resultPayload: inventoryOperations.resultPayload,
    })
    .from(inventoryOperations)
    .where(eq(inventoryOperations.operationKey, operationKey))
    .get();
  return row ?? null;
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
  if (!(["manual_adjustment", "scanner_adjustment", "stocktake"] as const).includes(input.operationType)) {
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
  if (input.mode === "relative") {
    validateSignedStockAdjustment(input.delta);
    return {
      schemaVersion: 1 as const,
      operationKey,
      operationType: input.operationType,
      variantId,
      pool: input.pool,
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
    schemaVersion: 1 as const,
    operationKey,
    operationType: input.operationType,
    variantId,
    pool: input.pool,
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
  return `Stocktake (${input.reason}): set from ${result.previousStock} to ${result.newStock}${suffix}`;
}

function hashNormalizedRequest(
  input: NormalizedInventoryOperation,
): Promise<string> {
  const { operationKey: _operationKey, ...canonicalRequest } = input;
  return sha256Hex(JSON.stringify(canonicalRequest));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
