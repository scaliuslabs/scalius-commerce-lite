// src/components/product/lib/variant-state-machine.ts
/**
 * Variant Selection State Machine
 *
 * This module manages variant selection state.
 *
 * Selection Rules:
 * 1. User can select one size and one color
 * 2. Native radio selections are idempotent; explicit deselect actions are separate
 * 3. Globally available axis values stay selectable
 * 4. Selecting an incompatible value clears the other axis so selection cannot deadlock
 * 5. Sold-out axis values are disabled
 */

export interface Variant {
  id: string;
  size: string | null;
  color: string | null;
  price: number;
  discountedPrice: number;
  discount: number;
  discountType: "percentage" | "flat" | null;
  discountPercentage: number;
  discountAmount: number;
  stock: number;
  reservedStock?: number;
  isDefault?: boolean;
  trackInventory?: boolean;
  colorSortOrder: number;
  sizeSortOrder: number;
}

export interface VariantSelectionState {
  selectedSize: string | undefined;
  selectedColor: string | undefined;
  selectedVariant: Variant | null;
  availableSizes: Set<string>;
  availableColors: Set<string>;
}

export interface VariantSelectionAction {
  type:
    | "SELECT_SIZE"
    | "SELECT_COLOR"
    | "DESELECT_SIZE"
    | "DESELECT_COLOR"
    | "RESET";
  value?: string;
}

export interface VariantOptionSelectionInput {
  selectedSize?: string | null;
  selectedColor?: string | null;
}

export interface ExactVariantSelection<TVariant> {
  variant: TVariant;
  selectedSize?: string;
  selectedColor?: string;
}

export interface VariantIndex {
  /**
   * All variants (including out-of-stock). Preserves original order.
   */
  variants: Variant[];
  /**
   * Extracted option sets from ALL variants (not stock-filtered).
   * Used for "required attribute" checks and auto-select logic.
   */
  options: ReturnType<typeof extractVariantOptions>;
  /**
   * In-stock availability (stock > 0)
   */
  inStockSizes: Set<string>;
  inStockColors: Set<string>;
  inStockSizesByColor: Map<string, Set<string>>;
  inStockColorsBySize: Map<string, Set<string>>;
  /**
   * Fast variant lookups for complete one-axis and two-axis selections.
   */
  variantsBySize: Map<string, Variant[]>;
  variantsByColor: Map<string, Variant[]>;
  variantBySizeColor: Map<string, Variant>;
}

function addToMapSet(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
) {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  map.set(key, new Set([value]));
}

function addToMapArray(
  map: Map<string, Variant[]>,
  key: string,
  value: Variant,
) {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

function isVariantAvailable(variant: Pick<Variant, "stock" | "reservedStock" | "trackInventory">): boolean {
  return variant.trackInventory === false || (variant.stock - (variant.reservedStock ?? 0)) > 0;
}

/**
 * Build a reusable index for fast availability + lookup.
 * Construct once per product page.
 */
export function createVariantIndex(variants: Variant[]): VariantIndex {
  const options = extractVariantOptions(variants);

  const inStockSizes = new Set<string>();
  const inStockColors = new Set<string>();
  const inStockSizesByColor = new Map<string, Set<string>>();
  const inStockColorsBySize = new Map<string, Set<string>>();

  const variantsBySize = new Map<string, Variant[]>();
  const variantsByColor = new Map<string, Variant[]>();
  const variantBySizeColor = new Map<string, Variant>();

  for (const v of variants) {
    if (v.size) addToMapArray(variantsBySize, v.size, v);
    if (v.color) addToMapArray(variantsByColor, v.color, v);

    // Exact match map (only meaningful when both are present)
    if (v.size && v.color && !variantBySizeColor.has(`${v.size}||${v.color}`)) {
      variantBySizeColor.set(`${v.size}||${v.color}`, v);
    }

    if (isVariantAvailable(v)) {
      if (v.size) inStockSizes.add(v.size);
      if (v.color) inStockColors.add(v.color);

      if (v.color && v.size) addToMapSet(inStockSizesByColor, v.color, v.size);
      if (v.size && v.color) addToMapSet(inStockColorsBySize, v.size, v.color);
    }
  }

  return {
    variants,
    options,
    inStockSizes,
    inStockColors,
    inStockSizesByColor,
    inStockColorsBySize,
    variantsBySize,
    variantsByColor,
    variantBySizeColor,
  };
}

/**
 * Get all unique sizes and colors from variants
 */
export function extractVariantOptions(variants: Variant[]): {
  sizes: Set<string>;
  colors: Set<string>;
  hasSize: boolean;
  hasColor: boolean;
} {
  const sizes = new Set<string>();
  const colors = new Set<string>();

  variants.forEach((variant) => {
    if (variant.size) sizes.add(variant.size);
    if (variant.color) colors.add(variant.color);
  });

  return {
    sizes,
    colors,
    hasSize: sizes.size > 0,
    hasColor: colors.size > 0,
  };
}

function normalizedOption(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function filterVariantsBySelection<
  TVariant extends Pick<Variant, "size" | "color">,
>(
  variants: readonly TVariant[],
  selection: VariantOptionSelectionInput,
): TVariant[] {
  const selectedSize = normalizedOption(selection.selectedSize);
  const selectedColor = normalizedOption(selection.selectedColor);

  return variants.filter((variant) => {
    if (selectedSize && normalizedOption(variant.size) !== selectedSize) {
      return false;
    }
    if (selectedColor && normalizedOption(variant.color) !== selectedColor) {
      return false;
    }
    return true;
  });
}

/**
 * Resolve query/hydration options only when every product axis is present and
 * the values identify exactly one buyer SKU. Partial, invalid, and ambiguous
 * inputs intentionally resolve to null.
 */
export function resolveExactVariantSelection<
  TVariant extends Pick<Variant, "size" | "color">,
>(
  variants: readonly TVariant[],
  selection: VariantOptionSelectionInput,
): ExactVariantSelection<TVariant> | null {
  const selectedSize = normalizedOption(selection.selectedSize);
  const selectedColor = normalizedOption(selection.selectedColor);
  const hasSize = variants.some((variant) => normalizedOption(variant.size));
  const hasColor = variants.some((variant) => normalizedOption(variant.color));

  if ((hasSize && !selectedSize) || (hasColor && !selectedColor)) {
    return null;
  }

  const matches = filterVariantsBySelection(variants, {
    selectedSize: hasSize ? selectedSize : undefined,
    selectedColor: hasColor ? selectedColor : undefined,
  });
  if (matches.length !== 1) {
    return null;
  }

  return {
    variant: matches[0]!,
    ...(hasSize && selectedSize ? { selectedSize } : {}),
    ...(hasColor && selectedColor ? { selectedColor } : {}),
  };
}

/**
 * Find variant that matches the current selection
 */
function findMatchingVariant(
  index: VariantIndex,
  selectedSize: string | undefined,
  selectedColor: string | undefined,
): Variant | null {
  const { hasSize, hasColor } = index.options;

  // A missing required axis is a partial selection, never an exact SKU.
  if ((hasSize && !selectedSize) || (hasColor && !selectedColor)) {
    return null;
  }

  if (hasSize && hasColor && selectedSize && selectedColor) {
    return (
      index.variantBySizeColor.get(`${selectedSize}||${selectedColor}`) || null
    );
  }

  if (hasSize && selectedSize) {
    return index.variantsBySize.get(selectedSize)?.[0] || null;
  }

  if (hasColor && selectedColor) {
    return index.variantsByColor.get(selectedColor)?.[0] || null;
  }

  // A valid simple product has exactly one hidden/default persisted SKU.
  return index.variants.length === 1 ? index.variants[0] || null : null;
}

/**
 * Globally buyer-selectable sizes. Compatibility is resolved after selection.
 */
export function getAvailableSizes(index: VariantIndex): Set<string> {
  return index.inStockSizes;
}

/**
 * Globally buyer-selectable colors. Compatibility is resolved after selection.
 */
export function getAvailableColors(index: VariantIndex): Set<string> {
  return index.inStockColors;
}

function hasAvailableCombination(
  index: VariantIndex,
  selectedSize: string | undefined,
  selectedColor: string | undefined,
): boolean {
  return filterVariantsBySelection(index.variants, {
    selectedSize,
    selectedColor,
  }).some(isVariantAvailable);
}

export function createSelectionState(
  index: VariantIndex,
  selection: VariantOptionSelectionInput,
): VariantSelectionState {
  const selectedSize = normalizedOption(selection.selectedSize);
  const selectedColor = normalizedOption(selection.selectedColor);
  return {
    selectedSize,
    selectedColor,
    selectedVariant: findMatchingVariant(index, selectedSize, selectedColor),
    availableSizes: getAvailableSizes(index),
    availableColors: getAvailableColors(index),
  };
}

/**
 * Create initial state
 */
export function createInitialState(index: VariantIndex): VariantSelectionState {
  // Auto-select if only one option available
  const options = index.options;

  const selectedSize =
    options.sizes.size === 1 ? Array.from(options.sizes)[0] : undefined;
  const selectedColor =
    options.colors.size === 1 ? Array.from(options.colors)[0] : undefined;

  return createSelectionState(index, { selectedSize, selectedColor });
}

/**
 * Apply an action to the state (reducer pattern)
 */
export function applyAction(
  state: VariantSelectionState,
  action: VariantSelectionAction,
  index: VariantIndex,
): VariantSelectionState {
  let newSelectedSize = state.selectedSize;
  let newSelectedColor = state.selectedColor;

  switch (action.type) {
    case "SELECT_SIZE":
      newSelectedSize = action.value;
      if (
        newSelectedSize &&
        newSelectedColor &&
        !hasAvailableCombination(index, newSelectedSize, newSelectedColor)
      ) {
        newSelectedColor = undefined;
      }
      break;

    case "SELECT_COLOR":
      newSelectedColor = action.value;
      if (
        newSelectedSize &&
        newSelectedColor &&
        !hasAvailableCombination(index, newSelectedSize, newSelectedColor)
      ) {
        newSelectedSize = undefined;
      }
      break;

    case "DESELECT_SIZE":
      newSelectedSize = undefined;
      break;

    case "DESELECT_COLOR":
      newSelectedColor = undefined;
      break;

    case "RESET":
      newSelectedSize = undefined;
      newSelectedColor = undefined;
      break;
  }

  return createSelectionState(index, {
    selectedSize: newSelectedSize,
    selectedColor: newSelectedColor,
  });
}

export interface ValidationResult {
  valid: boolean;
  error: string | null;
  variant: Variant | null;
}

/**
 * Validate current selection before adding to cart
 */
export function validateSelection(
  state: VariantSelectionState,
  index: VariantIndex,
): ValidationResult {
  // Check if product has variants
  if (index.variants.length === 0) {
    return {
      valid: false,
      error: "This product is not available for checkout right now.",
      variant: null,
    };
  }

  const options = index.options;

  // Check if all required attributes are selected
  if (options.hasSize && !state.selectedSize) {
    return { valid: false, error: "Please select all options", variant: null };
  }

  if (options.hasColor && !state.selectedColor) {
    return { valid: false, error: "Please select all options", variant: null };
  }

  // Find the variant
  const variant = findMatchingVariant(
    index,
    state.selectedSize,
    state.selectedColor,
  );

  if (!variant) {
    return {
      valid: false,
      error: "Selected combination not available",
      variant: null,
    };
  }

  // Check stock
  if (!isVariantAvailable(variant)) {
    return {
      valid: false,
      error: "Selected option out of stock",
      variant: null,
    };
  }

  return { valid: true, error: null, variant };
}

/**
 * Check if an option is available
 */
export function isOptionAvailable(
  option: string,
  availableOptions: Set<string>,
): boolean {
  return availableOptions.has(option);
}

/**
 * Check if an option is selected
 */
export function isOptionSelected(
  option: string,
  type: "size" | "color",
  state: VariantSelectionState,
): boolean {
  if (type === "size") {
    return state.selectedSize === option;
  }
  return state.selectedColor === option;
}

/**
 * Get selection completion status
 */
export function getSelectionStatus(
  state: VariantSelectionState,
  variants: Variant[],
): {
  isComplete: boolean;
  requiredFields: string[];
  missingFields: string[];
} {
  if (variants.length === 0) {
    return {
      isComplete: false,
      requiredFields: [],
      missingFields: [],
    };
  }

  const options = extractVariantOptions(variants);
  const requiredFields: string[] = [];
  const missingFields: string[] = [];

  if (options.hasSize) {
    requiredFields.push("size");
    if (!state.selectedSize) {
      missingFields.push("size");
    }
  }

  if (options.hasColor) {
    requiredFields.push("color");
    if (!state.selectedColor) {
      missingFields.push("color");
    }
  }

  return {
    isComplete: missingFields.length === 0,
    requiredFields,
    missingFields,
  };
}

/**
 * Convert variant data from DOM attributes
 */
export function parseVariantFromDOM(element: HTMLElement): Variant {
  const rawTrackInventory = element.dataset.variantTrackInventory;
  const decimal = (value: string | undefined): number => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    id: element.dataset.variantId || "",
    size: element.dataset.variantSize || null,
    color: element.dataset.variantColor || null,
    price: decimal(element.dataset.variantPrice),
    discountedPrice: decimal(element.dataset.variantDiscountedPrice),
    discount: decimal(element.dataset.variantDiscount),
    discountType:
      (element.dataset.variantDiscountType as "percentage" | "flat") || null,
    discountPercentage: decimal(element.dataset.variantDiscountPercentage),
    discountAmount: decimal(element.dataset.variantDiscountAmount),
    stock: parseInt(element.dataset.variantStock || "0"),
    reservedStock: parseInt(element.dataset.variantReservedStock || "0"),
    trackInventory:
      rawTrackInventory === undefined
        ? undefined
        : rawTrackInventory !== "false",
    colorSortOrder: parseInt(element.dataset.variantColorSortOrder || "0"),
    sizeSortOrder: parseInt(element.dataset.variantSizeSortOrder || "0"),
  };
}

/**
 * Load all variants from DOM
 */
export function loadVariantsFromDOM(): Variant[] {
  const scriptTag = document.getElementById("product-variants-data");
  if (scriptTag && scriptTag.textContent) {
    try {
      const variants = JSON.parse(scriptTag.textContent) as (Variant & {
        deletedAt?: string | null;
      })[];
      return variants.filter((v) => !v.deletedAt);
    } catch (e: unknown) {
      console.error("Failed to parse variants from JSON:", e);
      return [];
    }
  }

  // Fallback (though unlikely to work if DOM elements are removed)
  const variantElements =
    document.querySelectorAll<HTMLElement>("[data-variant-id]");
  return Array.from(variantElements).map(parseVariantFromDOM);
}
