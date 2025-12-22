// src/components/admin/ProductForm/variants/utils/variantHelpers.ts

import type {
  ProductVariant,
  VariantFilters,
  VariantSort,
  BulkVariantOptions,
  BulkGeneratedVariant,
} from "../types";
import { generateSku } from "./skuGenerator";

/**
 * Filter variants based on search and filter criteria
 */
export function filterVariants(
  variants: ProductVariant[],
  filters: VariantFilters
): ProductVariant[] {
  return variants.filter((variant) => {
    // Search term filter (searches in SKU, size, color)
    if (filters.searchTerm) {
      const searchLower = filters.searchTerm.toLowerCase();
      const matchesSearch =
        variant.sku.toLowerCase().includes(searchLower) ||
        variant.size?.toLowerCase().includes(searchLower) ||
        variant.color?.toLowerCase().includes(searchLower);

      if (!matchesSearch) return false;
    }

    // Price range filter
    if (filters.minPrice !== undefined && variant.price < filters.minPrice) {
      return false;
    }
    if (filters.maxPrice !== undefined && variant.price > filters.maxPrice) {
      return false;
    }

    // Stock range filter
    if (filters.minStock !== undefined && variant.stock < filters.minStock) {
      return false;
    }
    if (filters.maxStock !== undefined && variant.stock > filters.maxStock) {
      return false;
    }

    // Size filter
    if (filters.sizes.length > 0) {
      if (!variant.size || !filters.sizes.includes(variant.size)) {
        return false;
      }
    }

    // Color filter
    if (filters.colors.length > 0) {
      if (!variant.color || !filters.colors.includes(variant.color)) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Sort variants by specified field and order
 */
export function sortVariants(variants: ProductVariant[], sort: VariantSort): ProductVariant[] {
  const sorted = [...variants];

  sorted.sort((a, b) => {
    let aValue: any = a[sort.field];
    let bValue: any = b[sort.field];

    // Handle null/undefined values
    if (aValue === null || aValue === undefined) aValue = "";
    if (bValue === null || bValue === undefined) bValue = "";

    // Handle dates
    if (aValue instanceof Date) aValue = aValue.getTime();
    if (bValue instanceof Date) bValue = bValue.getTime();

    // Compare
    if (aValue < bValue) return sort.order === "asc" ? -1 : 1;
    if (aValue > bValue) return sort.order === "asc" ? 1 : -1;
    return 0;
  });

  return sorted;
}

/**
 * Get unique sizes from variants
 */
export function getUniqueSizes(variants: ProductVariant[]): string[] {
  const sizes = variants.map((v) => v.size).filter((s): s is string => s !== null);
  return Array.from(new Set(sizes)).sort();
}

/**
 * Get unique colors from variants
 */
export function getUniqueColors(variants: ProductVariant[]): string[] {
  const colors = variants.map((v) => v.color).filter((c): c is string => c !== null);
  return Array.from(new Set(colors)).sort();
}

/**
 * Generate variant combinations from sizes and colors
 */
export function generateVariantCombinations(
  options: BulkVariantOptions,
  productSlug?: string
): BulkGeneratedVariant[] {
  const combinations: BulkGeneratedVariant[] = [];

  // If no sizes or colors, create a single variant
  if (options.sizes.length === 0 && options.colors.length === 0) {
    combinations.push(
      createVariantFromOptions(options, null, null, 1, productSlug)
    );
    return combinations;
  }

  // If only sizes
  if (options.sizes.length > 0 && options.colors.length === 0) {
    options.sizes.forEach((size, index) => {
      combinations.push(
        createVariantFromOptions(options, size, null, index + 1, productSlug)
      );
    });
    return combinations;
  }

  // If only colors
  if (options.colors.length > 0 && options.sizes.length === 0) {
    options.colors.forEach((color, index) => {
      combinations.push(
        createVariantFromOptions(options, null, color, index + 1, productSlug)
      );
    });
    return combinations;
  }

  // Both sizes and colors - create all combinations
  let index = 1;
  for (const size of options.sizes) {
    for (const color of options.colors) {
      combinations.push(
        createVariantFromOptions(options, size, color, index, productSlug)
      );
      index++;
    }
  }

  return combinations;
}

/**
 * Create a single variant from bulk options
 */
function createVariantFromOptions(
  options: BulkVariantOptions,
  size: string | null,
  color: string | null,
  index: number,
  productSlug?: string
): BulkGeneratedVariant {
  const sku = generateSku(options.skuTemplate, {
    slug: productSlug,
    size,
    color,
    index,
  });

  return {
    size,
    color,
    sku,
    price: options.basePrice,
    stock: options.baseStock,
    weight: options.baseWeight,
    discountType: options.discountType,
    discountPercentage:
      options.discountType === "percentage" ? options.discountValue : null,
    discountAmount: options.discountType === "flat" ? options.discountValue : null,
  };
}

/**
 * Calculate effective price after discount
 */
export function calculateEffectivePrice(variant: ProductVariant): number {
  let effectivePrice = variant.price;

  if (variant.discountType === "percentage" && variant.discountPercentage) {
    effectivePrice = variant.price * (1 - variant.discountPercentage / 100);
  } else if (variant.discountType === "flat" && variant.discountAmount) {
    effectivePrice = Math.max(0, variant.price - variant.discountAmount);
  }

  return Math.round(effectivePrice * 100) / 100; // Round to 2 decimals
}

/**
 * Get stock level status
 */
export function getStockStatus(stock: number): "out-of-stock" | "low" | "in-stock" {
  if (stock === 0) return "out-of-stock";
  if (stock <= 10) return "low";
  return "in-stock";
}

/**
 * Format date for display
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Get discount display string
 */
export function getDiscountDisplay(variant: ProductVariant): string {
  if (variant.discountType === "percentage" && variant.discountPercentage) {
    return `${variant.discountPercentage}%`;
  } else if (variant.discountType === "flat" && variant.discountAmount) {
    return `৳${variant.discountAmount}`;
  }
  return "—";
}

/**
 * Check if variant has discount
 */
export function hasDiscount(variant: ProductVariant): boolean {
  return (
    (variant.discountType === "percentage" && (variant.discountPercentage ?? 0) > 0) ||
    (variant.discountType === "flat" && (variant.discountAmount ?? 0) > 0)
  );
}

/**
 * Duplicate a variant (without ID, with new SKU)
 */
export function duplicateVariant(
  variant: ProductVariant,
  skuSuffix: string = "-COPY"
): Omit<ProductVariant, "id" | "createdAt" | "updatedAt" | "deletedAt"> {
  return {
    size: variant.size,
    color: variant.color,
    weight: variant.weight,
    sku: variant.sku + skuSuffix,
    price: variant.price,
    stock: variant.stock,
    discountType: variant.discountType,
    discountPercentage: variant.discountPercentage,
    discountAmount: variant.discountAmount,
  };
}

/**
 * Validate SKU uniqueness
 */
export function isSkuUnique(sku: string, variants: ProductVariant[], excludeId?: string): boolean {
  return !variants.some((v) => v.sku === sku && v.id !== excludeId);
}

/**
 * Get variant statistics
 */
export function getVariantStats(variants: ProductVariant[]) {
  const totalStock = variants.reduce((sum, v) => sum + v.stock, 0);
  const totalValue = variants.reduce((sum, v) => sum + v.price * v.stock, 0);
  const averagePrice =
    variants.length > 0 ? variants.reduce((sum, v) => sum + v.price, 0) / variants.length : 0;
  const lowStockCount = variants.filter((v) => getStockStatus(v.stock) === "low").length;
  const outOfStockCount = variants.filter((v) => getStockStatus(v.stock) === "out-of-stock")
    .length;

  return {
    total: variants.length,
    totalStock,
    totalValue: Math.round(totalValue * 100) / 100,
    averagePrice: Math.round(averagePrice * 100) / 100,
    lowStockCount,
    outOfStockCount,
  };
}
