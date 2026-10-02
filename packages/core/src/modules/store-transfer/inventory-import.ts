// Inventory import: each row sets the units on hand of one SKU at one
// location (the default location when the row names none). Every change is a
// ledger-v2 stocktake with reason "import", committed with the SKU's
// stockVersion compare-and-set and the location level in one batch, so
// for every SKU the location levels keep summing to its stock.
//
// A row whose count already matches writes nothing, so running the same file
// twice changes nothing the second time. Each row's operation key is derived
// from the run id, the SKU and the location, so a retried request replays its
// committed result instead of counting again. A dry run reports each row's
// current count; the write refuses a row whose count changed since (a sale
// or another adjustment), rather than silently overwrite it.

import type { Database } from "@scalius/database/client";
import { inventoryLocations, productVariants, products } from "@scalius/database/schema";
import { sql } from "drizzle-orm";
import type { InventoryImportBatch } from "@scalius/shared/store-transfer/inventory";
import { AppError } from "@scalius/core/errors";
import { executeInventoryOperation } from "../inventory/inventory-operations";
import {
  DIGITAL_STOCK_IS_KEYS_MESSAGE,
  DIGITAL_STOCK_IS_KEYS_REASON,
  isDigitalKind,
} from "../products/digital-stock-rules";
import { readLocationOnHand } from "../inventory/locations";
import { ImportBudget, isWorkerLimitError } from "./budget";

export type InventoryImportStatus = "updated" | "unchanged" | "failed" | "would_update" | "would_skip";

export interface InventoryImportResult {
  ref: string;
  status: InventoryImportStatus;
  sku: string;
  variantId: string | null;
  location: { id: string; name: string } | null;
  /** On hand at the location before (a dry run: now). */
  previousOnHand: number | null;
  onHand: number | null;
  issues: Array<{ code: string; message: string; field?: string }>;
}

export interface InventoryImportResponse {
  results: InventoryImportResult[];
  processed: number;
  stoppedEarly: boolean;
}

const lower = (value: string) => value.trim().toLocaleLowerCase("en-US");

/** A row issue's code: the rule's own reason when it names one (e.g. digital_stock_is_keys). */
function issueCodeOf(error: unknown): string {
  if (!(error instanceof AppError)) return "write_failed";
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" && reason ? reason : error.code.toLowerCase();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Applies (or dry-runs) one batch of on-hand counts. */
export async function importInventory(
  db: Database,
  batch: InventoryImportBatch,
  context: { actorId?: string | null; budget?: ImportBudget } = {},
): Promise<InventoryImportResponse> {
  const budget = context.budget ?? new ImportBudget();
  const skus = [...new Set(batch.items.map((item) => lower(item.sku)))];
  const [locations, variants] = await Promise.all([
    db.select({
      id: inventoryLocations.id,
      name: inventoryLocations.name,
      code: inventoryLocations.code,
      isDefault: inventoryLocations.isDefault,
      status: inventoryLocations.status,
    }).from(inventoryLocations),
    db.select({
      id: productVariants.id,
      sku: productVariants.sku,
      trackInventory: productVariants.trackInventory,
      fulfillmentKind: productVariants.fulfillmentKind,
      variantDeletedAt: productVariants.deletedAt,
      productDeletedAt: products.deletedAt,
    }).from(productVariants)
      .innerJoin(products, sql`${products.id} = ${productVariants.productId}`)
      .where(sql`lower(trim(${productVariants.sku})) IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(skus)}))`),
  ]);
  const variantBySku = new Map(variants.map((variant) => [lower(variant.sku), variant]));
  const defaultLocation = locations.find((location) => location.isDefault && location.status === "active");
  const locationFor = (name: string | null) => {
    if (!name) return defaultLocation ?? null;
    const key = lower(name);
    return locations.find((location) => lower(location.code) === key)
      ?? locations.find((location) => lower(location.name) === key)
      ?? null;
  };

  // Current counts, one read per location named in the batch.
  const wanted = new Map<string, Set<string>>();
  for (const item of batch.items) {
    const location = locationFor(item.location);
    const variant = variantBySku.get(lower(item.sku));
    if (!location || !variant) continue;
    const set = wanted.get(location.id) ?? new Set<string>();
    set.add(variant.id);
    wanted.set(location.id, set);
  }
  const onHandByLocation = new Map<string, Map<string, number>>();
  for (const [locationId, variantIds] of wanted) {
    onHandByLocation.set(locationId, await readLocationOnHand(db, locationId, [...variantIds]));
  }

  const results: InventoryImportResult[] = [];
  const counted = new Map<string, string>();
  let stoppedEarly = false;
  for (const item of batch.items) {
    if (budget.exhausted()) {
      stoppedEarly = true;
      break;
    }
    const result: InventoryImportResult = {
      ref: item.ref,
      status: "failed",
      sku: item.sku,
      variantId: null,
      location: null,
      previousOnHand: null,
      onHand: item.onHand,
      issues: [],
    };
    const variant = variantBySku.get(lower(item.sku));
    const location = locationFor(item.location);
    if (!variant || variant.variantDeletedAt !== null || variant.productDeletedAt !== null) {
      result.issues.push({ code: "sku_not_found", message: variant ? `SKU ${item.sku} belongs to a removed product or variant.` : `SKU ${item.sku} is not in the store.`, field: "sku" });
      results.push(result);
      continue;
    }
    result.variantId = variant.id;
    if (!location) {
      result.issues.push({ code: "location_not_found", message: `No location is named "${item.location}". Add it in Settings → Locations, or fix the file.`, field: "location" });
      results.push(result);
      continue;
    }
    result.location = { id: location.id, name: location.name };
    // The same SKU and location under two spellings (code and name) is still one count.
    const countKey = `${variant.id}\u0000${location.id}`;
    const earlier = counted.get(countKey);
    if (earlier !== undefined) {
      result.issues.push({ code: "duplicate_count", message: `${variant.sku} at ${location.name} is already counted (${earlier}).` });
      results.push(result);
      continue;
    }
    counted.set(countKey, item.ref);
    if (location.status !== "active") {
      result.issues.push({ code: "location_archived", message: `${location.name} is archived.`, field: "location" });
      results.push(result);
      continue;
    }
    const current = onHandByLocation.get(location.id)?.get(variant.id) ?? 0;
    result.previousOnHand = current;
    // A digital SKU's stock is its licence keys: a row may only confirm it.
    if (isDigitalKind(variant.fulfillmentKind) && item.onHand !== current) {
      result.issues.push({ code: DIGITAL_STOCK_IS_KEYS_REASON, message: `SKU ${variant.sku}: ${DIGITAL_STOCK_IS_KEYS_MESSAGE}`, field: "onHand" });
      results.push(result);
      continue;
    }
    if (!variant.trackInventory && item.onHand > 0) {
      result.issues.push({ code: "untracked_sku", message: `SKU ${variant.sku} doesn't track quantity. Turn on tracking in the product first.`, field: "sku" });
      results.push(result);
      continue;
    }
    if (item.expectedOnHand !== undefined && item.expectedOnHand !== null && item.expectedOnHand !== current) {
      result.issues.push({ code: "changed_since_preview", message: `${variant.sku} at ${location.name} changed from ${item.expectedOnHand} to ${current} after the preview. Preview the file again.` });
      results.push(result);
      continue;
    }
    if (current === item.onHand) {
      result.status = batch.dryRun ? "would_skip" : "unchanged";
      results.push(result);
      continue;
    }
    if (batch.dryRun) {
      result.status = "would_update";
      results.push(result);
      continue;
    }
    try {
      const operationKey = `import:${batch.runId}:${(await sha256Hex(`${lower(variant.sku)}\u0000${location.id}`)).slice(0, 32)}`;
      const outcome = await executeInventoryOperation(db, {
        operationKey,
        operationType: "stocktake",
        variantId: variant.id,
        pool: "stock",
        mode: "stocktake",
        newStock: item.onHand,
        reason: "import",
        locationId: location.id,
      }, context.actorId ?? undefined);
      result.status = "updated";
      result.previousOnHand = outcome.locationPreviousStock ?? current;
      result.onHand = outcome.locationNewStock ?? item.onHand;
    } catch (error) {
      if (isWorkerLimitError(error)) {
        stoppedEarly = true;
        break;
      }
      result.issues.push({
        code: issueCodeOf(error),
        message: error instanceof Error ? error.message : "The count could not be saved.",
      });
    }
    results.push(result);
  }
  return { results, processed: results.length, stoppedEarly };
}
