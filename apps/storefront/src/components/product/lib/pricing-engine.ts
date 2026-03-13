// src/components/product/lib/pricing-engine.ts
/**
 * Product Pricing Engine
 *
 * This module contains price calculation logic for the product page.
 *
 * Pricing Rules:
 * 1. Variant has its own price → Use variant price as base
 * 2. Variant has no price → Use product price as base
 * 3. Variant has its own discount → Apply variant discount
 * 4. Variant has no discount → Apply product discount to variant price
 * 5. Final price cannot be negative
 */

export type DiscountType = "percentage" | "flat" | null | undefined;

export interface ProductPricing {
  basePrice: number;
  discountType: DiscountType;
  discountPercentage: number | null | undefined;
  discountAmount: number | null | undefined;
}

export interface VariantPricing {
  price: number | null | undefined;
  discountType: DiscountType;
  discountPercentage: number | null | undefined;
  discountAmount: number | null | undefined;
}

export interface PriceCalculationResult {
  originalPrice: number;
  finalPrice: number;
  discountType: DiscountType;
  discountPercentage: number;
  discountAmount: number;
  hasDiscount: boolean;
  savingsAmount: number;
  savingsPercentage: number;
}

/**
 * Calculate discounted price based on discount type
 */
function applyDiscount(
  price: number,
  discountType: DiscountType,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined,
): number {
  if (discountType === "flat" && discountAmount) {
    return Math.max(0, Math.round(price - discountAmount));
  }

  if (discountType === "percentage" && discountPercentage) {
    return Math.max(0, Math.round(price * (1 - discountPercentage / 100)));
  }

  return price;
}

/**
 * Check if a discount configuration is valid
 */
function hasValidDiscount(
  discountType: DiscountType,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined,
): boolean {
  if (discountType === "percentage") {
    return (
      discountPercentage !== null &&
      discountPercentage !== undefined &&
      discountPercentage > 0
    );
  }

  if (discountType === "flat") {
    return (
      discountAmount !== null &&
      discountAmount !== undefined &&
      discountAmount > 0
    );
  }

  return false;
}

/**
 * Calculate the final price for a product variant
 *
 * Priority:
 * 1. Variant price (if set) OR product price (fallback)
 * 2. Variant discount (if set) OR product discount (fallback)
 */
export function calculateVariantPrice(
  productPricing: ProductPricing,
  variantPricing: VariantPricing | null,
): PriceCalculationResult {
  // No variant selected - use product pricing
  if (!variantPricing) {
    return calculateProductPrice(productPricing);
  }

  // Determine base price
  const variantHasPrice =
    variantPricing.price !== null && variantPricing.price !== undefined;
  const basePrice: number = variantHasPrice
    ? variantPricing.price!
    : productPricing.basePrice;

  // Determine which discount to apply
  const variantHasDiscount = hasValidDiscount(
    variantPricing.discountType,
    variantPricing.discountPercentage,
    variantPricing.discountAmount,
  );

  let finalPrice: number;
  let appliedDiscountType: DiscountType;
  let appliedDiscountPercentage: number;
  let appliedDiscountAmount: number;

  if (variantHasDiscount) {
    // Use variant discount
    finalPrice = applyDiscount(
      basePrice,
      variantPricing.discountType,
      variantPricing.discountPercentage,
      variantPricing.discountAmount,
    );
    appliedDiscountType = variantPricing.discountType;
    appliedDiscountPercentage = variantPricing.discountPercentage || 0;
    appliedDiscountAmount = variantPricing.discountAmount || 0;
  } else {
    // Use product discount
    finalPrice = applyDiscount(
      basePrice,
      productPricing.discountType,
      productPricing.discountPercentage,
      productPricing.discountAmount,
    );
    appliedDiscountType = productPricing.discountType;
    appliedDiscountPercentage = productPricing.discountPercentage || 0;
    appliedDiscountAmount = productPricing.discountAmount || 0;
  }

  const savingsAmount = basePrice - finalPrice;
  const savingsPercentage =
    basePrice > 0 ? Math.round((savingsAmount / basePrice) * 100) : 0;

  return {
    originalPrice: basePrice,
    finalPrice,
    discountType: appliedDiscountType,
    discountPercentage: appliedDiscountPercentage,
    discountAmount: appliedDiscountAmount,
    hasDiscount: savingsAmount > 0,
    savingsAmount,
    savingsPercentage,
  };
}

/**
 * Calculate the final price for a product (no variant)
 */
export function calculateProductPrice(
  productPricing: ProductPricing,
): PriceCalculationResult {
  const basePrice = productPricing.basePrice;
  const finalPrice = applyDiscount(
    basePrice,
    productPricing.discountType,
    productPricing.discountPercentage,
    productPricing.discountAmount,
  );

  const savingsAmount = basePrice - finalPrice;
  const savingsPercentage =
    basePrice > 0 ? Math.round((savingsAmount / basePrice) * 100) : 0;

  return {
    originalPrice: basePrice,
    finalPrice,
    discountType: productPricing.discountType,
    discountPercentage: productPricing.discountPercentage || 0,
    discountAmount: productPricing.discountAmount || 0,
    hasDiscount: savingsAmount > 0,
    savingsAmount,
    savingsPercentage,
  };
}

function getSymbol(): string {
  if (typeof window !== "undefined" && (window as any).__CURRENCY_SYMBOL__) {
    return (window as any).__CURRENCY_SYMBOL__;
  }
  return "৳";
}

/**
 * Format price for display (e.g., "৳1,234.00")
 */
export function formatPrice(price: number, currencySymbol?: string): string {
  const sym = currencySymbol ?? getSymbol();
  return `${sym}${price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Format discount badge text (e.g., "-20%" or "-৳200")
 */
export function formatDiscountBadge(
  discountType: DiscountType,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined,
  currencySymbol?: string,
): string | null {
  if (
    discountType === "percentage" &&
    discountPercentage &&
    discountPercentage > 0
  ) {
    return `-${Math.round(discountPercentage)}%`;
  }

  if (discountType === "flat" && discountAmount && discountAmount > 0) {
    const sym = currencySymbol ?? getSymbol();
    return `-${sym}${discountAmount.toLocaleString()}`;
  }

  return null;
}

/**
 * Format savings text (e.g., "Save ৳200")
 */
export function formatSavings(savingsAmount: number, currencySymbol?: string): string {
  if (savingsAmount <= 0) return "";
  return `Save ${formatPrice(savingsAmount, currencySymbol)}`;
}

/**
 * Calculate the discounted price based on discount type and values.
 * Simple standalone calculation - use calculateVariantPrice for full variant logic.
 */
export function calculateDiscountedPrice(
  price: number,
  discountType: DiscountType,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined,
): number {
  return applyDiscount(price, discountType, discountPercentage, discountAmount);
}

/**
 * Get the final discounted price for a product variant.
 * Convenience wrapper around calculateVariantPrice for simple use cases.
 *
 * Priority: Variant discount > Product discount > Original price
 */
export function getVariantDiscountedPrice(
  variantPrice: number | null | undefined,
  productPrice: number,
  variantDiscountType: DiscountType,
  variantDiscountPercentage: number | null | undefined,
  variantDiscountAmount: number | null | undefined,
  productDiscountType: DiscountType,
  productDiscountPercentage: number | null | undefined,
  productDiscountAmount: number | null | undefined,
): number {
  const productPricing: ProductPricing = {
    basePrice: productPrice,
    discountType: productDiscountType,
    discountPercentage: productDiscountPercentage,
    discountAmount: productDiscountAmount,
  };

  const variantPricing: VariantPricing = {
    price: variantPrice,
    discountType: variantDiscountType,
    discountPercentage: variantDiscountPercentage,
    discountAmount: variantDiscountAmount,
  };

  return calculateVariantPrice(productPricing, variantPricing).finalPrice;
}

/**
 * Calculate line item total (price × quantity)
 */
export function calculateLineTotal(price: number, quantity: number): number {
  return Math.max(0, price * quantity);
}

/**
 * Calculate cart subtotal
 */
export function calculateCartSubtotal(
  items: Array<{ price: number; quantity: number }>,
): number {
  return items.reduce(
    (total, item) => total + calculateLineTotal(item.price, item.quantity),
    0,
  );
}

/**
 * Apply cart-level discount
 */
export function applyCartDiscount(
  subtotal: number,
  discountType: "percentage" | "flat",
  discountValue: number,
): {
  discountedTotal: number;
  discountAmount: number;
} {
  let discountAmount = 0;

  if (discountType === "percentage") {
    discountAmount = Math.round(subtotal * (discountValue / 100));
  } else if (discountType === "flat") {
    discountAmount = discountValue;
  }

  const discountedTotal = Math.max(0, subtotal - discountAmount);

  return {
    discountedTotal,
    discountAmount,
  };
}

/**
 * Get the price range for variants
 */
export function getVariantPriceRange(
  productPricing: ProductPricing,
  variants: VariantPricing[],
): {
  minPrice: number;
  maxPrice: number;
  hasPriceRange: boolean;
} {
  if (variants.length === 0) {
    const result = calculateProductPrice(productPricing);
    return {
      minPrice: result.finalPrice,
      maxPrice: result.finalPrice,
      hasPriceRange: false,
    };
  }

  const prices = variants.map(
    (variant) => calculateVariantPrice(productPricing, variant).finalPrice,
  );

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  return {
    minPrice,
    maxPrice,
    hasPriceRange: minPrice !== maxPrice,
  };
}

/**
 * Format price range for display
 */
export function formatPriceRange(minPrice: number, maxPrice: number, currencySymbol?: string): string {
  if (minPrice === maxPrice) {
    return formatPrice(minPrice, currencySymbol);
  }
  return `${formatPrice(minPrice, currencySymbol)} - ${formatPrice(maxPrice, currencySymbol)}`;
}
