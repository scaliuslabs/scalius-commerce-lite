import { inventoryMovements, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { sql } from "drizzle-orm";
import {
  buildInventoryLedgerV2Edge,
  type InventoryCounterState,
  type InventoryLedgerPool,
} from "./ledger-v2";

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
  },
) {
  const edge = buildInventoryLedgerV2Edge({
    pool: params.pool,
    before: params.before,
    after: params.after,
  });
  return db
    .insert(inventoryMovements)
    .select(sql`
      SELECT
        ${params.movementId},
        ${params.variantId},
        NULL,
        ${"adjusted"},
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
        unixepoch()
      FROM ${productVariants}
      WHERE ${productVariants.id} = ${params.variantId}
        AND ${productVariants.stockVersion} = ${edge.stockVersionBefore}
        AND ${productVariants.deletedAt} IS NULL
    `)
    .returning({ id: inventoryMovements.id });
}
