// Read models over purchasing and transfers (migration 0109): incoming stock
// per SKU and location, and inventory valuation per location.
//
// Incoming = open purchase order lines (ordered − received, on ordered or
// partially received POs, at the PO's destination) + units in transit to
// the location (shipped − received − returned). Neither is on hand: buyers
// never see them, and they are not part of a SKU's stock.
//
// Valuation = Σ on hand × the SKU's current unit cost, per location (the
// cost receipts move to the weighted average when the merchant asks). SKUs
// without a cost are counted, not valued, so a partial total says so. Units
// in transit are valued separately.

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { D1_ID_CHUNK_SIZE, type Database } from "@scalius/database/client";
import {
  inventoryLevels,
  inventoryLocations,
  inventoryTransferLines,
  inventoryTransfers,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
} from "@scalius/database/schema";
import { fromMinor } from "@scalius/shared/money";
import { readStoreCurrency } from "../markets";

/**
 * Incoming units of the SKU in `variantId` (a column or value) as a scalar
 * subquery, at one location or everywhere.
 */
export function incomingUnitsSql(variantId: SQL, locationId?: string | null): SQL<number> {
  const poLocation = locationId ? sql`AND po.destination_location_id = ${locationId}` : sql``;
  const transferLocation = locationId ? sql`AND t.destination_location_id = ${locationId}` : sql``;
  return sql<number>`(
    COALESCE((
      SELECT SUM(pol.quantity - pol.received_quantity)
      FROM ${purchaseOrderLines} AS pol
      JOIN ${purchaseOrders} AS po ON po.id = pol.purchase_order_id
      WHERE pol.variant_id = ${variantId}
        AND po.status IN ('ordered', 'partially_received')
        ${poLocation}
    ), 0) + COALESCE((
      SELECT SUM(tl.shipped_quantity - tl.received_quantity - tl.returned_quantity)
      FROM ${inventoryTransferLines} AS tl
      JOIN ${inventoryTransfers} AS t ON t.id = tl.transfer_id
      WHERE tl.variant_id = ${variantId}
        AND t.status IN ('in_transit', 'partially_received')
        ${transferLocation}
    ), 0)
  )`;
}

export interface IncomingStockRow {
  variantId: string;
  locationId: string;
  /** Open purchase order units arriving there. */
  purchaseOrders: number;
  /** Units in transit to there. */
  transfers: number;
}

/** Incoming units of these SKUs, per destination location (rows with nothing incoming are omitted). */
export async function readIncomingStock(db: Database, variantIds: readonly string[]): Promise<IncomingStockRow[]> {
  const unique = [...new Set(variantIds)];
  const rows = new Map<string, IncomingStockRow>();
  const row = (variantId: string, locationId: string) => {
    const key = `${variantId}\u0000${locationId}`;
    let entry = rows.get(key);
    if (!entry) {
      entry = { variantId, locationId, purchaseOrders: 0, transfers: 0 };
      rows.set(key, entry);
    }
    return entry;
  };
  for (let index = 0; index < unique.length; index += D1_ID_CHUNK_SIZE) {
    const chunk = unique.slice(index, index + D1_ID_CHUNK_SIZE);
    const [orders, transfers] = await db.batch([
      db.select({
        variantId: purchaseOrderLines.variantId,
        locationId: purchaseOrders.destinationLocationId,
        units: sql<number>`SUM(${purchaseOrderLines.quantity} - ${purchaseOrderLines.receivedQuantity})`,
      })
        .from(purchaseOrderLines)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
        .where(and(
          inArray(purchaseOrderLines.variantId, chunk),
          inArray(purchaseOrders.status, ["ordered", "partially_received"]),
        ))
        .groupBy(purchaseOrderLines.variantId, purchaseOrders.destinationLocationId),
      db.select({
        variantId: inventoryTransferLines.variantId,
        locationId: inventoryTransfers.destinationLocationId,
        units: sql<number>`SUM(${inventoryTransferLines.shippedQuantity} - ${inventoryTransferLines.receivedQuantity} - ${inventoryTransferLines.returnedQuantity})`,
      })
        .from(inventoryTransferLines)
        .innerJoin(inventoryTransfers, eq(inventoryTransfers.id, inventoryTransferLines.transferId))
        .where(and(
          inArray(inventoryTransferLines.variantId, chunk),
          inArray(inventoryTransfers.status, ["in_transit", "partially_received"]),
        ))
        .groupBy(inventoryTransferLines.variantId, inventoryTransfers.destinationLocationId),
    ]);
    for (const order of orders) row(order.variantId, order.locationId).purchaseOrders += Number(order.units);
    for (const transfer of transfers) row(transfer.variantId, transfer.locationId).transfers += Number(transfer.units);
  }
  return [...rows.values()].filter((entry) => entry.purchaseOrders + entry.transfers > 0);
}

export interface InventoryValuationLocation {
  locationId: string;
  name: string;
  code: string;
  isDefault: boolean;
  status: "active" | "archived";
  /** Units on hand there. */
  units: number;
  /** On hand × unit cost, for SKUs with a cost. */
  value: number;
  /** On-hand units (and SKUs) without a unit cost, so not in `value`. */
  unitsWithoutCost: number;
  skusWithoutCost: number;
}

export interface InventoryValuation {
  currencyCode: string;
  locations: InventoryValuationLocation[];
  total: { units: number; value: number; unitsWithoutCost: number; skusWithoutCost: number };
  inTransit: { units: number; value: number; unitsWithoutCost: number };
}

function safeMinor(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) ? number : Math.round(number);
}

/** Inventory value per location at current unit costs, plus units in transit. */
export async function getInventoryValuation(db: Database): Promise<InventoryValuation> {
  const currency = await readStoreCurrency(db);
  // Materialize current costs once instead of fetching a wide SKU row for every level.
  const costs = sql`(
    WITH valuation_costs AS MATERIALIZED (
      SELECT ${productVariants.id} AS id, ${productVariants.costMinor} AS cost_minor
      FROM ${productVariants}
    )
    SELECT id, cost_minor FROM valuation_costs
  ) AS valuation_costs`;
  const costMinor = sql<number | null>`valuation_costs.cost_minor`;
  // Aggregate narrow stock rows before joining and sorting location metadata.
  const stock = db.select({
    locationId: inventoryLevels.locationId,
    units: sql<number>`SUM(${inventoryLevels.onHand})`.as("units"),
    valueMinor: sql<number>`COALESCE(SUM(${inventoryLevels.onHand} * ${costMinor}), 0)`.as("value_minor"),
    unitsWithoutCost: sql<number>`SUM(CASE WHEN ${costMinor} IS NULL THEN ${inventoryLevels.onHand} ELSE 0 END)`.as("units_without_cost"),
    skusWithoutCost: sql<number>`COUNT(CASE WHEN ${costMinor} IS NULL THEN 1 END)`.as("skus_without_cost"),
  }).from(inventoryLevels)
    .leftJoin(costs, sql`valuation_costs.id = ${inventoryLevels.variantId}`)
    .where(and(
      // Each location's index range skips its zero-stock levels.
      inArray(inventoryLevels.locationId, db.select({ id: inventoryLocations.id }).from(inventoryLocations)),
      sql`${inventoryLevels.onHand} > 0`,
    ))
    .groupBy(inventoryLevels.locationId)
    .as("valuation_stock");
  const [locationRows, transitRows, missingRows] = await db.batch([
    db.select({
      locationId: inventoryLocations.id,
      name: inventoryLocations.name,
      code: inventoryLocations.code,
      isDefault: inventoryLocations.isDefault,
      status: inventoryLocations.status,
      units: sql<number>`COALESCE(${stock.units}, 0)`,
      valueMinor: sql<number>`COALESCE(${stock.valueMinor}, 0)`,
      unitsWithoutCost: sql<number>`COALESCE(${stock.unitsWithoutCost}, 0)`,
      skusWithoutCost: sql<number>`COALESCE(${stock.skusWithoutCost}, 0)`,
    })
      .from(inventoryLocations)
      .leftJoin(stock, eq(stock.locationId, inventoryLocations.id))
      .where(sql`(${inventoryLocations.status} = 'active' OR ${stock.units} > 0)`)
      .orderBy(sql`${inventoryLocations.status} ASC`, sql`${inventoryLocations.isDefault} DESC`, sql`${inventoryLocations.position} ASC`, sql`${inventoryLocations.name} ASC`),
    db.select({
      units: sql<number>`COALESCE(SUM(${inventoryTransferLines.shippedQuantity} - ${inventoryTransferLines.receivedQuantity} - ${inventoryTransferLines.returnedQuantity}), 0)`,
      valueMinor: sql<number>`COALESCE(SUM((${inventoryTransferLines.shippedQuantity} - ${inventoryTransferLines.receivedQuantity} - ${inventoryTransferLines.returnedQuantity}) * ${productVariants.costMinor}), 0)`,
      unitsWithoutCost: sql<number>`COALESCE(SUM(CASE WHEN ${productVariants.costMinor} IS NULL THEN ${inventoryTransferLines.shippedQuantity} - ${inventoryTransferLines.receivedQuantity} - ${inventoryTransferLines.returnedQuantity} ELSE 0 END), 0)`,
    })
      .from(inventoryTransferLines)
      .innerJoin(inventoryTransfers, eq(inventoryTransfers.id, inventoryTransferLines.transferId))
      .innerJoin(productVariants, eq(productVariants.id, inventoryTransferLines.variantId))
      .where(inArray(inventoryTransfers.status, ["in_transit", "partially_received"])),
    // A SKU without a cost held at several locations counts once in the total.
    db.select({
      skus: sql<number>`COUNT(*)`,
    })
      .from(productVariants)
      .where(sql`${productVariants.costMinor} IS NULL AND EXISTS (
        SELECT 1 FROM ${inventoryLevels}
        WHERE ${inventoryLevels.variantId} = ${productVariants.id} AND ${inventoryLevels.onHand} > 0
      )`),
  ]);
  const money = (minor: unknown) => fromMinor(safeMinor(minor), currency.decimalPlaces);
  const locations = locationRows.map((row) => ({
    locationId: row.locationId,
    name: row.name,
    code: row.code,
    isDefault: Boolean(row.isDefault),
    status: row.status,
    units: Number(row.units),
    value: money(row.valueMinor),
    unitsWithoutCost: Number(row.unitsWithoutCost),
    skusWithoutCost: Number(row.skusWithoutCost),
  }));
  const totalMinor = locationRows.reduce((sum, row) => sum + safeMinor(row.valueMinor), 0);
  const transit = transitRows[0];
  return {
    currencyCode: currency.code,
    locations,
    total: {
      units: locations.reduce((sum, row) => sum + row.units, 0),
      value: money(totalMinor),
      unitsWithoutCost: locations.reduce((sum, row) => sum + row.unitsWithoutCost, 0),
      skusWithoutCost: Number(missingRows[0]?.skus ?? 0),
    },
    inTransit: {
      units: Number(transit?.units ?? 0),
      value: money(transit?.valueMinor ?? 0),
      unitsWithoutCost: Number(transit?.unitsWithoutCost ?? 0),
    },
  };
}
