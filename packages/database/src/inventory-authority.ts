import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { inventoryReservationLanes, productVariants } from "./schema";

export interface RegularInventoryAuthorityColumns {
  variantId: SQLWrapper;
  stock: SQLWrapper;
  legacyReservedStock: SQLWrapper;
}

/** Coordinated reservations only; legacy reservations remain on the SKU row. */
export function coordinatedRegularReservedStockSql(
  variantId: SQLWrapper = productVariants.id,
): SQL<number> {
  return sql<number>`COALESCE((
    SELECT SUM(${inventoryReservationLanes.reservedQuantity})
    FROM ${inventoryReservationLanes}
    WHERE ${inventoryReservationLanes.variantId} = ${variantId}
      AND ${inventoryReservationLanes.pool} = 'regular'
      AND ${inventoryReservationLanes.lane} IN (0, 1)
  ), 0)`;
}

/**
 * Total regular sellable-stock pressure during the compatibility window:
 * legacy reservations plus exact coordinated lane reservations.
 */
export function effectiveRegularReservedStockSql(
  columns: Pick<RegularInventoryAuthorityColumns, "variantId" | "legacyReservedStock"> = {
    variantId: productVariants.id,
    legacyReservedStock: productVariants.reservedStock,
  },
): SQL<number> {
  return sql<number>`(
    ${columns.legacyReservedStock}
    + ${coordinatedRegularReservedStockSql(columns.variantId)}
  )`;
}

export function availableRegularStockSql(
  columns: RegularInventoryAuthorityColumns = {
    variantId: productVariants.id,
    stock: productVariants.stock,
    legacyReservedStock: productVariants.reservedStock,
  },
): SQL<number> {
  return sql<number>`(
    ${columns.stock} - ${effectiveRegularReservedStockSql(columns)}
  )`;
}

