// The product catalogue as a Shopify product CSV, so a merchant is never
// locked in: Shopify imports it, and so does our own importer (an export
// imported into an empty store exports again to the same rows, images
// aside, which point at the new store's media).
//
// Columns follow Shopify's product template. Category paths are written to
// Type ("Men > Shirts"); Product Category is Shopify's own taxonomy and is
// left blank. Prices are the selling price plus a compare-at price when the
// SKU is discounted. Cost per item is each SKU's unit cost in major units
// (with the minor units a cost may keep). Images point at the original uploads.
//
// The export is paged by product id: each request returns at most `limit`
// products (a bounded number of queries, whatever the catalogue's size,
// which keeps it inside a Worker's D1 query limit) and the cursor of the
// next page; the dashboard joins the pages into one file.

import type { Database } from "@scalius/database/client";
import {
  brands,
  categories,
  media,
  productMedia,
  productOptionDefinitions,
  productOptionValues,
  productVariantOptionValues,
  productVariants,
  products,
} from "@scalius/database/schema";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { bpsToPercent, fromMinor } from "@scalius/shared/money";
import { csvCell, spreadsheetSafeText } from "@scalius/shared/store-transfer/csv";
import { SHOPIFY_PRODUCT_COLUMNS } from "@scalius/shared/store-transfer/shopify-products";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";
import { readStoreCurrency } from "../markets";
import { exportPricing } from "./pricing";
import { unitCostFromMinor } from "../inventory";

export const PRODUCT_EXPORT_PAGE_DEFAULT = 250;
export const PRODUCT_EXPORT_PAGE_MAX = 500;

export interface CsvPage {
  /** CSV text of this page (with the header row when asked for). */
  body: string;
  rowCount: number;
  itemCount: number;
  /** Pass as `after` for the next page; null on the last page. */
  nextCursor: string | null;
}

type ExportRow = Partial<Record<(typeof SHOPIFY_PRODUCT_COLUMNS)[number], string | number>>;

function csvLine(row: ExportRow): string {
  return SHOPIFY_PRODUCT_COLUMNS.map((column) => csvCell(spreadsheetSafeText(row[column] ?? ""))).join(",");
}

const json = (values: readonly string[]) => JSON.stringify(values);

/** Category path names by id, from the top of the tree down. */
async function categoryPaths(db: Database): Promise<Map<string, string[]>> {
  const rows = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const paths = new Map<string, string[]>();
  const pathOf = (id: string, depth = 0): string[] => {
    const cached = paths.get(id);
    if (cached) return cached;
    const row = byId.get(id);
    if (!row || depth > 8) return [];
    const path = [...(row.parentId ? pathOf(row.parentId, depth + 1) : []), row.name];
    paths.set(id, path);
    return path;
  };
  for (const row of rows) pathOf(row.id);
  return paths;
}

/**
 * One page of the Shopify-compatible product CSV (live products, trash
 * excluded). `includeCosts: false` (no "View product costs") leaves "Cost per
 * item" blank, which an import reads as "keep the SKU's cost".
 */
export async function buildProductCsvPage(
  db: Database,
  input: {
    after?: string | null;
    limit?: number;
    includeHeader?: boolean;
    includeCosts?: boolean;
    /** Only these products (a selection in the products list); at most one page of them. */
    ids?: readonly string[];
  } = {},
): Promise<CsvPage> {
  const includeCosts = input.includeCosts ?? true;
  const limit = Math.min(Math.max(input.limit ?? PRODUCT_EXPORT_PAGE_DEFAULT, 1), PRODUCT_EXPORT_PAGE_MAX);
  const page = await db.select({
    id: products.id,
    name: products.name,
    slug: products.slug,
    description: products.description,
    categoryId: products.categoryId,
    brandName: brands.name,
    isActive: products.isActive,
    isGiftCard: products.isGiftCard,
    metaTitle: products.metaTitle,
    metaDescription: products.metaDescription,
    productCondition: products.productCondition,
    priceMinor: products.priceMinor,
    discountType: products.discountType,
    discountBps: products.discountBps,
    discountAmountMinor: products.discountAmountMinor,
  }).from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(and(
      isNull(products.deletedAt),
      input.after ? gt(products.id, input.after) : undefined,
      // One bound JSON value, whatever the selection's size.
      input.ids ? sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(input.ids)}))` : undefined,
    ))
    .orderBy(asc(products.id))
    .limit(limit + 1);
  const hasMore = page.length > limit;
  const rows = page.slice(0, limit);
  const ids = rows.map((row) => row.id);
  const lines: string[] = input.includeHeader === false ? [] : [SHOPIFY_PRODUCT_COLUMNS.map((column) => csvCell(column)).join(",")];
  if (ids.length === 0) return { body: lines.length ? `\uFEFF${lines.join("\r\n")}\r\n` : "", rowCount: 0, itemCount: 0, nextCursor: null };

  const [currency, paths, options, variants, selections, images] = await Promise.all([
    readStoreCurrency(db),
    categoryPaths(db),
    db.select({
      productId: productOptionDefinitions.productId,
      id: productOptionDefinitions.id,
      name: productOptionDefinitions.name,
      position: productOptionDefinitions.position,
    }).from(productOptionDefinitions)
      .where(and(sql`${productOptionDefinitions.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${json(ids)}))`, isNull(productOptionDefinitions.deletedAt)))
      .orderBy(asc(productOptionDefinitions.productId), asc(productOptionDefinitions.position)),
    db.select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      priceMinor: productVariants.priceMinor,
      discountType: productVariants.discountType,
      discountBps: productVariants.discountBps,
      discountAmountMinor: productVariants.discountAmountMinor,
      stock: productVariants.stock,
      trackInventory: productVariants.trackInventory,
      allowBackorder: productVariants.allowBackorder,
      weight: productVariants.weight,
      barcode: productVariants.barcode,
      fulfillmentKind: productVariants.fulfillmentKind,
      imageId: productVariants.imageId,
      isDefault: productVariants.isDefault,
      costMinor: productVariants.costMinor,
    }).from(productVariants)
      .where(and(sql`${productVariants.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${json(ids)}))`, isNull(productVariants.deletedAt)))
      .orderBy(asc(productVariants.productId), asc(productVariants.createdAt), asc(productVariants.id)),
    db.select({
      variantId: productVariantOptionValues.variantId,
      optionDefinitionId: productVariantOptionValues.optionDefinitionId,
      value: productOptionValues.value,
      valuePosition: productOptionValues.position,
    }).from(productVariantOptionValues)
      .innerJoin(productOptionValues, eq(productOptionValues.id, productVariantOptionValues.optionValueId))
      .innerJoin(productVariants, eq(productVariants.id, productVariantOptionValues.variantId))
      .where(and(sql`${productVariants.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${json(ids)}))`, isNull(productVariants.deletedAt))),
    db.select({
      id: productMedia.id,
      productId: productMedia.productId,
      objectKey: media.objectKey,
      kind: media.kind,
      altText: productMedia.altText,
      isPrimary: productMedia.isPrimary,
      sortOrder: productMedia.sortOrder,
    }).from(productMedia)
      .innerJoin(media, eq(media.id, productMedia.mediaId))
      .where(and(
        sql`${productMedia.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${json(ids)}))`,
        sql`${media.status} IN ('ready', 'trashed')`,
        eq(media.kind, "image"),
      ))
      .orderBy(asc(productMedia.productId), asc(productMedia.sortOrder), asc(productMedia.id)),
  ]);
  const decimals = currency.decimalPlaces;
  const group = <T extends { productId: string }>(list: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const entry of list) map.set(entry.productId, [...(map.get(entry.productId) ?? []), entry]);
    return map;
  };
  const optionsBy = group(options);
  const variantsBy = group(variants);
  const imagesBy = group(images);
  const selectionsBy = new Map<string, Map<string, { value: string; valuePosition: number }>>();
  for (const selection of selections) {
    const map = selectionsBy.get(selection.variantId) ?? new Map();
    map.set(selection.optionDefinitionId, selection);
    selectionsBy.set(selection.variantId, map);
  }

  let rowCount = 0;
  for (const product of rows) {
    const productOptions = optionsBy.get(product.id) ?? [];
    // Featured image first, then the product's order.
    const productImages = [...(imagesBy.get(product.id) ?? [])]
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder);
    const imageUrl = new Map(productImages.map((image) => [image.id, getCurrentPublicMediaUrl(image.objectKey)]));
    const optionValuesOf = (variantId: string) => productOptions.map((option) => selectionsBy.get(variantId)?.get(option.id)?.value ?? "");
    const productVariantsList = (variantsBy.get(product.id) ?? [])
      .filter((variant) => productOptions.length === 0 ? variant.isDefault || variantsBy.get(product.id)!.length === 1 : !variant.isDefault)
      .sort((a, b) => {
        // Option order: first axis' value position, then the next axis.
        for (const option of productOptions) {
          const left = selectionsBy.get(a.id)?.get(option.id)?.valuePosition ?? 0;
          const right = selectionsBy.get(b.id)?.get(option.id)?.valuePosition ?? 0;
          if (left !== right) return left - right;
        }
        return 0;
      });
    const simple = productOptions.length === 0;
    const output: ExportRow[] = productVariantsList.map((variant, index) => {
      // A simple product's price lives on the product; an option SKU carries its own.
      const pricing = exportPricing(simple
        ? { price: fromMinor(product.priceMinor, decimals), discountType: product.discountType, discountPercentage: bpsToPercent(product.discountBps), discountAmount: fromMinor(product.discountAmountMinor, decimals) }
        : { price: fromMinor(variant.priceMinor, decimals), discountType: variant.discountType, discountPercentage: bpsToPercent(variant.discountBps), discountAmount: fromMinor(variant.discountAmountMinor, decimals) },
      currency);
      const values = simple ? ["Default Title"] : optionValuesOf(variant.id);
      return {
        Handle: product.slug,
        ...(index === 0
          ? {
            Title: product.name,
            "Body (HTML)": product.description ?? "",
            Vendor: product.brandName ?? "",
            Type: product.categoryId ? (paths.get(product.categoryId) ?? []).join(" > ") : "",
            Published: product.isActive ? "TRUE" : "FALSE",
            "Option1 Name": simple ? "Title" : productOptions[0]?.name ?? "",
            "Option2 Name": productOptions[1]?.name ?? "",
            "Option3 Name": productOptions[2]?.name ?? "",
            "Gift Card": product.isGiftCard ? "TRUE" : "FALSE",
            "SEO Title": product.metaTitle ?? "",
            "SEO Description": product.metaDescription ?? "",
            "Google Shopping / Condition": product.productCondition ?? "",
            Status: product.isActive ? "active" : "draft",
          }
          : {}),
        "Option1 Value": values[0] ?? "",
        "Option2 Value": values[1] ?? "",
        "Option3 Value": values[2] ?? "",
        "Variant SKU": variant.sku,
        "Variant Grams": variant.weight ?? "",
        "Variant Inventory Tracker": variant.trackInventory ? "shopify" : "",
        "Variant Inventory Qty": variant.trackInventory ? variant.stock : "",
        "Variant Inventory Policy": variant.allowBackorder ? "continue" : "deny",
        "Variant Fulfillment Service": "manual",
        "Variant Price": pricing.price,
        "Variant Compare At Price": pricing.compareAtPrice ?? "",
        "Variant Requires Shipping": variant.fulfillmentKind === "physical" ? "TRUE" : "FALSE",
        "Variant Taxable": "TRUE",
        "Variant Barcode": variant.barcode ?? "",
        "Variant Image": variant.imageId ? imageUrl.get(variant.imageId) ?? "" : "",
        "Variant Weight Unit": "g",
        "Cost per item": includeCosts ? unitCostFromMinor(variant.costMinor, decimals) ?? "" : "",
      };
    });
    if (output.length === 0) {
      // A product without a sellable SKU still appears, so nothing silently disappears.
      output.push({ Handle: product.slug, Title: product.name, "Body (HTML)": product.description ?? "", Vendor: product.brandName ?? "", Published: product.isActive ? "TRUE" : "FALSE", Status: product.isActive ? "active" : "draft" });
    }
    if (productOptions.length > 3) {
      // Shopify has three option columns; the rest ride in the third as "Value / Value".
      for (const [index, variant] of productVariantsList.entries()) {
        const values = optionValuesOf(variant.id);
        output[index]!["Option3 Value"] = values.slice(2).join(" / ");
      }
      output[0]!["Option3 Name"] = productOptions.slice(2).map((option) => option.name).join(" / ");
    }
    productImages.forEach((image, index) => {
      const target = output[index] ?? (output[output.length] = { Handle: product.slug });
      target["Image Src"] = imageUrl.get(image.id)!;
      target["Image Position"] = index + 1;
      target["Image Alt Text"] = image.altText ?? "";
    });
    for (const row of output) lines.push(csvLine(row));
    rowCount += output.length;
  }
  const body = lines.length ? `${input.includeHeader === false ? "" : "\uFEFF"}${lines.join("\r\n")}\r\n` : "";
  return { body, rowCount, itemCount: rows.length, nextCursor: hasMore ? rows[rows.length - 1]!.id : null };
}
