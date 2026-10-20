// Shared steps of the product mappers: Option3 handling, the draft product
// they build, and the final validation that turns a draft into a valid
// import item (or row-level errors).

import { handleFromText, toHandle, HANDLE_MIN_LENGTH } from "../handle";
import { normalizeProductOptionIdentity } from "../product-options";
import type { ImportIssue, UnsupportedSummary } from "./issues";
import { UnsupportedCollector } from "./issues";
import {
  CATEGORY_NAME_MAX,
  CATEGORY_NAME_MIN,
  CATEGORY_PATH_MAX,
  PRODUCT_TITLE_MAX,
  PRODUCT_TITLE_MIN,
  SKU_MAX,
  productImportItemSchema,
  productItemCurrencyIssues,
  roundItemPrices,
  type ProductImportItem,
  type ProductImportVariant,
} from "./products";
import { stableHash, truncateText } from "./values";
import type { PricingCurrency } from "../currency-policy";

/** What to do with option axes past the second (Shopify's Option3). */
export type ExtraOptionStrategy = "keep" | "skip" | "fold";

export interface ProductMappingOptions {
  /** The store currency at its price increment: imported prices are multiples of it. */
  currency: PricingCurrency;
  /** Option3 (and beyond): keep it as a third option (default), drop it, or make one product per value. */
  extraOptions?: ExtraOptionStrategy;
  /** Round prices to the store's price increment (whole taka by default in BDT) instead of failing those rows. */
  roundPrices?: boolean;
  /** Shopify: which column names the category (`auto`: Type, else Product Category). */
  categorySource?: "auto" | "type" | "product_category" | "none";
}

export interface ProductMappingStats {
  rows: number;
  products: number;
  variants: number;
  images: number;
  /** Products that could not be mapped (errors). */
  failedProducts: number;
  /** Products with a third option (before the chosen strategy). */
  productsWithExtraOptions: number;
}

export interface ProductMappingResult {
  items: ProductImportItem[];
  issues: ImportIssue[];
  unsupported: UnsupportedSummary[];
  stats: ProductMappingStats;
  /** Line of each item's variants (results report variant indexes). */
  variantLines: Map<string, (number | null)[]>;
}

/** A product as a mapper assembles it, before validation. */
export interface DraftProduct {
  ref: string;
  lines: number[];
  productLine: number;
  handle: string | null;
  handleIsIdentity: boolean;
  title: string;
  descriptionHtml: string | null;
  brand: string | null;
  categoryPath: string[];
  status: "active" | "draft";
  seoTitle: string | null;
  seoDescription: string | null;
  isGiftCard: boolean;
  condition: ProductImportItem["condition"];
  options: string[];
  variants: Array<ProductImportVariant & { line: number | null }>;
  images: Array<{ url: string; alt: string | null }>;
  attributes: Array<{ name: string; value: string }>;
}

export class MappingContext {
  readonly issues: ImportIssue[] = [];
  readonly unsupported = new UnsupportedCollector();
  readonly items: ProductImportItem[] = [];
  readonly variantLines = new Map<string, (number | null)[]>();
  failedProducts = 0;
  productsWithExtraOptions = 0;

  constructor(readonly options: ProductMappingOptions) {}

  error(line: number | null, code: string, message: string, extra: Partial<ImportIssue> = {}): void {
    this.issues.push({ severity: "error", code, message, line, ...extra });
  }

  warn(line: number | null, code: string, message: string, extra: Partial<ImportIssue> = {}): void {
    this.issues.push({ severity: "warning", code, message, line, ...extra });
  }

  result(rows: number): ProductMappingResult {
    return {
      items: this.items,
      issues: this.issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
      unsupported: this.unsupported.list(),
      stats: {
        rows,
        products: this.items.length,
        variants: this.items.reduce((sum, item) => sum + item.variants.length, 0),
        images: this.items.reduce((sum, item) => sum + item.images.length, 0),
        failedProducts: this.failedProducts,
        productsWithExtraOptions: this.productsWithExtraOptions,
      },
      variantLines: this.variantLines,
    };
  }
}

/** A handle from the source store, normalized to our handle rules. */
export function importHandle(raw: string, title: string): string {
  const handle = toHandle(raw);
  return handle.length >= HANDLE_MIN_LENGTH ? handle : handleFromText(raw || title, "product");
}

/** A product title within the editor's limits (long ones are shortened with a warning). */
export function importTitle(context: MappingContext, raw: string, line: number, subject: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length < PRODUCT_TITLE_MIN) {
    context.error(line, "title_too_short", "A product needs a title.", { subject, column: "Title" });
    return null;
  }
  if (title.length > PRODUCT_TITLE_MAX) {
    context.warn(line, "title_shortened", `Title shortened to ${PRODUCT_TITLE_MAX} characters.`, { subject, column: "Title" });
    return truncateText(title, PRODUCT_TITLE_MAX);
  }
  return title;
}

/** Description HTML, or null when there is none. Any length is kept, as the editor keeps it. */
export function importDescription(_context: MappingContext, html: string, _line: number, _subject: string): string | null {
  const value = html.trim();
  if (!value) return null;
  return value.length > 100_000 ? value.slice(0, 100_000) : value;
}

/** A category path within the tree's rules: at most four levels, names of 3 to 100 characters. */
export function importCategoryPath(context: MappingContext, segments: readonly string[], line: number, subject: string): string[] {
  const names = segments.map((segment) => segment.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (names.length === 0) return [];
  const short = names.find((name) => name.length < CATEGORY_NAME_MIN);
  if (short) {
    context.warn(line, "category_name_too_short", `Category "${short}" is shorter than ${CATEGORY_NAME_MIN} characters, so the product was imported without a category.`, { subject, params: { name: short } });
    return [];
  }
  let path = names.map((name) => truncateText(name, CATEGORY_NAME_MAX));
  if (path.length > CATEGORY_PATH_MAX) {
    context.warn(line, "category_path_shortened", `Categories go ${CATEGORY_PATH_MAX} levels deep; "${names.join(" > ")}" was shortened.`, { subject });
    path = [...path.slice(0, CATEGORY_PATH_MAX - 1), path[path.length - 1]!];
  }
  return path;
}

/** A SKU generated for a variant that has none, the same on every run of the same file. */
export function generatedVariantSku(handle: string, optionValues: readonly string[]): string {
  const base = `${handle}-${optionValues.map((value) => toHandle(value) || stableHash(value)).join("-")}`
    .toUpperCase()
    .replace(/-+/g, "-");
  return base.length <= SKU_MAX ? base : `${base.slice(0, SKU_MAX - 8)}-${stableHash(base).slice(0, 7).toUpperCase()}`;
}

/**
 * Applies the Option3 strategy. `keep` leaves the axes; `skip` drops axes past
 * the second (variants that become identical keep the first); `fold` makes one
 * product per third-axis value, titled "Title - Value".
 */
export function applyExtraOptionStrategy(context: MappingContext, draft: DraftProduct): DraftProduct[] {
  if (draft.options.length <= 2) return [draft];
  context.productsWithExtraOptions += 1;
  const strategy = context.options.extraOptions ?? "keep";
  const extraNames = draft.options.slice(2);
  context.unsupported.add(
    "extra_option",
    `Products with a third option (${strategy === "keep" ? "kept as a third option" : strategy === "skip" ? "third option left out" : "one product per third-option value"}).`,
    draft.ref,
  );
  if (strategy === "keep") return [draft];
  if (strategy === "skip") {
    const seen = new Set<string>();
    const variants: DraftProduct["variants"] = [];
    for (const variant of draft.variants) {
      const values = variant.optionValues.slice(0, 2);
      const key = values.map(normalizeProductOptionIdentity).join("\u0000");
      if (seen.has(key)) {
        context.warn(variant.line, "variant_dropped_option3", `Variant ${variant.optionValues.join(" / ")} was left out: without ${extraNames.join(", ")} it repeats another variant.`, { subject: variant.sku ?? draft.ref });
        continue;
      }
      seen.add(key);
      variants.push({ ...variant, optionValues: values });
    }
    return [{ ...draft, options: draft.options.slice(0, 2), variants }];
  }
  // fold: one product per value of the third axis (later axes join the value).
  const groups = new Map<string, DraftProduct["variants"]>();
  const labels = new Map<string, string>();
  for (const variant of draft.variants) {
    const extra = variant.optionValues.slice(2);
    const key = extra.map(normalizeProductOptionIdentity).join("\u0000");
    labels.set(key, extra.join(" / "));
    const list = groups.get(key) ?? [];
    list.push({ ...variant, optionValues: variant.optionValues.slice(0, 2) });
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, variants]) => {
    const label = labels.get(key)!;
    const suffix = toHandle(label) || stableHash(label);
    const handle = draft.handle ? `${draft.handle.slice(0, 100 - suffix.length - 1)}-${suffix}` : null;
    const title = truncateText(`${draft.title} - ${label}`, PRODUCT_TITLE_MAX);
    const variantImages = new Set(variants.map((variant) => variant.imageUrl).filter(Boolean));
    const otherVariantImages = new Set(draft.variants.map((variant) => variant.imageUrl).filter((url) => url && !variantImages.has(url)));
    return {
      ...draft,
      ref: `${draft.ref} (${label})`,
      handle,
      title,
      options: draft.options.slice(0, 2),
      variants,
      // Shared images stay on every product; another value's own variant images do not.
      images: draft.images.filter((image) => !otherVariantImages.has(image.url)),
    };
  });
}

/** The item a draft describes: option values in first-seen order, every variant image also a product image. */
function buildItem(draft: DraftProduct): unknown {
  const options = draft.options.map((name, index) => {
    const values: string[] = [];
    const seen = new Set<string>();
    for (const variant of draft.variants) {
      const value = variant.optionValues[index];
      if (value === undefined) continue;
      const key = normalizeProductOptionIdentity(value);
      if (!seen.has(key)) {
        seen.add(key);
        values.push(value);
      }
    }
    return { name, values };
  });
  // Every variant image is also a product image.
  const images = [...draft.images];
  const urls = new Set(images.map((image) => image.url));
  for (const variant of draft.variants) {
    if (variant.imageUrl && !urls.has(variant.imageUrl)) {
      urls.add(variant.imageUrl);
      images.push({ url: variant.imageUrl, alt: null });
    }
  }
  return {
    ref: draft.ref,
    lines: [...new Set(draft.lines)].sort((a, b) => a - b),
    handle: draft.handle,
    handleIsIdentity: draft.handleIsIdentity,
    title: draft.title,
    descriptionHtml: draft.descriptionHtml,
    brand: draft.brand,
    categoryPath: draft.categoryPath,
    status: draft.status,
    seoTitle: draft.seoTitle,
    seoDescription: draft.seoDescription,
    isGiftCard: draft.isGiftCard,
    condition: draft.condition,
    options,
    variants: draft.variants.map(({ line: _line, ...variant }) => variant),
    images: images.slice(0, 250),
    attributes: draft.attributes,
  };
}

/** Validates a draft; a valid one joins the items, an invalid one becomes row-level errors. */
export function finalizeDraft(context: MappingContext, draft: DraftProduct): void {
  for (const piece of applyExtraOptionStrategy(context, draft)) {
    const variantLines = piece.variants.map((variant) => variant.line);
    const parsed = productImportItemSchema.safeParse(buildItem(piece));
    if (!parsed.success) {
      context.failedProducts += 1;
      for (const issue of parsed.error.issues) {
        const [section, index] = issue.path;
        const line = section === "variants" && typeof index === "number"
          ? variantLines[index] ?? piece.productLine
          : piece.productLine;
        context.error(line, "product_invalid", issue.message, {
          subject: section === "variants" && typeof index === "number" ? piece.variants[index]?.sku ?? piece.ref : piece.ref,
          column: issue.path.map(String).join("."),
        });
      }
      continue;
    }
    let item = parsed.data;
    const currencyIssues = productItemCurrencyIssues(item, context.options.currency, variantLines);
    if (currencyIssues.length > 0) {
      if (context.options.roundPrices) {
        item = roundItemPrices(item, context.options.currency);
      } else {
        context.failedProducts += 1;
        context.issues.push(...currencyIssues);
        continue;
      }
    }
    context.items.push(item);
    context.variantLines.set(item.ref, variantLines);
  }
}
