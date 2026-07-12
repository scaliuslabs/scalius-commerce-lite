import {
  MAX_PRODUCT_OPTION_AXES,
  MAX_PRODUCT_OPTION_COMBINATIONS,
} from "@scalius/shared/product-options";
import type { ProductOptionMatrixInput } from "../../../../lib/api-functions/products";
import type {
  ProductImageDetail,
  ProductOptionDefinition,
  ProductOptionStandardMapping,
  ProductVariant,
} from "../../../../types/api-responses";

export type DraftOption = {
  id: string;
  name: string;
  standardMapping: ProductOptionStandardMapping;
  values: Array<{ id: string; value: string }>;
};

export type DraftVariant = ProductOptionMatrixInput["variants"][number];

export interface OptionMatrixEditorHandle {
  save: (expectedAggregateRevision?: number) => void;
}

export function draftId(prefix: string) {
  return `draft_${prefix}_${crypto.randomUUID()}`;
}

function slugPart(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
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
      barcode: variant.barcode,
      barcodeType: (variant.barcodeType as DraftVariant["barcodeType"]) ?? null,
      discountType: variant.discountType === "flat" ? "flat" : "percentage",
      discountPercentage: variant.discountPercentage,
      discountAmount: variant.discountAmount,
    }));
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
  const valueLabel = new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
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
    const generatedSku = [slugPart(productName), ...selectedOptionValueIds.map((id) => slugPart(valueLabel.get(id) ?? ""))]
      .filter(Boolean)
      .join("-")
      .slice(0, 100);
    return {
      id: draftId(`sku_${index}`),
      selectedOptionValueIds,
      imageId: shared("imageId") ?? null,
      sku: generatedSku.length >= 3 ? generatedSku : `SKU-${index + 1}`,
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
  return value.trim().toLocaleLowerCase("en-US");
}

export function optionTopologySignature(options: readonly DraftOption[]): string {
  return JSON.stringify(options.map((option) => [option.id, option.values.map((value) => value.id)]));
}

export function getOptionMatrixIssue(
  options: DraftOption[],
  variants: DraftVariant[],
  images: ProductImageDetail[],
  combinationsPending: boolean,
  committedByVariantId: ReadonlyMap<string, number> = new Map(),
  requiredStockAllocation = 0,
  blockedCommittedStock = 0,
): string | null {
  if (options.length === 0) {
    return variants.length > 0 || combinationsPending
      ? "Keep at least one option. Converting an optioned product to a simple product is a separate inventory operation."
      : null;
  }
  if (options.length > MAX_PRODUCT_OPTION_AXES) return `Use ${MAX_PRODUCT_OPTION_AXES} options or fewer.`;
  if (options.some((option) => !option.name.trim())) return "Name every option before saving.";
  if (options.some((option) => option.values.length === 0)) return "Add at least one value to every option.";
  if (new Set(options.map((option) => normalized(option.name))).size !== options.length) return "Option names must be unique.";
  const mapped = options.map((option) => option.standardMapping).filter((mapping) => mapping !== "none");
  if (new Set(mapped).size !== mapped.length) return "Each catalog feed mapping can be used by only one option.";
  const combinationCount = options.reduce((total, option) => total * option.values.length, 1);
  if (combinationCount > MAX_PRODUCT_OPTION_COMBINATIONS) return `Reduce the option set to ${MAX_PRODUCT_OPTION_COMBINATIONS} combinations or fewer.`;
  if (combinationsPending) return "Update combinations to apply the option changes to the SKU matrix.";
  if (variants.length === 0) return "Keep at least one sellable SKU combination.";
  const validValueIdsByOption = options.map((option) => new Set(option.values.map((value) => value.id)));
  const combinationKeys = new Set<string>();
  const usedValueIds = new Set<string>();
  for (const variant of variants) {
    if (
      variant.selectedOptionValueIds.length !== options.length
      || validValueIdsByOption.some((ids, index) => !ids.has(variant.selectedOptionValueIds[index]!))
    ) return "Every SKU must select one current value from every option.";
    const key = combinationKey(variant.selectedOptionValueIds);
    if (combinationKeys.has(key)) return "Every option combination must be unique.";
    combinationKeys.add(key);
    variant.selectedOptionValueIds.forEach((id) => usedValueIds.add(id));
  }
  if (options.some((option) => option.values.some((value) => !usedValueIds.has(value.id)))) {
    return "Every option value needs at least one sellable SKU. Remove any unused option values.";
  }
  const skuKeys = variants.map((variant) => normalized(variant.sku));
  if (skuKeys.some((sku) => sku.length < 3)) return "Every combination needs a SKU of at least 3 characters.";
  if (new Set(skuKeys).size !== skuKeys.length) return "Every SKU must be unique.";
  const imageIds = new Set(images.map((image) => image.id));
  const barcodeKeys = variants.map((variant) => normalized(variant.barcode ?? "")).filter(Boolean);
  if (new Set(barcodeKeys).size !== barcodeKeys.length) return "Every barcode must be unique.";
  for (const variant of variants) {
    if (!Number.isFinite(variant.price) || variant.price < 0) return "Prices must be zero or greater.";
    if (!Number.isInteger(variant.stock) || variant.stock < 0) return "Stock must be a whole number of zero or greater.";
    if (variant.stock < (committedByVariantId.get(variant.id) ?? 0)) return "On-hand stock cannot be lower than committed stock.";
    if ((variant.barcode === null) !== (variant.barcodeType === null)) return "Barcode and barcode type must be supplied together.";
    if (variant.imageId && !imageIds.has(variant.imageId)) return "A SKU image is no longer in this product's media.";
    if (variant.discountType === "percentage" && ((variant.discountPercentage ?? 0) < 0 || (variant.discountPercentage ?? 0) > 100)) return "Percentage discounts must be between 0 and 100.";
    if (variant.discountType === "flat" && ((variant.discountAmount ?? 0) < 0 || (variant.discountAmount ?? 0) > variant.price)) return "A flat SKU discount cannot exceed its price.";
  }
  if (blockedCommittedStock > 0) return "Release committed stock before converting this simple product to options.";
  if (requiredStockAllocation > 0) {
    const allocated = variants.reduce((total, variant) => total + (variant.trackInventory ? variant.stock : 0), 0);
    if (allocated !== requiredStockAllocation) return `Allocate exactly ${requiredStockAllocation} on-hand units across the combinations. Currently allocated: ${allocated}.`;
  }
  return null;
}
