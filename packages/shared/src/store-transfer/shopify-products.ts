// Shopify's product CSV (and our own product export, which uses the same
// columns) to import items. One product is every row with the same Handle:
// the first row carries the product fields, each row with option values or a
// SKU is a variant, and rows with only `Image Src` add images.

import type { CsvTable } from "./values";
import {
  ColumnIndex,
  importNumberProblem,
  isScientificNotation,
  parseImportBoolean,
  parseImportDecimal,
  parseImportInteger,
  splitImportList,
} from "./values";
import {
  MappingContext,
  finalizeDraft,
  generatedVariantSku,
  importCategoryPath,
  importDescription,
  importHandle,
  importTitle,
  type DraftProduct,
  type ProductMappingOptions,
  type ProductMappingResult,
} from "./product-mapping";
import { normalizeSavedProductCondition } from "../product-condition";
import { normalizeProductOptionIdentity } from "../product-options";
import { SKU_MAX, SKU_MIN } from "./products";

export const SHOPIFY_PRODUCT_COLUMNS = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Product Category",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Option2 Name",
  "Option2 Value",
  "Option3 Name",
  "Option3 Value",
  "Variant SKU",
  "Variant Grams",
  "Variant Inventory Tracker",
  "Variant Inventory Qty",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Requires Shipping",
  "Variant Taxable",
  "Variant Barcode",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Gift Card",
  "SEO Title",
  "SEO Description",
  "Google Shopping / Condition",
  "Variant Image",
  "Variant Weight Unit",
  "Cost per item",
  "Status",
] as const;

/** Columns we read; anything else in a Shopify file is reported once as not imported. */
const KNOWN = new Set<string>([
  ...SHOPIFY_PRODUCT_COLUMNS,
  "Option1 Linked To",
  "Option2 Linked To",
  "Option3 Linked To",
].map((name) => name.toLowerCase()));

const OPTION_COLUMNS = [
  ["Option1 Name", "Option1 Value"],
  ["Option2 Name", "Option2 Value"],
  ["Option3 Name", "Option3 Value"],
] as const;

type Row = { line: number; cells: string[] };

function variantRow(columns: ColumnIndex, cells: readonly string[]): boolean {
  return Boolean(
    columns.get(cells, "Option1 Value")
    || columns.get(cells, "Variant SKU")
    || columns.get(cells, "Variant Price")
    || columns.get(cells, "Variant Barcode"),
  );
}

function reportUnknownColumns(context: MappingContext, columns: ColumnIndex): void {
  for (const header of columns.headers) {
    const key = header.trim().toLowerCase();
    if (!key || KNOWN.has(key)) continue;
    if (key.startsWith("google shopping /")) {
      context.unsupported.add("google_shopping_columns", "Google Shopping columns (other than Condition).", header);
    } else if (key.includes("metafields.")) {
      context.unsupported.add("metafields", "Metafield columns.", header);
    } else if (/^(price|compare at price|included) \//.test(key)) {
      context.unsupported.add("market_prices", "Market (international) prices.", header);
    } else if (key.startsWith("unit price")) {
      context.unsupported.add("unit_price", "Unit price measurements.", header);
    } else if (key === "variant tax code") {
      context.unsupported.add("tax_codes", "Variant tax codes (set tax classes after import).", header);
    } else {
      context.unsupported.add("unknown_column", "Columns Scalius does not recognize.", header);
    }
  }
}

/** Maps a parsed Shopify product CSV. */
export function mapShopifyProducts(table: CsvTable, options: ProductMappingOptions): ProductMappingResult {
  const context = new MappingContext(options);
  const columns = new ColumnIndex(table.headers);
  reportUnknownColumns(context, columns);
  const hasCost = columns.has("Cost per item");

  // Group by handle, in order of first appearance.
  const groups = new Map<string, Row[]>();
  for (const row of table.rows) {
    const handle = columns.get(row.cells, "Handle");
    if (!handle) {
      if (row.cells.some((cell) => cell.trim())) {
        context.error(row.line, "handle_missing", "Every row needs a Handle (the product's web address).", { column: "Handle" });
      }
      continue;
    }
    const key = handle.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  for (const [handleKey, rows] of groups) {
    const head = rows.find((row) => columns.get(row.cells, "Title")) ?? rows[0]!;
    const get = (name: string, row: Row = head) => columns.get(row.cells, name);
    const ref = get("Handle") || handleKey;
    const title = importTitle(context, get("Title"), head.line, ref);
    if (title === null) {
      context.failedProducts += 1;
      continue;
    }

    const optionNames = OPTION_COLUMNS
      .map(([nameColumn]) => get(nameColumn))
      .filter((name, index, all) => name && all.slice(0, index).every(Boolean));
    const variantRows = rows.filter((row) => variantRow(columns, row.cells));
    // Shopify writes a product without options as Option1 Name "Title" / Value "Default Title".
    const simple = optionNames.length === 0
      || (optionNames.length === 1
        && normalizeProductOptionIdentity(optionNames[0]!) === "title"
        && variantRows.length <= 1
        && ["default title", ""].includes(normalizeProductOptionIdentity(variantRows[0] ? get("Option1 Value", variantRows[0]) : "")));
    const axes = simple ? [] : optionNames;

    const statusText = get("Status").toLowerCase();
    const published = parseImportBoolean(get("Published"));
    if (statusText === "archived") {
      context.unsupported.add("archived", "Archived products (imported as drafts).", ref);
    }
    const status: "active" | "draft" = statusText
      ? statusText === "active" ? "active" : "draft"
      : published === false ? "draft" : "active";
    const isGiftCard = parseImportBoolean(get("Gift Card")) === true;
    const handle = importHandle(get("Handle"), title);

    const categorySource = options.categorySource ?? "auto";
    const typeText = get("Type");
    const productCategory = get("Product Category");
    const categoryText = categorySource === "none"
      ? ""
      : categorySource === "type"
        ? typeText
        : categorySource === "product_category"
          ? productCategory
          : typeText || productCategory;
    if (categorySource === "auto" && typeText && productCategory) {
      context.unsupported.add("shopify_product_category", "Shopify standard product categories (the Type column was used as the category).", productCategory);
    }

    const tags = splitImportList(get("Tags"));
    if (tags.length > 0) context.unsupported.add("product_tags", "Product tags (Scalius has collections and categories instead).", ref);

    const draft: DraftProduct = {
      ref,
      lines: rows.map((row) => row.line),
      productLine: head.line,
      handle,
      handleIsIdentity: true,
      title,
      descriptionHtml: importDescription(context, get("Body (HTML)"), head.line, ref),
      brand: get("Vendor") || null,
      categoryPath: importCategoryPath(context, categoryText.split(">"), head.line, ref),
      status,
      seoTitle: get("SEO Title") || null,
      seoDescription: get("SEO Description") || null,
      isGiftCard,
      condition: normalizeSavedProductCondition(get("Google Shopping / Condition").toLowerCase()),
      options: axes,
      variants: [],
      images: [],
      attributes: [],
    };

    let rowFailed = false;
    const sourceVariants = variantRows.length > 0 ? variantRows : [head];
    for (const row of sourceVariants) {
      const at = (name: string) => get(name, row);
      const optionValues = axes.map((_, index) => at(OPTION_COLUMNS[index]![1]));
      if (optionValues.some((value) => !value)) {
        context.error(row.line, "option_value_missing", `This variant has no value for ${axes[optionValues.findIndex((value) => !value)]}.`, { subject: ref });
        rowFailed = true;
        continue;
      }
      const price = parseImportDecimal(at("Variant Price"));
      const compareAt = parseImportDecimal(at("Variant Compare At Price"));
      const grams = parseImportDecimal(at("Variant Grams"));
      const quantity = parseImportInteger(at("Variant Inventory Qty"));
      const cost = parseImportDecimal(at("Cost per item"));
      const sku = at("Variant SKU");
      const barcode = at("Variant Barcode");
      const problems: Array<[string, string, string]> = [];
      if (!price.ok) problems.push(["price_invalid", "Variant Price", importNumberProblem("Price", at("Variant Price"), price)]);
      else if (price.value === null) problems.push(["price_invalid", "Variant Price", "This variant has no price."]);
      if (!compareAt.ok) problems.push(["compare_at_invalid", "Variant Compare At Price", importNumberProblem("Compare-at price", at("Variant Compare At Price"), compareAt)]);
      if (!cost.ok) problems.push(["cost_invalid", "Cost per item", importNumberProblem("Cost per item", at("Cost per item"), cost)]);
      if (!grams.ok) problems.push(["weight_invalid", "Variant Grams", importNumberProblem("Weight", at("Variant Grams"), grams)]);
      if (!quantity.ok) problems.push(["quantity_invalid", "Variant Inventory Qty", `Quantity "${at("Variant Inventory Qty")}" is not a whole number.`]);
      if (quantity.ok && quantity.value !== null && quantity.value < 0) problems.push(["quantity_negative", "Variant Inventory Qty", "Negative quantities can't be imported; set 0 and adjust stock later."]);
      if (sku && (sku.length < SKU_MIN || sku.length > SKU_MAX)) problems.push(["sku_length", "Variant SKU", `SKU "${sku}" must be ${SKU_MIN} to ${SKU_MAX} characters.`]);
      if (barcode && isScientificNotation(barcode)) problems.push(["barcode_scientific", "Variant Barcode", `Barcode "${barcode}" was turned into scientific notation by a spreadsheet; format the column as text and export again.`]);
      if (problems.length > 0) {
        for (const [code, column, message] of problems) context.error(row.line, code, message, { subject: sku || ref, column });
        rowFailed = true;
        continue;
      }
      const tracked = at("Variant Inventory Tracker").toLowerCase() === "shopify";
      if (at("Variant Inventory Policy").toLowerCase() === "continue") {
        context.unsupported.add("continue_selling", "\"Continue selling when out of stock\" (set backorders per SKU after import).", sku || ref);
      }
      if (parseImportBoolean(at("Variant Taxable")) === false) {
        context.unsupported.add("not_taxable", "Variants marked not taxable (assign a tax class after import).", sku || ref);
      }
      const fulfillmentService = at("Variant Fulfillment Service").toLowerCase();
      if (fulfillmentService && fulfillmentService !== "manual") {
        context.unsupported.add("fulfillment_service", "Third-party fulfillment services.", fulfillmentService);
      }
      draft.variants.push({
        line: row.line,
        optionValues,
        sku: sku || (axes.length > 0 ? generatedVariantSku(handle, optionValues) : null),
        // A missing or unreadable price was refused above.
        price: price.ok ? price.value ?? 0 : 0,
        compareAtPrice: compareAt.ok && compareAt.value !== null && compareAt.value > 0 ? compareAt.value : null,
        cost: hasCost && cost.ok ? cost.value : null,
        stock: tracked && quantity.ok && quantity.value !== null ? quantity.value : null,
        trackInventory: isGiftCard ? false : tracked,
        weightGrams: grams.ok ? grams.value : null,
        barcode: barcode || null,
        requiresShipping: isGiftCard ? false : parseImportBoolean(at("Variant Requires Shipping")) !== false,
        imageUrl: at("Variant Image") || null,
      });
    }

    // Images: by Image Position, then file order; duplicates once.
    const images: Array<{ url: string; alt: string | null; position: number; order: number }> = [];
    rows.forEach((row, order) => {
      const url = get("Image Src", row);
      if (!url) return;
      const position = parseImportInteger(get("Image Position", row));
      images.push({
        url,
        alt: get("Image Alt Text", row) || null,
        position: position.ok && position.value !== null ? position.value : Number.MAX_SAFE_INTEGER,
        order,
      });
    });
    const seen = new Set<string>();
    draft.images = images
      .sort((a, b) => a.position - b.position || a.order - b.order)
      .filter((image) => (seen.has(image.url) ? false : (seen.add(image.url), true)))
      .map(({ url, alt }) => ({ url, alt }));

    if (rowFailed || draft.variants.length === 0) {
      if (!rowFailed) context.error(head.line, "no_variants", "This product has no variant rows (price or SKU).", { subject: ref });
      context.failedProducts += 1;
      continue;
    }
    finalizeDraft(context, draft);
  }
  return context.result(table.rows.length);
}
