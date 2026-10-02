// Inventory counts by SKU and location: our inventory export, Shopify's
// inventory export (one row per SKU and location), or a product CSV whose
// quantities are applied at the default location. Each row sets the units
// on hand at one location (a stocktake), so running the same file twice
// changes nothing the second time.

import { z } from "zod";
import { MAX_SKU_STOCK } from "../product-options";
import type { ImportIssue, UnsupportedSummary } from "./issues";
import { UnsupportedCollector } from "./issues";
import type { ProductImportItem } from "./products";
import { ColumnIndex, parseImportInteger, type CsvTable } from "./values";

export const INVENTORY_IMPORT_BATCH_MAX = 100;
export const INVENTORY_IMPORT_BATCH_DEFAULT = 50;

export const inventoryImportItemSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  line: z.number().int().min(1).nullable().default(null),
  sku: z.string().trim().min(1).max(100),
  /** A location's code or name; null is the default location. */
  location: z.string().trim().min(1).max(80).nullable().default(null),
  onHand: z.number().int().min(0).max(MAX_SKU_STOCK),
  /** The on-hand count a dry run saw; the write refuses the row if it changed since. */
  expectedOnHand: z.number().int().min(0).nullable().optional(),
});
export type InventoryImportItem = z.infer<typeof inventoryImportItemSchema>;

export const inventoryImportBatchSchema = z.object({
  dryRun: z.boolean().default(false),
  /**
   * Names this import run. Each row's ledger operation key is derived from it,
   * so a retried request replays instead of counting twice.
   */
  runId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/),
  items: z.array(inventoryImportItemSchema).min(1).max(INVENTORY_IMPORT_BATCH_MAX),
});
export type InventoryImportBatch = z.infer<typeof inventoryImportBatchSchema>;

export const SCALIUS_INVENTORY_COLUMNS = ["Handle", "Title", "Variant", "SKU", "Barcode", "Location", "Location code", "On hand"] as const;

export interface InventoryMappingResult {
  items: InventoryImportItem[];
  issues: ImportIssue[];
  unsupported: UnsupportedSummary[];
  stats: { rows: number; counts: number; failed: number; locations: string[] };
}

/** Maps our inventory export, Shopify's inventory export or any SKU/quantity sheet. */
export function mapInventory(table: CsvTable): InventoryMappingResult {
  const columns = new ColumnIndex(table.headers);
  const issues: ImportIssue[] = [];
  const unsupported = new UnsupportedCollector();
  const items: InventoryImportItem[] = [];
  const seen = new Map<string, number>();
  let failed = 0;
  const skuColumn = columns.find("SKU", "Variant SKU");
  const quantityColumn = columns.find("On hand", "On hand (new)", "Available", "Available (not editable)", "Quantity", "Qty", "Stock", "Variant Inventory Qty");
  const locationColumn = columns.find("Location code", "Location");
  if (columns.has("Incoming") || columns.has("Committed") || columns.has("Unavailable")) {
    unsupported.add("inventory_states", "Incoming, committed and unavailable quantities (only on-hand counts are imported).", null);
  }
  for (const row of table.rows) {
    const sku = skuColumn ? columns.get(row.cells, skuColumn) : "";
    if (!sku) {
      issues.push({ severity: "error", code: "sku_missing", message: "This row has no SKU.", line: row.line, column: skuColumn ?? "SKU" });
      failed += 1;
      continue;
    }
    const rawQuantity = quantityColumn ? columns.get(row.cells, quantityColumn) : "";
    const quantity = parseImportInteger(rawQuantity);
    if (!quantity.ok || quantity.value === null) {
      issues.push({ severity: "error", code: "quantity_invalid", message: `Quantity "${rawQuantity}" is not a whole number.`, line: row.line, subject: sku, column: quantityColumn });
      failed += 1;
      continue;
    }
    if (quantity.value < 0 || quantity.value > MAX_SKU_STOCK) {
      issues.push({ severity: "error", code: "quantity_out_of_range", message: `Quantity must be 0 to ${MAX_SKU_STOCK}.`, line: row.line, subject: sku, column: quantityColumn });
      failed += 1;
      continue;
    }
    const location = (locationColumn ? columns.get(row.cells, locationColumn) : "")
      || (locationColumn === "Location code" ? columns.get(row.cells, "Location") : "")
      || null;
    const key = `${sku.toLowerCase()}\u0000${(location ?? "").toLowerCase()}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push({ severity: "error", code: "duplicate_count", message: `SKU ${sku} at this location already has a count on line ${previous}.`, line: row.line, subject: sku, params: { line: previous } });
      failed += 1;
      continue;
    }
    seen.set(key, row.line);
    items.push({ ref: `${sku}${location ? ` @ ${location}` : ""}`, line: row.line, sku, location, onHand: quantity.value });
  }
  return {
    items,
    issues,
    unsupported: unsupported.list(),
    stats: {
      rows: table.rows.length,
      counts: items.length,
      failed,
      locations: [...new Set(items.map((item) => item.location ?? ""))],
    },
  };
}

/** The quantities of mapped products as counts at the default location (inventory-only import of a product file). */
export function inventoryItemsFromProducts(
  items: readonly ProductImportItem[],
  variantLines?: ReadonlyMap<string, readonly (number | null)[]>,
): InventoryImportItem[] {
  const counts: InventoryImportItem[] = [];
  for (const item of items) {
    item.variants.forEach((variant, index) => {
      if (!variant.sku || variant.stock === null || !variant.trackInventory) return;
      counts.push({
        ref: variant.sku,
        line: variantLines?.get(item.ref)?.[index] ?? item.lines[0] ?? null,
        sku: variant.sku,
        location: null,
        onHand: variant.stock,
      });
    });
  }
  return counts;
}
