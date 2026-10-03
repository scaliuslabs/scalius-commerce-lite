// What an uploaded file becomes before anything is sent: the format it was
// detected as, the normalized items the shared mappers made of its rows, the
// row-level problems and what it holds that Scalius cannot import. Pure, so
// the preview can re-plan instantly when an option changes.
import { IMPORT_FORMAT_KIND, type FormatDetection, type ImportFormat } from "@scalius/shared/store-transfer/detect";
import type { ImportIssue, UnsupportedSummary } from "@scalius/shared/store-transfer/issues";
import type { CsvTable } from "@scalius/shared/store-transfer/values";
import { mapShopifyProducts } from "@scalius/shared/store-transfer/shopify-products";
import { mapWooCommerceProducts } from "@scalius/shared/store-transfer/woocommerce-products";
import type { ExtraOptionStrategy, ProductMappingResult } from "@scalius/shared/store-transfer/product-mapping";
import { mapCustomers, type CustomerImportItem, type CustomerSourceFormat } from "@scalius/shared/store-transfer/customers";
import { inventoryItemsFromProducts, mapInventory, type InventoryImportItem } from "@scalius/shared/store-transfer/inventory";
import type { ProductImportItem } from "@scalius/shared/store-transfer/products";

export type ImportKind = "products" | "customers" | "inventory";
export type ProductImportChoice = "create" | "upsert" | "price" | "inventory";
export type CustomerImportChoice = "create" | "upsert";

export interface PlanOptions {
  kind: ImportKind;
  productMode: ProductImportChoice;
  customerMode: CustomerImportChoice;
  extraOptions: ExtraOptionStrategy;
  roundPrices: boolean;
  categorySource: "auto" | "type" | "product_category";
  /** The store currency at its price increment. */
  currency: { code: string; decimalPlaces: number; priceIncrementMinor: number };
  allowedPhoneCountries?: readonly string[];
}

interface PlanBase {
  format: ImportFormat;
  issues: ImportIssue[];
  unsupported: UnsupportedSummary[];
  rows: number;
}

export type ImportPlan =
  | (PlanBase & {
    kind: "products";
    mode: "create" | "upsert" | "price";
    items: ProductImportItem[];
    variantLines: Map<string, (number | null)[]>;
    stats: ProductMappingResult["stats"];
  })
  | (PlanBase & { kind: "customers"; mode: CustomerImportChoice; items: CustomerImportItem[] })
  | (PlanBase & { kind: "inventory"; items: InventoryImportItem[] })
  | { kind: "unknown"; detection: FormatDetection }
  | { kind: "mismatch"; format: ImportFormat; expected: ImportKind };

function mapProducts(table: CsvTable, format: ImportFormat, options: PlanOptions): ProductMappingResult {
  const mapping = {
    currency: options.currency,
    extraOptions: options.extraOptions,
    roundPrices: options.roundPrices,
    categorySource: options.categorySource,
  };
  return format === "woocommerce_products" ? mapWooCommerceProducts(table, mapping) : mapShopifyProducts(table, mapping);
}

/** Maps a parsed file for the chosen import. */
export function planImport(file: { table: CsvTable; detection: FormatDetection }, options: PlanOptions): ImportPlan {
  const format = file.detection.format;
  if (!format) return { kind: "unknown", detection: file.detection };
  const fileKind = IMPORT_FORMAT_KIND[format];
  const rows = file.table.rows.length;

  if (options.kind === "customers") {
    if (fileKind !== "customers") return { kind: "mismatch", format, expected: "customers" };
    const mapped = mapCustomers(file.table, format as CustomerSourceFormat, { allowedPhoneCountries: options.allowedPhoneCountries });
    return { kind: "customers", format, mode: options.customerMode, items: mapped.items, issues: mapped.issues, unsupported: mapped.unsupported, rows };
  }

  // Inventory: an inventory file, or the quantities of a product file at the default location.
  const wantsInventory = options.kind === "inventory" || options.productMode === "inventory";
  if (wantsInventory || fileKind === "inventory") {
    if (fileKind === "inventory") {
      const mapped = mapInventory(file.table);
      return { kind: "inventory", format, items: mapped.items, issues: mapped.issues, unsupported: mapped.unsupported, rows };
    }
    if (fileKind !== "products") return { kind: "mismatch", format, expected: options.kind };
    const products = mapProducts(file.table, format, options);
    return {
      kind: "inventory",
      format,
      items: inventoryItemsFromProducts(products.items, products.variantLines),
      issues: products.issues,
      unsupported: [],
      rows,
    };
  }

  if (fileKind !== "products") return { kind: "mismatch", format, expected: "products" };
  const products = mapProducts(file.table, format, options);
  return {
    kind: "products",
    format,
    mode: options.productMode === "inventory" ? "upsert" : options.productMode,
    items: products.items,
    variantLines: products.variantLines,
    stats: products.stats,
    issues: products.issues,
    unsupported: products.unsupported,
    rows,
  };
}

/** Line numbers of the file a server issue points at (a variant's own line when known). */
export function issueLine(plan: Extract<ImportPlan, { kind: "products" }>, item: ProductImportItem, variantIndex?: number): number | null {
  if (variantIndex !== undefined) {
    const line = plan.variantLines.get(item.ref)?.[variantIndex];
    if (line) return line;
  }
  return item.lines[0] ?? null;
}
