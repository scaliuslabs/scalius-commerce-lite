// On-hand inventory per location as CSV: one row per tracked SKU and active
// location (a count sheet the merchant can fill in and import back). Paged
// by SKU id, like the product export, so it stays inside a Worker's query
// limit however large the catalogue is.

import type { Database } from "@scalius/database/client";
import { inventoryLevels, inventoryLocations, productVariants, products } from "@scalius/database/schema";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { csvCell, spreadsheetSafeText } from "@scalius/shared/store-transfer/csv";
import { SCALIUS_INVENTORY_COLUMNS } from "@scalius/shared/store-transfer/inventory";
import { variantOptionLabelSql } from "../products/option-model";
import type { CsvPage } from "./product-export";

export const INVENTORY_EXPORT_PAGE_DEFAULT = 500;
export const INVENTORY_EXPORT_PAGE_MAX = 1000;

/** One page of the inventory CSV; `locationId` limits it to one location. */
export async function buildInventoryCsvPage(
  db: Database,
  input: { after?: string | null; limit?: number; includeHeader?: boolean; locationId?: string | null } = {},
): Promise<CsvPage> {
  const limit = Math.min(Math.max(input.limit ?? INVENTORY_EXPORT_PAGE_DEFAULT, 1), INVENTORY_EXPORT_PAGE_MAX);
  const [locations, page] = await Promise.all([
    db.select({ id: inventoryLocations.id, name: inventoryLocations.name, code: inventoryLocations.code })
      .from(inventoryLocations)
      .where(and(eq(inventoryLocations.status, "active"), input.locationId ? eq(inventoryLocations.id, input.locationId) : undefined))
      .orderBy(sql`${inventoryLocations.isDefault} DESC`, asc(inventoryLocations.position), asc(inventoryLocations.name)),
    db.select({
      id: productVariants.id,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      slug: products.slug,
      name: products.name,
      label: variantOptionLabelSql(productVariants.id),
    }).from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
        eq(productVariants.trackInventory, true),
        input.after ? gt(productVariants.id, input.after) : undefined,
      ))
      .orderBy(asc(productVariants.id))
      .limit(limit + 1),
  ]);
  const hasMore = page.length > limit;
  const variants = page.slice(0, limit);
  const levels = variants.length === 0 ? [] : await db.select({
    variantId: inventoryLevels.variantId,
    locationId: inventoryLevels.locationId,
    onHand: inventoryLevels.onHand,
  }).from(inventoryLevels)
    .where(sql`${inventoryLevels.variantId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(variants.map((variant) => variant.id))}))`);
  const onHand = new Map(levels.map((level) => [`${level.variantId}\u0000${level.locationId}`, level.onHand]));
  const lines: string[] = input.includeHeader === false ? [] : [SCALIUS_INVENTORY_COLUMNS.map((column) => csvCell(column)).join(",")];
  let rowCount = 0;
  for (const variant of variants) {
    for (const location of locations) {
      lines.push([
        variant.slug,
        variant.name,
        variant.label ?? "",
        variant.sku,
        variant.barcode ?? "",
        location.name,
        location.code,
        onHand.get(`${variant.id}\u0000${location.id}`) ?? 0,
      ].map((cell) => csvCell(spreadsheetSafeText(cell))).join(","));
      rowCount += 1;
    }
  }
  const body = lines.length ? `${input.includeHeader === false ? "" : "﻿"}${lines.join("\r\n")}\r\n` : "";
  return { body, rowCount, itemCount: variants.length, nextCursor: hasMore ? variants[variants.length - 1]!.id : null };
}
