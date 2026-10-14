import { inventoryMovements, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { sql } from "drizzle-orm";
import {
  buildInventoryLedgerV2Edge,
  type InventoryCounterState,
  type InventoryLedgerPool,
  ledgerVersionKeyRead,
} from "./ledger-v2";
import { defaultInventoryLocationIdSql } from "./locations";

/** Ledger-v2 movement types written outside the order transition engine. */
export type StockMovementClaimType = "adjusted" | "received" | "transfer_out" | "transfer_in";

/**
 * One guarded ledger-v2 movement (`adjusted` unless another physical type is
 * named: purchase order receipts and transfers, migration 0109). A movement
 * that changes physical stock books it at `locationId`, or at the default
 * location when none is named (product-editor edits, licence-key pools); one
 * that does not leaves the location null. It inserts only while the SKU is
 * still at `before.stockVersion` and live, unless `allowRetired` (units of a
 * transfer already on the road still arrive for a SKU retired meanwhile).
 */
export function buildStockMovementClaim(
  db: Database,
  params: {
    movementId: string;
    variantId: string;
    pool: InventoryLedgerPool;
    quantity: number;
    before: InventoryCounterState;
    after: InventoryCounterState;
    notes: string;
    adminUserId?: string;
    locationId?: string;
    type?: StockMovementClaimType;
    allowRetired?: boolean;
  },
) {
  const edge = buildInventoryLedgerV2Edge({
    pool: params.pool,
    before: params.before,
    after: params.after,
  });
  const location = edge.stockDelta === 0
    ? sql`NULL`
    : params.locationId
      ? sql`${params.locationId}`
      : defaultInventoryLocationIdSql();
  return db
    .insert(inventoryMovements)
    .select(sql`
      SELECT
        ${params.movementId},
        ${params.variantId},
        NULL,
        ${params.type ?? "adjusted"},
        ${params.quantity},
        ${edge.previousStock},
        ${edge.newStock},
        ${params.notes},
        ${params.adminUserId ?? null},
        ${edge.ledgerVersion},
        ${edge.pool},
        ${edge.reservationGeneration},
        ${edge.stockVersionBefore},
        ${edge.stockVersionAfter},
        ${edge.stockDelta},
        ${edge.previousReservedStock},
        ${edge.newReservedStock},
        ${edge.reservedStockDelta},
        ${edge.previousPreorderStock},
        ${edge.newPreorderStock},
        ${edge.preorderStockDelta},
        unixepoch(),
        ${location}
      FROM ${productVariants}
      WHERE ${productVariants.id} = ${params.variantId}
        AND ${productVariants.stockVersion} = ${edge.stockVersionBefore}
        ${params.allowRetired ? sql`` : sql`AND ${productVariants.deletedAt} IS NULL`}
        ${ledgerVersionKeyRead(edge.stockVersionAfter)}
    `)
    .returning({ id: inventoryMovements.id });
}
