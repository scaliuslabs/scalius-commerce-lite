import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { listInventoryMovements } from "./inventory.service";

export const INVENTORY_MOVEMENT_EXPORT_MAX_ROWS = 5_000;
export const INVENTORY_MOVEMENT_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
export const INVENTORY_MOVEMENT_EXPORT_PAGE_SIZE = 100;

export type InventoryMovementExportInput = {
  search?: string;
  movementType?: string;
  orderId?: string;
  startDate?: Date;
  endDate?: Date;
  maxRows: number;
};

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function timestampIso(value: string | number | Date): string {
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

type InventoryMovement = Awaited<ReturnType<typeof listInventoryMovements>>["movements"][number];

export function inventoryMovementCsvRow(movement: InventoryMovement): string {
  return [
    timestampIso(movement.createdAt),
    movement.id,
    movement.type,
    movement.variantSku,
    movement.productName,
    movement.orderId,
    movement.actorName,
    movement.pool,
    movement.reservationGeneration,
    movement.stockDelta,
    movement.previousStock,
    movement.newStock,
    movement.reservedStockDelta,
    movement.previousReservedStock,
    movement.newReservedStock,
    movement.preorderStockDelta,
    movement.previousPreorderStock,
    movement.newPreorderStock,
    movement.notes,
  ].map(csvCell).join(",");
}

const HEADER = [
  "Timestamp", "Movement ID", "Type", "SKU", "Product", "Order ID", "Actor",
  "Pool", "Generation", "Stock delta", "Stock before", "Stock after",
  "Reserved delta", "Reserved before", "Reserved after", "Preorder delta",
  "Preorder before", "Preorder after", "Notes",
].map(csvCell).join(",") + "\n";

function appendBounded(chunks: string[], value: string, bytes: number): number {
  const nextBytes = bytes + new TextEncoder().encode(value).byteLength;
  if (nextBytes > INVENTORY_MOVEMENT_EXPORT_MAX_BYTES) {
    throw new ValidationError(
      `Inventory movement export exceeds ${INVENTORY_MOVEMENT_EXPORT_MAX_BYTES} bytes. Narrow the filters or lower maxRows.`,
    );
  }
  chunks.push(value);
  return nextBytes;
}

export async function buildInventoryMovementCsvArtifact(
  db: Database,
  input: InventoryMovementExportInput,
) {
  if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > INVENTORY_MOVEMENT_EXPORT_MAX_ROWS) {
    throw new ValidationError(`Export from 1 through ${INVENTORY_MOVEMENT_EXPORT_MAX_ROWS} movement rows.`);
  }
  const chunks: string[] = [];
  let byteLength = appendBounded(chunks, HEADER, 0);
  let cursor: string | undefined;
  let rowCount = 0;

  while (rowCount < input.maxRows) {
    const result = await listInventoryMovements(db, {
      search: input.search,
      movementType: input.movementType,
      orderId: input.orderId,
      startDate: input.startDate,
      endDate: input.endDate,
      cursor,
      limit: Math.min(INVENTORY_MOVEMENT_EXPORT_PAGE_SIZE, input.maxRows - rowCount),
    });
    if (result.movements.length === 0) break;
    for (const movement of result.movements) {
      byteLength = appendBounded(chunks, `${inventoryMovementCsvRow(movement)}\n`, byteLength);
      rowCount += 1;
      if (rowCount >= input.maxRows) break;
    }
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor || rowCount >= input.maxRows) break;
    cursor = result.pageInfo.nextCursor;
  }

  return {
    body: chunks.join(""),
    byteLength,
    rowCount,
    contentType: "text/csv; charset=utf-8" as const,
    extension: "csv" as const,
  };
}
