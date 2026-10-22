// WooCommerce's built-in product CSV export to import items.
//
// Rows have a Type: `simple` products are one SKU; a `variable` product's
// variations are separate `variation` rows pointing at it through Parent
// (`id:123` or the parent's SKU). A variable product's attributes become
// option axes only when its variations use them; the rest become product
// specifications. `grouped` and `external` (affiliate) products have no
// counterpart and are reported, not imported. WooCommerce exports no web
// address handle, so handles are derived from the product name.

import { handleFromText } from "../handle";
import { normalizeProductOptionIdentity } from "../product-options";
import type { CsvTable, ParsedNumber } from "./values";
import {
  ColumnIndex,
  importNumberProblem,
  isScientificNotation,
  parseImportBoolean,
  parseImportDecimal,
  parseImportInteger,
  splitImportList,
  truncateText,
} from "./values";
import {
  MappingContext,
  finalizeDraft,
  generatedVariantSku,
  importCategoryPath,
  importDescription,
  importTitle,
  type DraftProduct,
  type ProductMappingOptions,
  type ProductMappingResult,
} from "./product-mapping";
import { SKU_MAX, SKU_MIN } from "./products";

type Row = { line: number; cells: string[] };

const WEIGHT_COLUMNS: ReadonlyArray<[string, number]> = [
  ["Weight (kg)", 1000],
  ["Weight (g)", 1],
  ["Weight (lbs)", 453.59237],
  ["Weight (lb)", 453.59237],
  ["Weight (oz)", 28.349523125],
];

const BARCODE_COLUMNS = ["GTIN, UPC, EAN, or ISBN", "GTIN, UPC, EAN or ISBN", "GTIN", "EAN", "Barcode", "Meta: _global_unique_id"];

const KNOWN_COLUMNS = new Set([
  "id", "type", "sku", "name", "published", "is featured?", "visibility in catalog", "short description",
  "description", "date sale price starts", "date sale price ends", "tax status", "tax class", "in stock?",
  "stock", "low stock amount", "backorders allowed?", "sold individually?", "weight (kg)", "weight (g)",
  "weight (lbs)", "weight (lb)", "weight (oz)", "length (cm)", "width (cm)", "height (cm)", "length (in)",
  "width (in)", "height (in)", "allow customer reviews?", "purchase note", "sale price", "regular price",
  "categories", "tags", "shipping class", "images", "download limit", "download expiry days", "parent",
  "grouped products", "upsells", "cross-sells", "external url", "button text", "position", "brands", "brand",
  ...BARCODE_COLUMNS.map((name) => name.toLowerCase()),
]);

/** A WooCommerce description: its `\n` escapes back to line breaks, plain paragraphs as HTML. */
export function wooDescriptionHtml(raw: string): string {
  const text = raw.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  if (/<(p|br|div|ul|ol|h[1-6]|table|blockquote)\b/i.test(text)) return text;
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.trim().replace(/\n/g, "<br>")}</p>`)
    .join("");
}

interface WooAttribute {
  name: string;
  values: string[];
  visible: boolean;
}

function readAttributes(columns: ColumnIndex, row: Row): WooAttribute[] {
  const attributes: WooAttribute[] = [];
  for (const header of columns.matching(/^attribute \d+ name$/)) {
    const number = /(\d+)/.exec(header)![1];
    const name = columns.get(row.cells, header);
    if (!name) continue;
    attributes.push({
      name,
      values: splitImportList(columns.get(row.cells, `Attribute ${number} value(s)`)),
      visible: parseImportBoolean(columns.get(row.cells, `Attribute ${number} visible`)) !== false,
    });
  }
  return attributes;
}

function weightGrams(columns: ColumnIndex, row: Row): ParsedNumber {
  for (const [column, factor] of WEIGHT_COLUMNS) {
    if (!columns.has(column)) continue;
    const parsed = parseImportDecimal(columns.get(row.cells, column));
    if (!parsed.ok) return parsed;
    if (parsed.value !== null) return { ok: true, value: Math.round(parsed.value * factor * 100) / 100 };
  }
  return { ok: true, value: null };
}

function wooStatus(columns: ColumnIndex, row: Row): "active" | "draft" {
  const published = columns.get(row.cells, "Published").trim();
  return published === "1" || parseImportBoolean(published) === true ? "active" : "draft";
}

/** Maps a parsed WooCommerce product export. */
export function mapWooCommerceProducts(table: CsvTable, options: ProductMappingOptions): ProductMappingResult {
  const context = new MappingContext(options);
  const columns = new ColumnIndex(table.headers);
  for (const header of columns.headers) {
    const key = header.trim().toLowerCase();
    if (!key || KNOWN_COLUMNS.has(key) || /^attribute \d+ (name|value\(s\)|visible|global|default)$/.test(key)) continue;
    if (key.startsWith("meta:")) context.unsupported.add("meta_columns", "Plugin meta fields (Meta: columns).", header);
    else context.unsupported.add("unknown_column", "Columns Scalius does not recognize.", header);
  }
  const barcodeColumn = columns.find(...BARCODE_COLUMNS);

  const parents: Row[] = [];
  const variationsByParent = new Map<string, Row[]>();
  const types = new Map<Row, string[]>();
  for (const row of table.rows) {
    const type = splitImportList(columns.get(row.cells, "Type").toLowerCase());
    types.set(row, type);
    if (type.includes("variation")) {
      const parent = columns.get(row.cells, "Parent").trim();
      if (!parent) {
        context.error(row.line, "variation_without_parent", "This variation has no Parent.", { column: "Parent" });
        continue;
      }
      const key = parent.toLowerCase();
      const list = variationsByParent.get(key) ?? [];
      list.push(row);
      variationsByParent.set(key, list);
    } else if (type.length === 0) {
      context.error(row.line, "type_missing", "This row has no Type (simple, variable or variation).", { column: "Type" });
    } else {
      parents.push(row);
    }
  }
  const claimedVariations = new Set<Row>();

  for (const row of parents) {
    const type = types.get(row)!;
    const get = (name: string, at: Row = row) => columns.get(at.cells, name);
    const name = get("Name");
    const ref = get("SKU") || name || `line ${row.line}`;
    if (type.includes("grouped")) {
      context.unsupported.add("grouped_products", "Grouped products (import their child products, then build a collection).", ref);
      continue;
    }
    if (type.includes("external")) {
      context.unsupported.add("external_products", "External/affiliate products.", ref);
      continue;
    }
    if (!type.includes("simple") && !type.includes("variable")) {
      context.unsupported.add("unknown_product_type", "Product types Scalius does not know.", type.join(", "));
      continue;
    }
    if (type.includes("downloadable")) {
      context.unsupported.add("downloadable_files", "Downloadable files (upload them to the product after import).", ref);
    }
    const title = importTitle(context, name, row.line, ref);
    if (title === null) {
      context.failedProducts += 1;
      continue;
    }
    const virtual = type.includes("virtual") || type.includes("downloadable");

    const categories = splitImportList(get("Categories"));
    if (categories.length > 1) {
      context.unsupported.add("multiple_categories", "Extra categories (a product has one category; the first was used).", ref);
    }
    if (splitImportList(get("Tags")).length > 0) {
      context.unsupported.add("product_tags", "Product tags (Scalius has collections and categories instead).", ref);
    }
    if (get("Visibility in catalog") && !["visible", ""].includes(get("Visibility in catalog").toLowerCase())) {
      context.unsupported.add("catalog_visibility", "Catalog visibility (search-only or hidden products are imported as visible).", ref);
    }
    if (parseImportBoolean(get("Backorders allowed?")) === true || get("Backorders allowed?").toLowerCase() === "notify") {
      context.unsupported.add("backorders", "Backorders (set them per SKU after import).", ref);
    }
    if (get("Date sale price starts") || get("Date sale price ends")) {
      context.unsupported.add("scheduled_sales", "Scheduled sale dates (the sale price applies now).", ref);
    }
    for (const column of ["Upsells", "Cross-sells"]) {
      if (get(column)) context.unsupported.add("linked_products", "Upsells and cross-sells.", ref);
    }

    const attributes = readAttributes(columns, row);
    const brandAttribute = attributes.find((attribute) => normalizeProductOptionIdentity(attribute.name) === "brand");
    const brand = splitImportList(get("Brands") || get("Brand"))[0] ?? brandAttribute?.values[0] ?? null;
    const shortDescription = wooDescriptionHtml(get("Short description"));
    const longDescription = wooDescriptionHtml(get("Description"));
    const description = [shortDescription, longDescription].filter(Boolean).join("");
    const handle = handleFromText(title, "product");
    const images = splitImportList(get("Images")).map((url) => ({ url, alt: null }));

    const draft: DraftProduct = {
      ref,
      lines: [row.line],
      productLine: row.line,
      handle,
      handleIsIdentity: false,
      title,
      descriptionHtml: importDescription(context, description, row.line, ref),
      brand,
      categoryPath: categories[0] ? importCategoryPath(context, categories[0].split(">"), row.line, ref) : [],
      status: wooStatus(columns, row),
      seoTitle: null,
      seoDescription: null,
      isGiftCard: false,
      condition: null,
      options: [],
      variants: [],
      images,
      attributes: [],
    };

    const readSku = (at: Row): { value: string | null; failed: boolean } => {
      const sku = get("SKU", at);
      if (sku && (sku.length < SKU_MIN || sku.length > SKU_MAX)) {
        context.error(at.line, "sku_length", `SKU "${sku}" must be ${SKU_MIN} to ${SKU_MAX} characters.`, { subject: sku, column: "SKU" });
        return { value: null, failed: true };
      }
      return { value: sku || null, failed: false };
    };
    const readPricing = (at: Row): { price: number; compareAtPrice: number | null } | null => {
      const regular = parseImportDecimal(get("Regular price", at));
      const sale = parseImportDecimal(get("Sale price", at));
      if (!regular.ok || !sale.ok) {
        const column = regular.ok ? "Sale price" : "Regular price";
        context.error(at.line, "price_invalid", importNumberProblem("Price", get(column, at), regular.ok ? sale : regular), { subject: get("SKU", at) || ref, column });
        return null;
      }
      if (regular.value === null && sale.value === null) {
        context.error(at.line, "price_missing", "This product has no Regular price.", { subject: get("SKU", at) || ref, column: "Regular price" });
        return null;
      }
      if (sale.value !== null && regular.value !== null && sale.value < regular.value) {
        return { price: sale.value, compareAtPrice: regular.value };
      }
      return { price: regular.value ?? sale.value!, compareAtPrice: null };
    };
    const readStock = (at: Row): { stock: number | null; track: boolean } | null => {
      const stock = parseImportInteger(get("Stock", at));
      if (!stock.ok) {
        context.error(at.line, "quantity_invalid", `Stock "${get("Stock", at)}" is not a whole number.`, { subject: get("SKU", at) || ref, column: "Stock" });
        return null;
      }
      if (stock.value === null) return { stock: null, track: false };
      if (stock.value < 0) {
        context.warn(at.line, "quantity_negative", "Negative stock was imported as 0.", { subject: get("SKU", at) || ref, column: "Stock" });
        return { stock: 0, track: true };
      }
      return { stock: stock.value, track: true };
    };
    const readBarcode = (at: Row): { value: string | null; failed: boolean } => {
      const barcode = barcodeColumn ? get(barcodeColumn, at) : "";
      if (barcode && isScientificNotation(barcode)) {
        context.error(at.line, "barcode_scientific", `Barcode "${barcode}" was turned into scientific notation by a spreadsheet; format the column as text and export again.`, { subject: get("SKU", at) || ref, column: barcodeColumn });
        return { value: null, failed: true };
      }
      return { value: barcode || null, failed: false };
    };

    let failed = false;
    if (type.includes("simple")) {
      draft.attributes = attributes
        .filter((attribute) => attribute !== brandAttribute && attribute.values.length > 0)
        .map((attribute) => ({ name: attribute.name, value: truncateText(attribute.values.join(", "), 100) }));
      const sku = readSku(row);
      const pricing = readPricing(row);
      const stock = readStock(row);
      const weight = weightGrams(columns, row);
      const barcode = readBarcode(row);
      if (!weight.ok) context.error(row.line, "weight_invalid", !weight.ok && weight.negative ? "Weight must be 0 or more." : "Weight is not a number.", { subject: ref });
      if (sku.failed || !pricing || !stock || !weight.ok || barcode.failed) {
        context.failedProducts += 1;
        continue;
      }
      draft.variants.push({
        line: row.line,
        optionValues: [],
        sku: sku.value,
        price: pricing.price,
        compareAtPrice: pricing.compareAtPrice,
        cost: null,
        stock: stock.stock,
        trackInventory: stock.track,
        weightGrams: weight.value,
        barcode: barcode.value,
        requiresShipping: !virtual,
        // Virtual without a download is a service (a consultation); downloadable is digital.
        ...(virtual ? { nonShippingKind: type.includes("downloadable") ? "digital" as const : "service" as const } : {}),
        imageUrl: null,
      });
      finalizeDraft(context, draft);
      continue;
    }

    // Variable product: find its variations by id:<ID> or by its SKU.
    const id = get("ID");
    const variations = [
      ...(id ? variationsByParent.get(`id:${id}`.toLowerCase()) ?? [] : []),
      ...(get("SKU") ? variationsByParent.get(get("SKU").toLowerCase()) ?? [] : []),
    ].filter((variation, index, all) => all.indexOf(variation) === index);
    variations.forEach((variation) => claimedVariations.add(variation));
    if (variations.length === 0) {
      context.error(row.line, "no_variations", "This variable product has no variation rows.", { subject: ref });
      context.failedProducts += 1;
      continue;
    }
    // Axes: the parent's attributes that its variations set, in the parent's order.
    const variationAttributes = new Map(variations.map((variation) => [variation, readAttributes(columns, variation)]));
    const axisKeys = new Set<string>();
    for (const list of variationAttributes.values()) {
      for (const attribute of list) axisKeys.add(normalizeProductOptionIdentity(attribute.name));
    }
    const axes = [
      ...attributes.filter((attribute) => axisKeys.has(normalizeProductOptionIdentity(attribute.name))).map((attribute) => attribute.name),
      ...[...variationAttributes.values()].flat()
        .map((attribute) => attribute.name)
        .filter((name, index, all) => all.findIndex((candidate) => normalizeProductOptionIdentity(candidate) === normalizeProductOptionIdentity(name)) === index)
        .filter((name) => !attributes.some((attribute) => normalizeProductOptionIdentity(attribute.name) === normalizeProductOptionIdentity(name))),
    ];
    draft.options = axes;
    draft.attributes = attributes
      .filter((attribute) => attribute !== brandAttribute && !axisKeys.has(normalizeProductOptionIdentity(attribute.name)) && attribute.values.length > 0)
      .map((attribute) => ({ name: attribute.name, value: truncateText(attribute.values.join(", "), 100) }));
    draft.lines.push(...variations.map((variation) => variation.line));

    for (const variation of variations) {
      const values = variationAttributes.get(variation)!;
      const optionValues = axes.map((axis) => values.find((attribute) => normalizeProductOptionIdentity(attribute.name) === normalizeProductOptionIdentity(axis))?.values[0] ?? "");
      const missing = axes.find((_, index) => !optionValues[index]);
      if (missing) {
        context.error(variation.line, "variation_any_value", `This variation is set to "Any ${missing}". Give it one ${missing} so it is one SKU.`, { subject: get("SKU", variation) || ref });
        failed = true;
        continue;
      }
      if (wooStatus(columns, variation) === "draft" && get("Published", variation) !== "") {
        context.warn(variation.line, "variation_unpublished", "This variation is disabled in WooCommerce and was left out.", { subject: get("SKU", variation) || ref });
        continue;
      }
      const sku = readSku(variation);
      const pricing = readPricing(variation);
      const stock = readStock(variation);
      const ownWeight = weightGrams(columns, variation);
      const weight = ownWeight.ok && ownWeight.value === null ? weightGrams(columns, row) : ownWeight;
      const barcode = readBarcode(variation);
      if (!weight.ok) context.error(variation.line, "weight_invalid", !weight.ok && weight.negative ? "Weight must be 0 or more." : "Weight is not a number.", { subject: get("SKU", variation) || ref });
      if (sku.failed || !pricing || !stock || !weight.ok || barcode.failed) {
        failed = true;
        continue;
      }
      const variationTypes = types.get(variation) ?? [];
      draft.variants.push({
        line: variation.line,
        optionValues,
        sku: sku.value ?? generatedVariantSku(handle, optionValues),
        price: pricing.price,
        compareAtPrice: pricing.compareAtPrice,
        cost: null,
        stock: stock.stock,
        trackInventory: stock.track,
        weightGrams: weight.value,
        barcode: barcode.value,
        requiresShipping: !(virtual || variationTypes.includes("virtual") || variationTypes.includes("downloadable")),
        ...(virtual || variationTypes.includes("virtual") || variationTypes.includes("downloadable")
          ? { nonShippingKind: type.includes("downloadable") || variationTypes.includes("downloadable") ? "digital" as const : "service" as const }
          : {}),
        imageUrl: splitImportList(get("Images", variation))[0] ?? null,
      });
    }
    if (failed || draft.variants.length === 0) {
      if (!failed) context.error(row.line, "no_variations", "Every variation of this product was left out.", { subject: ref });
      context.failedProducts += 1;
      continue;
    }
    finalizeDraft(context, draft);
  }

  for (const [parent, rows] of variationsByParent) {
    for (const row of rows) {
      if (claimedVariations.has(row)) continue;
      context.error(row.line, "variation_parent_missing", `This variation's parent (${parent}) is not in the file.`, { column: "Parent" });
    }
  }
  return context.result(table.rows.length);
}
