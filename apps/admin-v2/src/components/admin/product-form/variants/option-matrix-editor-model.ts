import {
  MAX_PRODUCT_OPTION_AXES,
  MAX_PRODUCT_OPTION_COMBINATIONS,
  MAX_PRODUCT_PRICE,
  MAX_SKU_STOCK,
  MAX_SKU_WEIGHT_GRAMS,
} from "@scalius/shared/product-options";
import { getBarcodeValidationError } from "@scalius/shared/barcode-identity";
import type {
  CreateProductInput,
  ProductOptionMatrixInput,
} from "../../../../lib/api-query-options/products";
import type {
  ProductSkuImageChoice,
  ProductOptionDefinition,
  ProductOptionStandardMapping,
  ProductVariant,
} from "../../../../lib/api-query-options/products";
import { formatNumber, translate } from "../../../../i18n";
import { productMessages, type ProductMessageKey } from "../../../../i18n/products";

/** Merchant-facing reason the draft can't be saved yet; limits read in the dashboard's digits. */
const issue = (key: ProductMessageKey, vars?: Record<string, string | number>) =>
  translate(productMessages, key, vars?.max === undefined ? vars : { ...vars, max: formatNumber(Number(vars.max)) });

export type DraftOption = {
  id: string;
  name: string;
  standardMapping: ProductOptionStandardMapping;
  values: Array<{ id: string; value: string }>;
};

/** Editor rows always carry a quantity; the save payload omits it for untouched rows. */
export type DraftVariant = Omit<ProductOptionMatrixInput["variants"][number], "stock"> & { stock: number };

/** What a new product's composition adds to the create request. */
export type ProductCreateComposition = Pick<CreateProductInput, "optionMatrix" | "defaultSku">;

/** Inventory and scan facts of the hidden SKU that a product without options sells. */
export type SimpleSkuDraft = Pick<DraftVariant, "sku" | "trackInventory" | "stock" | "barcode" | "barcodeType" | "weight">;

/** A field the editor marks when a draft can't be saved. */
export type DraftIssueField = "sku" | "price" | "stock" | "barcode" | "discount" | "photo" | "weight";

/**
 * Why a draft can't be saved, placed on the field that needs the change:
 * `variantId` names the row (absent for option-level and simple-SKU problems).
 */
export interface DraftIssue {
  message: string;
  variantId?: string;
  field?: DraftIssueField;
}

/** Fields shown only after a row is expanded ("More fields"). */
export const ADVANCED_FIELDS: ReadonlySet<DraftIssueField> = new Set(["sku", "discount", "barcode", "weight"]);

function checkNumber(value: number | null, max: number, integer: boolean): ProductMessageKey | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return "issueNotANumber";
  if (value < 0 || (integer && !Number.isInteger(value))) return integer ? "issueQuantityWhole" : "issuePriceNegative";
  return value > max ? "issueTooLarge" : null;
}

/** Problems with one SKU's own numbers and barcode, in the order its fields appear. */
function skuFieldIssue(sku: SimpleSkuDraft & Partial<DraftVariant>, requirePositivePrice: boolean): DraftIssue | null {
  if (sku.price !== undefined) {
    const priceProblem = checkNumber(sku.price, MAX_PRODUCT_PRICE, false);
    if (priceProblem) return { message: issue(priceProblem, { max: MAX_PRODUCT_PRICE }), field: "price" };
    if (requirePositivePrice && sku.price <= 0) return { message: issue("issueVariantNeedsPrice"), field: "price" };
  }
  const stockProblem = checkNumber(sku.stock, MAX_SKU_STOCK, true);
  if (stockProblem) return { message: issue(stockProblem, { max: MAX_SKU_STOCK }), field: "stock" };
  if (sku.sku.trim().length < 3) return { message: issue("issueSkuShort"), field: "sku" };
  const weightProblem = checkNumber(sku.weight, MAX_SKU_WEIGHT_GRAMS, false);
  if (weightProblem) return { message: issue(weightProblem, { max: MAX_SKU_WEIGHT_GRAMS }), field: "weight" };
  const barcodeProblem = sku.barcode ? getBarcodeValidationError(sku.barcode, sku.barcodeType) : null;
  if (barcodeProblem) return { message: issue("issueBarcodeInvalid"), field: "barcode" };
  return null;
}

export function getSimpleSkuIssue(draft: SimpleSkuDraft, committed: number, skuRequired: boolean): DraftIssue | null {
  const sku = draft.sku.trim();
  // A new product may leave the SKU empty: one is made from the title.
  const own = skuFieldIssue(skuRequired || sku ? draft : { ...draft, sku: "AUTO" }, false);
  if (own) return own;
  if (!draft.trackInventory) {
    return committed > 0 ? { message: issue("issueUntrackCommitted"), field: "stock" } : null;
  }
  if (draft.stock < committed) return { message: issue("issueBelowCommitted"), field: "stock" };
  return null;
}

export interface OptionMatrixEditorHandle {
  /** Saves the variant draft; rejects (after marking the field) when it can't. */
  save: (expectedAggregateRevision?: number) => Promise<void>;
  /** Shows the draft's problem at its field (row expanded, page turned) for a Save that was refused. */
  reveal: () => void;
  /** Marks a field the server rejected, by request path (`variants.2.sku`, `defaultSku.sku`, `sku`); returns its banner line. */
  showServerIssue: (path: string, message: string) => string | null;
}

export function draftId(prefix: string) {
  return `draft_${prefix}_${crypto.randomUUID()}`;
}

function slugPart(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
}

/** SKU for a new variant: TITLE-VALUE-VALUE, or SKU-n while that is too short. */
function generatedSku(
  productName: string,
  valueLabel: ReadonlyMap<string, string>,
  selectedOptionValueIds: readonly string[],
  index: number,
) {
  const sku = [slugPart(productName), ...selectedOptionValueIds.map((id) => slugPart(valueLabel.get(id) ?? ""))]
    .filter(Boolean)
    .join("-")
    .slice(0, 100);
  return sku.length >= 3 ? sku : `SKU-${index + 1}`;
}

function optionValueLabels(options: readonly DraftOption[]) {
  return new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
}

export function combinationKey(valueIds: readonly string[]) {
  return [...valueIds].sort().join("|");
}

export function optionCombinations(options: DraftOption[]): string[][] {
  return options.reduce<string[][]>(
    (rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value.id])),
    [[]],
  );
}

export function initialVariants(variants: ProductVariant[]): DraftVariant[] {
  return variants
    .filter((variant) => !variant.deletedAt && !variant.isDefault)
    .map((variant) => ({
      id: variant.id,
      selectedOptionValueIds: [...variant.selectedOptions]
        .sort((a, b) => a.position - b.position)
        .map((option) => option.optionValueId),
      imageId: variant.imageId,
      sku: variant.sku ?? "",
      price: variant.price ?? 0,
      stock: variant.stock,
      trackInventory: variant.trackInventory ?? true,
      weight: variant.weight,
      barcode: variant.barcode ?? null,
      barcodeType: (variant.barcodeType as DraftVariant["barcodeType"]) ?? null,
      discountType: variant.discountType === "flat" ? "flat" : "percentage",
      discountPercentage: variant.discountPercentage ?? null,
      discountAmount: variant.discountAmount ?? null,
    }));
}

/**
 * Sends a saved row's quantity only when the merchant changed it, as a
 * compare-and-set on the stockVersion the editor loaded. Unchanged rows omit
 * stock so a sale since the editor opened is never written back over.
 */
export function matrixSaveVariants(
  variants: DraftVariant[],
  savedVariants: ProductVariant[],
): ProductOptionMatrixInput["variants"] {
  const savedById = new Map(savedVariants.map((variant) => [variant.id, variant]));
  return variants.map(({ stock, ...variant }) => {
    const saved = savedById.get(variant.id);
    if (!saved) return { ...variant, stock };
    return saved.stock === stock ? variant : { ...variant, stock, expectedStockVersion: saved.stockVersion };
  });
}

export function initialOptions(options: ProductOptionDefinition[]): DraftOption[] {
  return options.map((option) => ({
    id: option.id,
    name: option.name,
    standardMapping: option.standardMapping,
    values: option.values.map(({ id, value }) => ({ id, value })),
  }));
}

export function materializeVariants(
  options: DraftOption[],
  previous: DraftVariant[],
  productName: string,
  productPrice: number,
  simpleStock: number,
): DraftVariant[] {
  const previousByKey = new Map(previous.map((variant) => [combinationKey(variant.selectedOptionValueIds), variant]));
  const valueLabel = optionValueLabels(options);
  const projectedUseCount = new Map<string, number>();
  return optionCombinations(options).map((selectedOptionValueIds, index) => {
    const exact = previousByKey.get(combinationKey(selectedOptionValueIds));
    if (exact) return { ...exact, selectedOptionValueIds };
    const expandingFrom = previous.filter((variant) =>
      variant.selectedOptionValueIds.every((valueId) => selectedOptionValueIds.includes(valueId)),
    );
    const mergingFrom = previous.filter((variant) =>
      selectedOptionValueIds.every((valueId) => variant.selectedOptionValueIds.includes(valueId)),
    );
    const sourceRows = expandingFrom.length === 1 ? expandingFrom : mergingFrom;
    const inherited = sourceRows[0];
    const firstProjection = inherited
      ? (projectedUseCount.get(inherited.id) ?? 0) === 0
      : index === 0;
    if (inherited) projectedUseCount.set(inherited.id, (projectedUseCount.get(inherited.id) ?? 0) + 1);
    const shared = <K extends keyof DraftVariant>(field: K): DraftVariant[K] | undefined => {
      if (!sourceRows.length) return undefined;
      const value = sourceRows[0]![field];
      return sourceRows.every((row) => row[field] === value) ? value : undefined;
    };
    return {
      id: draftId(`sku_${index}`),
      selectedOptionValueIds,
      imageId: shared("imageId") ?? null,
      sku: generatedSku(productName, valueLabel, selectedOptionValueIds, index),
      price: shared("price") ?? productPrice,
      stock: expandingFrom.length === 1
        ? (firstProjection ? inherited?.stock ?? 0 : 0)
        : mergingFrom.length > 0
          ? mergingFrom.reduce((total, row) => total + row.stock, 0)
          : firstProjection ? simpleStock : 0,
      trackInventory: shared("trackInventory") ?? true,
      weight: shared("weight") ?? null,
      barcode: null,
      barcodeType: null,
      discountType: shared("discountType") ?? "percentage",
      discountPercentage: shared("discountPercentage") ?? null,
      discountAmount: shared("discountAmount") ?? null,
    };
  });
}

/**
 * New (unsaved) variants keep following the product title and price until the
 * merchant edits their SKU or price. Saved variants never change here.
 */
export function followProductDefaults(
  options: DraftOption[],
  variants: DraftVariant[],
  previous: { name: string; price: number },
  next: { name: string; price: number },
): DraftVariant[] {
  const valueLabel = optionValueLabels(options);
  const indexByKey = new Map(optionCombinations(options).map((ids, index) => [combinationKey(ids), index]));
  return variants.map((variant) => {
    if (!variant.id.startsWith("draft_")) return variant;
    const index = indexByKey.get(combinationKey(variant.selectedOptionValueIds)) ?? 0;
    const followsSku = variant.sku === generatedSku(previous.name, valueLabel, variant.selectedOptionValueIds, index);
    const followsPrice = variant.price === previous.price;
    if (!followsSku && !followsPrice) return variant;
    return {
      ...variant,
      ...(followsSku ? { sku: generatedSku(next.name, valueLabel, variant.selectedOptionValueIds, index) } : {}),
      ...(followsPrice ? { price: next.price } : {}),
    };
  });
}

export function missingOptionCombinations(
  options: DraftOption[],
  variants: DraftVariant[],
): string[][] {
  if (options.length === 0 || options.some((option) => option.values.length === 0)) return [];
  const active = new Set(variants.map((variant) => combinationKey(variant.selectedOptionValueIds)));
  return optionCombinations(options).filter((valueIds) => !active.has(combinationKey(valueIds)));
}

export function materializeVariantsExcluding(
  options: DraftOption[],
  previous: DraftVariant[],
  productName: string,
  productPrice: number,
  simpleStock: number,
  excludedCombinationKeys: ReadonlySet<string>,
): DraftVariant[] {
  const excludedValueSets = [...excludedCombinationKeys]
    .map((key) => new Set(key.split("|").filter(Boolean)));
  return materializeVariants(options, previous, productName, productPrice, simpleStock)
    .filter((variant) => !excludedValueSets.some((excluded) =>
      [...excluded].every((valueId) => variant.selectedOptionValueIds.includes(valueId)),
    ));
}

export function materializeCombination(
  options: DraftOption[],
  previous: DraftVariant[],
  selectedOptionValueIds: readonly string[],
  productName: string,
  productPrice: number,
): DraftVariant {
  const wanted = combinationKey(selectedOptionValueIds);
  const existing = previous.find((variant) => combinationKey(variant.selectedOptionValueIds) === wanted);
  if (existing) return existing;
  const generated = materializeVariants(options, previous, productName, productPrice, 0)
    .find((variant) => combinationKey(variant.selectedOptionValueIds) === wanted);
  if (!generated) throw new Error("The combination no longer belongs to the current option set.");
  return generated;
}

export function normalized(value: string) {
  return value.trim().toLowerCase();
}

const OPTION_TYPES_BY_NAME: Record<string, ProductOptionStandardMapping> = {
  size: "size", "সাইজ": "size",
  color: "color", colour: "color", "রং": "color", "রঙ": "color",
  material: "material", "ম্যাটেরিয়াল": "material", "উপাদান": "material",
  pattern: "pattern", "প্যাটার্ন": "pattern", "নকশা": "pattern",
};

export function guessOptionType(name: string): ProductOptionStandardMapping {
  return OPTION_TYPES_BY_NAME[normalized(name)] ?? "none";
}

/**
 * Renaming an option to Size, Color, Material or Pattern picks that type,
 * unless the merchant chose another type or another option already uses it.
 */
export function withGuessedOptionType(
  previous: DraftOption,
  next: DraftOption,
  options: readonly DraftOption[],
): DraftOption {
  if (next.name === previous.name) return next;
  const merchantChose = previous.standardMapping !== "none"
    && previous.standardMapping !== guessOptionType(previous.name);
  if (merchantChose) return next;
  const guess = guessOptionType(next.name);
  const taken = options.some((option) => option.id !== next.id && option.standardMapping === guess);
  return { ...next, standardMapping: guess !== "none" && !taken ? guess : "none" };
}

export function optionTopologySignature(options: readonly DraftOption[]): string {
  return JSON.stringify(options.map((option) => [option.id, option.values.map((value) => value.id)]));
}

export interface MatrixIssueContext {
  committedByVariantId?: ReadonlyMap<string, number>;
  /** Simple stock that must be shared out when options are first added. */
  requiredStockAllocation?: number;
  blockedCommittedStock?: number;
  allowSavedImageRemovalConfirmation?: boolean;
  /** Active products need every variant priced above 0. */
  requirePositivePrice?: boolean;
}

export function getOptionMatrixIssue(
  options: DraftOption[],
  variants: DraftVariant[],
  images: ProductSkuImageChoice[],
  combinationsPending: boolean,
  context: MatrixIssueContext = {},
): DraftIssue | null {
  const at = (key: ProductMessageKey, vars?: Record<string, string | number>, variantId?: string, field?: DraftIssueField): DraftIssue =>
    ({ message: issue(key, vars), ...(variantId ? { variantId } : {}), ...(field ? { field } : {}) });
  if (options.length === 0) {
    return variants.length > 0 || combinationsPending ? at("issueKeepOneOption") : null;
  }
  if (options.length > MAX_PRODUCT_OPTION_AXES) return at("issueTooManyOptions", { max: MAX_PRODUCT_OPTION_AXES });
  if (options.some((option) => !option.name.trim())) return at("issueNameOptions");
  if (options.some((option) => option.values.length === 0)) return at("addOptionValues");
  if (new Set(options.map((option) => normalized(option.name))).size !== options.length) return at("issueOptionNamesUnique");
  const mapped = options.map((option) => option.standardMapping).filter((mapping) => mapping !== "none");
  if (new Set(mapped).size !== mapped.length) return at("issueOptionTypeUnique");
  const combinationCount = options.reduce((total, option) => total * option.values.length, 1);
  if (combinationCount > MAX_PRODUCT_OPTION_COMBINATIONS) return at("issueTooManyVariants", { max: MAX_PRODUCT_OPTION_COMBINATIONS });
  if (combinationsPending) return at("issueUpdatePending");
  if (variants.length === 0) return at("keepOneVariant");
  const validValueIdsByOption = options.map((option) => new Set(option.values.map((value) => value.id)));
  const combinationKeys = new Set<string>();
  const usedValueIds = new Set<string>();
  for (const variant of variants) {
    if (
      variant.selectedOptionValueIds.length !== options.length
      || validValueIdsByOption.some((ids, index) => !ids.has(variant.selectedOptionValueIds[index]!))
    ) return at("issueVariantValues");
    const key = combinationKey(variant.selectedOptionValueIds);
    if (combinationKeys.has(key)) return at("issueDuplicateVariant", undefined, variant.id);
    combinationKeys.add(key);
    variant.selectedOptionValueIds.forEach((id) => usedValueIds.add(id));
  }
  if (options.some((option) => option.values.some((value) => !usedValueIds.has(value.id)))) {
    return at("issueUnusedValue");
  }
  const committedByVariantId = context.committedByVariantId ?? new Map<string, number>();
  const imageIds = new Set(images.map((image) => image.id));
  const seenSkus = new Set<string>();
  const seenBarcodes = new Set<string>();
  for (const variant of variants) {
    const own = skuFieldIssue(variant, Boolean(context.requirePositivePrice));
    if (own) return { ...own, variantId: variant.id };
    const skuKey = normalized(variant.sku);
    if (seenSkus.has(skuKey)) return at("issueSkuUnique", undefined, variant.id, "sku");
    seenSkus.add(skuKey);
    const barcodeKey = normalized(variant.barcode ?? "");
    if (barcodeKey && seenBarcodes.has(barcodeKey)) return at("issueBarcodeUnique", undefined, variant.id, "barcode");
    if (barcodeKey) seenBarcodes.add(barcodeKey);
    if (variant.stock < (committedByVariantId.get(variant.id) ?? 0)) return at("issueBelowCommitted", undefined, variant.id, "stock");
    if ((variant.barcode === null) !== (variant.barcodeType === null)) return at("issueBarcodePair", undefined, variant.id, "barcode");
    if (variant.imageId && !imageIds.has(variant.imageId) && !context.allowSavedImageRemovalConfirmation) {
      return at("issuePhotoRemoved", undefined, variant.id, "photo");
    }
    if (variant.discountType === "percentage" && ((variant.discountPercentage ?? 0) < 0 || (variant.discountPercentage ?? 0) > 100)) {
      return at("issuePercentRange", undefined, variant.id, "discount");
    }
    if (variant.discountType === "flat" && ((variant.discountAmount ?? 0) < 0 || (variant.discountAmount ?? 0) > variant.price)) {
      return at("issueDiscountOverPrice", undefined, variant.id, "discount");
    }
  }
  if ((context.blockedCommittedStock ?? 0) > 0) return at("issueOptionsCommitted");
  const required = context.requiredStockAllocation ?? 0;
  if (required > 0) {
    const allocated = variants.reduce((total, variant) => total + (variant.trackInventory ? variant.stock : 0), 0);
    if (allocated !== required) return at("issueAllocateStock", { required, allocated });
  }
  return null;
}
