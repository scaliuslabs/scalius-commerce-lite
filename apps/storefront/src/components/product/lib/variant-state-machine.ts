// src/components/product/lib/variant-state-machine.ts
/**
 * Variant Selection State Machine
 *
 * This module manages variant selection state.
 *
 * Selection Rules:
 * 1. User can select one size and one color
 * 2. User can click to deselect their current selection
 * 3. Changing from one option to another does NOT clear the other attribute
 * 4. Only show available combinations based on stock
 * 5. When no variant exists for a combination, don't allow selection
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
   * Fast variant lookups that preserve "first match" behavior.
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

    if (v.stock > 0) {
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

/**
 * Find variant that matches the current selection
 */
function findMatchingVariant(
  index: VariantIndex,
  selectedSize: string | undefined,
  selectedColor: string | undefined,
): Variant | null {
  // Fast path: exact combination
  if (selectedSize && selectedColor) {
    return (
      index.variantBySizeColor.get(`${selectedSize}||${selectedColor}`) || null
    );
  }

  // Preserve "first match" behavior for partial selections
  if (selectedSize && !selectedColor) {
    return index.variantsBySize.get(selectedSize)?.[0] || null;
  }

  if (selectedColor && !selectedSize) {
    return index.variantsByColor.get(selectedColor)?.[0] || null;
  }

  return index.variants[0] || null;
}

/**
 * Get available sizes based on selected color and stock
 */
export function getAvailableSizes(
  index: VariantIndex,
  selectedColor: string | undefined,
): Set<string> {
  if (!selectedColor) return index.inStockSizes;
  return index.inStockSizesByColor.get(selectedColor) || new Set<string>();
}

/**
 * Get available colors based on selected size and stock
 */
export function getAvailableColors(
  index: VariantIndex,
  selectedSize: string | undefined,
): Set<string> {
  if (!selectedSize) return index.inStockColors;
  return index.inStockColorsBySize.get(selectedSize) || new Set<string>();
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

  const availableSizes = getAvailableSizes(index, selectedColor);
  const availableColors = getAvailableColors(index, selectedSize);
  const selectedVariant = findMatchingVariant(
    index,
    selectedSize,
    selectedColor,
  );

  return {
    selectedSize,
    selectedColor,
    selectedVariant,
    availableSizes,
    availableColors,
  };
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
      // Toggle logic: if clicking the same size, deselect it
      newSelectedSize =
        state.selectedSize === action.value ? undefined : action.value;
      break;

    case "SELECT_COLOR":
      // Toggle logic: if clicking the same color, deselect it
      newSelectedColor =
        state.selectedColor === action.value ? undefined : action.value;
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

  // Calculate new available options based on new selection
  const availableSizes = getAvailableSizes(index, newSelectedColor);
  const availableColors = getAvailableColors(index, newSelectedSize);

  // Find matching variant
  const selectedVariant = findMatchingVariant(
    index,
    newSelectedSize,
    newSelectedColor,
  );

  return {
    selectedSize: newSelectedSize,
    selectedColor: newSelectedColor,
    selectedVariant,
    availableSizes,
    availableColors,
  };
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
    return { valid: true, error: null, variant: null };
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
  if (variant.stock <= 0) {
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
      isComplete: true,
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
  return {
    id: element.dataset.variantId || "",
    size: element.dataset.variantSize || null,
    color: element.dataset.variantColor || null,
    price: parseInt(element.dataset.variantPrice || "0"),
    discountedPrice: parseInt(element.dataset.variantDiscountedPrice || "0"),
    discount: parseInt(element.dataset.variantDiscount || "0"),
    discountType:
      (element.dataset.variantDiscountType as "percentage" | "flat") || null,
    discountPercentage: parseInt(
      element.dataset.variantDiscountPercentage || "0",
    ),
    discountAmount: parseInt(element.dataset.variantDiscountAmount || "0"),
    stock: parseInt(element.dataset.variantStock || "0"),
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
    } catch (e) {
      console.error("Failed to parse variants from JSON:", e);
      return [];
    }
  }

  // Fallback (though unlikely to work if DOM elements are removed)
  const variantElements =
    document.querySelectorAll<HTMLElement>("[data-variant-id]");
  return Array.from(variantElements).map(parseVariantFromDOM);
}
