import { inventoryMovements, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { sql } from "drizzle-orm";

export function buildStockMovementClaim(
  db: Database,
  params: {
    movementId: string;
    variantId: string;
    stockVersion: number;
    quantity: number;
    previousStock: number;
    newStock: number;
    notes: string;
    adminUserId?: string;
  },
) {
  return db
    .insert(inventoryMovements)
    .select(sql`
      SELECT
        ${params.movementId},
        ${params.variantId},
        NULL,
        ${"adjusted"},
        ${params.quantity},
        ${params.previousStock},
        ${params.newStock},
        ${params.notes},
        ${params.adminUserId ?? null},
        unixepoch()
      FROM ${productVariants}
      WHERE ${productVariants.id} = ${params.variantId}
        AND ${productVariants.stockVersion} = ${params.stockVersion}
        AND ${productVariants.deletedAt} IS NULL
    `)
    .returning({ id: inventoryMovements.id });
}
