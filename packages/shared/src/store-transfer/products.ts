// The normalized product an importer sends, whatever the source file was
// (Shopify, WooCommerce, our own export, or an AI agent writing JSON). The
// dashboard maps CSV rows into these items and validates them here before
// showing a preview; the API validates the same items again before writing.
//
// One item is one product: a container with up to five merchant option axes
// and its sellable SKUs. A product without options has exactly one variant
// (it becomes the product's protected default SKU). Money is decimal major
// units here (as in the HTTP contract); the server converts it once.

import { z } from "zod";
import { HANDLE_MAX_LENGTH, HANDLE_PATTERN } from "../handle";
import { PRODUCT_CONDITION_VALUES } from "../product-condition";
import { MAX_MAJOR_AMOUNT } from "../money";
import {
  MAX_PRODUCT_OPTION_AXES,
  MAX_PRODUCT_OPTION_COMBINATIONS,
  MAX_SKU_STOCK,
  MAX_SKU_WEIGHT_GRAMS,
  normalizeProductOptionIdentity,
  type ProductOptionStandardMapping,
} from "../product-options";
import { getBarcodeValidationError, detectBarcodeType } from "../barcode-identity";
import { isWholeUnitIncrement, type PricingCurrency } from "../currency-policy";
import { roundToIncrementMinor } from "../money";
import type { ImportIssue } from "./issues";

export const PRODUCT_IMPORT_MODES = ["create", "upsert", "price"] as const;
export type ProductImportMode = (typeof PRODUCT_IMPORT_MODES)[number];

/** Products per request; the server may still stop early and hand back the rest. */
export const PRODUCT_IMPORT_BATCH_MAX = 50;
/** What the dashboard sends per request (well under the request byte ceiling). */
export const PRODUCT_IMPORT_BATCH_DEFAULT = 10;
export const PRODUCT_IMPORT_MAX_IMAGES = 250;
/** Product text limits the editor enforces. */
export const PRODUCT_TITLE_MIN = 1;
export const PRODUCT_TITLE_MAX = 255;
export const CATEGORY_NAME_MIN = 3;
export const CATEGORY_NAME_MAX = 100;
/** Levels in the category tree (root plus three below it). */
export const CATEGORY_PATH_MAX = 4;
export const SKU_MIN = 3;
export const SKU_MAX = 100;

const money = z.number().finite().min(0).max(MAX_MAJOR_AMOUNT);
const trimmed = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().trim().max(max).nullable()
  .transform((value) => (value ? value : null));
const importUrlSchema = z.string().trim().min(8).max(2048)
  .refine((value) => /^https?:\/\//i.test(value), "Use an absolute http(s) address.");

export const productImportVariantSchema = z.object({
  /** One value per product option, in option order; empty for a product without options. */
  optionValues: z.array(trimmed(100)).max(MAX_PRODUCT_OPTION_AXES),
  /** Null lets Scalius make one (only for a product without options). */
  sku: z.string().trim().min(SKU_MIN).max(SKU_MAX).nullable(),
  /** What the buyer pays. */
  price: money,
  /** The pre-sale price; above `price` it becomes a fixed discount of the difference. */
  compareAtPrice: money.nullable(),
  /** Cost per item (what the merchant pays for one unit), stored on the SKU. */
  cost: money.nullable(),
  /** On-hand quantity at the default location; null when the file has none. */
  stock: z.number().int().min(0).max(MAX_SKU_STOCK).nullable(),
  trackInventory: z.boolean(),
  weightGrams: z.number().finite().min(0).max(MAX_SKU_WEIGHT_GRAMS).nullable(),
  barcode: z.string().trim().min(1).max(50).nullable(),
  /** False for services and digital goods (no delivery address). */
  requiresShipping: z.boolean(),
  /** The variant's own image (one of the product's image URLs). */
  imageUrl: importUrlSchema.nullable(),
});

export const productImportOptionSchema = z.object({
  name: trimmed(40),
  values: z.array(trimmed(100)).min(1).max(MAX_PRODUCT_OPTION_COMBINATIONS),
});

export const productImportImageSchema = z.object({
  url: importUrlSchema,
  alt: nullableText(500),
});

/** The product revision a dry run saw, so the write fails if the product changed since. */
export const productImportExpectationSchema = z.object({
  productId: z.string().trim().min(1).max(100),
  aggregateRevision: z.number().int().min(1),
});

export const productImportItemSchema = z.object({
  /** How results refer back to this item (the handle, or the first line). */
  ref: trimmed(200),
  /** Lines of the source file this product came from (for row-level errors). */
  lines: z.array(z.number().int().min(1)).max(2_000).default([]),
  /** The web address handle; null derives one from the title. */
  handle: z.string().trim().min(3).max(HANDLE_MAX_LENGTH).regex(HANDLE_PATTERN).nullable(),
  /**
   * True when the handle came from the source store (Shopify), so it is the
   * product's identity; false when it was derived from the title (WooCommerce).
   */
  handleIsIdentity: z.boolean().default(true),
  title: z.string().trim().min(PRODUCT_TITLE_MIN).max(PRODUCT_TITLE_MAX),
  descriptionHtml: z.string().max(100_000).nullable(),
  brand: nullableText(100),
  /** Category names from the top of the tree down (at most four levels). */
  categoryPath: z.array(z.string().trim().min(CATEGORY_NAME_MIN).max(CATEGORY_NAME_MAX)).max(CATEGORY_PATH_MAX),
  status: z.enum(["active", "draft"]),
  seoTitle: nullableText(200),
  seoDescription: nullableText(500),
  isGiftCard: z.boolean().default(false),
  condition: z.enum(PRODUCT_CONDITION_VALUES).nullable().default(null),
  options: z.array(productImportOptionSchema).max(MAX_PRODUCT_OPTION_AXES),
  variants: z.array(productImportVariantSchema).min(1).max(MAX_PRODUCT_OPTION_COMBINATIONS),
  images: z.array(productImportImageSchema).max(PRODUCT_IMPORT_MAX_IMAGES).default([]),
  /** Specifications (non-variant attributes), one value each. */
  attributes: z.array(z.object({ name: trimmed(100), value: trimmed(100) })).max(90).default([]),
  expected: productImportExpectationSchema.nullable().optional(),
}).superRefine((item, context) => {
  for (const issue of productItemRuleIssues(item)) {
    context.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
});

export type ProductImportVariant = z.infer<typeof productImportVariantSchema>;
export type ProductImportOption = z.infer<typeof productImportOptionSchema>;
export type ProductImportItem = z.infer<typeof productImportItemSchema>;

export const productImportBatchSchema = z.object({
  mode: z.enum(PRODUCT_IMPORT_MODES),
  /** True: report what would happen and the revisions it saw; write nothing. */
  dryRun: z.boolean().default(false),
  items: z.array(productImportItemSchema).min(1).max(PRODUCT_IMPORT_BATCH_MAX),
});
export type ProductImportBatch = z.infer<typeof productImportBatchSchema>;

/** Images fetched per request (each is a remote download and an upload). */
export const PRODUCT_IMAGE_BATCH_MAX = 20;
export const PRODUCT_IMAGE_BATCH_DEFAULT = 6;

/**
 * Remote images to attach to imported products. Each URL is fetched once per
 * store (media are named after the URL), so re-sending an image that is
 * already attached does nothing.
 */
export const productImageBatchSchema = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(100),
    images: z.array(z.object({
      url: importUrlSchema,
      alt: nullableText(500),
      /** SKUs of this product that show this image. */
      skus: z.array(z.string().trim().min(1).max(100)).max(150).default([]),
    })).min(1).max(PRODUCT_IMPORT_MAX_IMAGES),
  })).min(1).max(PRODUCT_IMAGE_BATCH_MAX),
}).refine((batch) => batch.items.reduce((sum, item) => sum + item.images.length, 0) <= PRODUCT_IMPORT_MAX_IMAGES, {
  message: `Send at most ${PRODUCT_IMPORT_MAX_IMAGES} images per request.`,
});
export type ProductImageBatch = z.infer<typeof productImageBatchSchema>;

/** The image jobs for imported products: every image, with the SKUs that use it. */
export function productImageJobs(item: ProductImportItem): ProductImageBatch["items"][number]["images"] {
  return item.images.map((image) => ({
    url: image.url,
    alt: image.alt,
    skus: item.variants.flatMap((variant) => variant.imageUrl === image.url && variant.sku ? [variant.sku] : []),
  }));
}

type RuleIssue = { message: string; path: (string | number)[]; code: string };

/** Combinations the option set spans (the editor's limit counts every one). */
export function optionCombinationCount(options: readonly { values: readonly string[] }[]): number {
  return options.reduce((count, option) => count * option.values.length, 1);
}

/** The structural rules every product item must satisfy (also run by the zod schema). */
export function productItemRuleIssues(item: {
  options: readonly ProductImportOption[];
  variants: readonly ProductImportVariant[];
  status: "active" | "draft";
  isGiftCard?: boolean;
}): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const names = new Set<string>();
  item.options.forEach((option, optionIndex) => {
    const name = normalizeProductOptionIdentity(option.name);
    if (names.has(name)) issues.push({ code: "option_name_duplicate", message: `Option "${option.name}" appears twice.`, path: ["options", optionIndex, "name"] });
    names.add(name);
    const values = new Set<string>();
    option.values.forEach((value, valueIndex) => {
      const key = normalizeProductOptionIdentity(value);
      if (values.has(key)) issues.push({ code: "option_value_duplicate", message: `${option.name} value "${value}" appears twice.`, path: ["options", optionIndex, "values", valueIndex] });
      values.add(key);
    });
  });
  const combinations = optionCombinationCount(item.options);
  if (item.options.length > 0 && combinations > MAX_PRODUCT_OPTION_COMBINATIONS) {
    issues.push({
      code: "too_many_combinations",
      message: `These options make ${combinations} combinations; a product can have at most ${MAX_PRODUCT_OPTION_COMBINATIONS}.`,
      path: ["options"],
    });
  }
  if (item.options.length === 0 && item.variants.length !== 1) {
    issues.push({ code: "variants_without_options", message: "A product without options has exactly one variant.", path: ["variants"] });
  }
  const combinationKeys = new Set<string>();
  const skus = new Set<string>();
  const barcodes = new Set<string>();
  const usedValues = item.options.map(() => new Set<string>());
  item.variants.forEach((variant, variantIndex) => {
    if (variant.optionValues.length !== item.options.length) {
      issues.push({ code: "variant_option_count", message: "Each variant needs one value for every option.", path: ["variants", variantIndex, "optionValues"] });
      return;
    }
    variant.optionValues.forEach((value, optionIndex) => {
      const option = item.options[optionIndex]!;
      const key = normalizeProductOptionIdentity(value);
      if (!option.values.some((candidate) => normalizeProductOptionIdentity(candidate) === key)) {
        issues.push({ code: "variant_option_value_unknown", message: `"${value}" is not a ${option.name} value.`, path: ["variants", variantIndex, "optionValues", optionIndex] });
      }
      usedValues[optionIndex]!.add(key);
    });
    const combination = variant.optionValues.map(normalizeProductOptionIdentity).join("\u0000");
    if (item.options.length > 0 && combinationKeys.has(combination)) {
      issues.push({ code: "variant_duplicate", message: `The combination ${variant.optionValues.join(" / ")} appears twice.`, path: ["variants", variantIndex, "optionValues"] });
    }
    combinationKeys.add(combination);
    if (variant.sku) {
      const sku = variant.sku.trim().toLocaleLowerCase("en-US");
      if (skus.has(sku)) issues.push({ code: "sku_duplicate", message: `SKU ${variant.sku} appears twice in this product.`, path: ["variants", variantIndex, "sku"] });
      skus.add(sku);
    } else if (item.options.length > 0) {
      issues.push({ code: "sku_missing", message: "Every variant of a product with options needs a SKU.", path: ["variants", variantIndex, "sku"] });
    }
    if (variant.barcode) {
      const barcode = variant.barcode.trim().toLocaleLowerCase("en-US");
      if (barcodes.has(barcode)) issues.push({ code: "barcode_duplicate", message: `Barcode ${variant.barcode} appears twice in this product.`, path: ["variants", variantIndex, "barcode"] });
      barcodes.add(barcode);
      const barcodeError = getBarcodeValidationError(variant.barcode, detectBarcodeType(variant.barcode));
      if (barcodeError) issues.push({ code: "barcode_invalid", message: barcodeError, path: ["variants", variantIndex, "barcode"] });
    }
    if (item.status === "active" && variant.price <= 0) {
      issues.push({ code: "price_not_positive", message: "An active product needs a price above 0 for every variant.", path: ["variants", variantIndex, "price"] });
    }
    if (item.isGiftCard && variant.compareAtPrice !== null && variant.compareAtPrice > variant.price) {
      issues.push({ code: "gift_card_discount", message: "Gift cards can't be discounted; remove the compare-at price.", path: ["variants", variantIndex, "compareAtPrice"] });
    }
    if (variant.stock !== null && variant.stock > 0 && !variant.trackInventory) {
      issues.push({ code: "stock_untracked", message: "Turn on quantity tracking before setting a quantity.", path: ["variants", variantIndex, "stock"] });
    }
  });
  item.options.forEach((option, optionIndex) => {
    option.values.forEach((value, valueIndex) => {
      if (!usedValues[optionIndex]!.has(normalizeProductOptionIdentity(value))) {
        issues.push({ code: "option_value_unused", message: `${option.name} value "${value}" is not used by any variant.`, path: ["options", optionIndex, "values", valueIndex] });
      }
    });
  });
  return issues;
}

/**
 * Money rules that depend on the store currency: every price is a multiple
 * of the store's price increment (a BDT store's default: whole taka).
 * Returns the issues (with lines) for one item.
 */
export function productItemCurrencyIssues(
  item: Pick<ProductImportItem, "ref" | "lines" | "variants">,
  currency: PricingCurrency,
  variantLines?: readonly (number | null)[],
): ImportIssue[] {
  const code = currency.code.trim().toUpperCase();
  const wholeTaka = code === "BDT" && isWholeUnitIncrement(code, currency.priceIncrementMinor);
  // The increment in major units: 1 for whole units, 10^-decimals for minor units.
  const step = currency.priceIncrementMinor / 10 ** currency.decimalPlaces;
  const issues: ImportIssue[] = [];
  item.variants.forEach((variant, index) => {
    for (const [column, amount] of [["price", variant.price], ["compareAtPrice", variant.compareAtPrice]] as const) {
      if (amount === null) continue;
      const scaled = amount / step;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
        issues.push({
          severity: "error",
          code: wholeTaka ? "price_not_whole_taka" : "price_too_precise",
          message: wholeTaka
            ? `Taka amounts are whole numbers (${amount}).`
            : isWholeUnitIncrement(code, currency.priceIncrementMinor)
              ? `${code} amounts are whole numbers (${amount}).`
              : `${amount} has more than ${currency.decimalPlaces} decimal places.`,
          line: variantLines?.[index] ?? item.lines[0] ?? null,
          subject: variant.sku ?? item.ref,
          column,
          params: { amount },
        });
      }
    }
  });
  return issues;
}

/** Rounds every price half up to the store's price increment (a BDT store's default: whole taka). */
export function roundItemPrices<T extends Pick<ProductImportItem, "variants">>(
  item: T,
  currency: PricingCurrency,
): T {
  const scale = 10 ** currency.decimalPlaces;
  const round = (amount: number) =>
    roundToIncrementMinor(Math.round(amount * scale), currency.priceIncrementMinor) / scale;
  return {
    ...item,
    variants: item.variants.map((variant) => ({
      ...variant,
      price: round(variant.price),
      compareAtPrice: variant.compareAtPrice === null ? null : round(variant.compareAtPrice),
    })),
  };
}

const STANDARD_MAPPING_BY_NAME: Record<string, ProductOptionStandardMapping> = {
  size: "size", "সাইজ": "size", "মাপ": "size",
  color: "color", colour: "color", "রং": "color", "রঙ": "color",
  material: "material", fabric: "material", "ম্যাটেরিয়াল": "material", "উপাদান": "material", "কাপড়": "material",
  pattern: "pattern", "প্যাটার্ন": "pattern", "নকশা": "pattern",
};

/** The catalog standard an option name reads as (each standard used at most once per product). */
export function standardMappingsForOptions(names: readonly string[]): ProductOptionStandardMapping[] {
  const taken = new Set<ProductOptionStandardMapping>();
  return names.map((name) => {
    const guess = STANDARD_MAPPING_BY_NAME[normalizeProductOptionIdentity(name)] ?? "none";
    if (guess === "none" || taken.has(guess)) return "none";
    taken.add(guess);
    return guess;
  });
}

/** The discount a compare-at price implies: the fixed amount off `price`'s base. */
export function compareAtDiscount(variant: Pick<ProductImportVariant, "price" | "compareAtPrice">): {
  basePrice: number;
  discountAmount: number;
} {
  if (variant.compareAtPrice !== null && variant.compareAtPrice > variant.price) {
    return {
      basePrice: variant.compareAtPrice,
      discountAmount: Math.round((variant.compareAtPrice - variant.price) * 1e6) / 1e6,
    };
  }
  return { basePrice: variant.price, discountAmount: 0 };
}
