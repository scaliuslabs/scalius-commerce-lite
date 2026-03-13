// src/components/product/lib/product-validation.ts
/**
 * Product Validation Module
 */

export const QUANTITY_CONSTRAINTS = {
  MIN: 1,
  MAX: 99,
} as const;

/**
 * Validate and normalize quantity input
 */
export function validateQuantity(input: string | number): {
  valid: boolean;
  value: number;
  error: string | null;
} {
  const parsed = typeof input === "string" ? parseInt(input, 10) : input;

  if (isNaN(parsed)) {
    return {
      valid: false,
      value: QUANTITY_CONSTRAINTS.MIN,
      error: "Quantity must be a number",
    };
  }

  if (parsed < QUANTITY_CONSTRAINTS.MIN) {
    return {
      valid: false,
      value: QUANTITY_CONSTRAINTS.MIN,
      error: `Minimum quantity is ${QUANTITY_CONSTRAINTS.MIN}`,
    };
  }

  if (parsed > QUANTITY_CONSTRAINTS.MAX) {
    return {
      valid: false,
      value: QUANTITY_CONSTRAINTS.MAX,
      error: `Maximum quantity is ${QUANTITY_CONSTRAINTS.MAX}`,
    };
  }

  return {
    valid: true,
    value: parsed,
    error: null,
  };
}

/**
 * Clamp quantity to valid range
 */
export function clampQuantity(quantity: number): number {
  return Math.max(
    QUANTITY_CONSTRAINTS.MIN,
    Math.min(QUANTITY_CONSTRAINTS.MAX, quantity),
  );
}

/**
 * Check if stock is available for requested quantity
 */
export function isStockAvailable(
  stock: number,
  requestedQuantity: number,
): {
  available: boolean;
  maxAvailable: number;
  error: string | null;
} {
  if (stock <= 0) {
    return {
      available: false,
      maxAvailable: 0,
      error: "Product is out of stock",
    };
  }

  if (requestedQuantity > stock) {
    return {
      available: false,
      maxAvailable: stock,
      error: `Only ${stock} items available`,
    };
  }

  return {
    available: true,
    maxAvailable: stock,
    error: null,
  };
}

/**
 * Get stock status category
 */
export function getStockStatus(stock: number): {
  status: "in_stock" | "low_stock" | "out_of_stock";
  text: string;
  canOrder: boolean;
} {
  if (stock > 50) {
    return {
      status: "in_stock",
      text: "In Stock",
      canOrder: true,
    };
  }

  if (stock > 0) {
    return {
      status: "low_stock",
      text: "Low Stock",
      canOrder: true,
    };
  }

  return {
    status: "out_of_stock",
    text: "Out of Stock",
    canOrder: false,
  };
}

export interface ProductData {
  id: string;
  slug: string;
  name: string;
  price: number;
  image: string | null | undefined;
}

/**
 * Validate required product data for cart operations
 */
export function validateProductData(data: Partial<ProductData>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!data.id || data.id.trim() === "") {
    errors.push("Product ID is required");
  }

  if (!data.slug || data.slug.trim() === "") {
    errors.push("Product slug is required");
  }

  if (!data.name || data.name.trim() === "") {
    errors.push("Product name is required");
  }

  if (data.price === undefined || data.price === null || data.price < 0) {
    errors.push("Valid product price is required");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate image URL
 */
export function isValidImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url, window.location.origin);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "data:"
    );
  } catch {
    return false;
  }
}

/**
 * Get fallback image if invalid
 */
export function getFallbackImage(
  url: string | null | undefined,
  fallback: string = "/placeholder-product.png",
): string {
  return isValidImageUrl(url) ? url! : fallback;
}

/**
 * Validate all inputs before adding to cart
 */
export interface AddToCartValidation {
  valid: boolean;
  errors: string[];
  data: {
    id: string;
    slug: string;
    name: string;
    price: number;
    quantity: number;
    variantId?: string;
    size?: string;
    color?: string;
    image?: string;
    freeDelivery?: boolean;
  } | null;
}

export function validateAddToCart(input: {
  productId?: string;
  slug?: string;
  name?: string;
  price?: number;
  quantity?: number;
  stock?: number;
  variantId?: string;
  size?: string;
  color?: string;
  image?: string;
  freeDelivery?: boolean;
}): AddToCartValidation {
  const errors: string[] = [];

  // Validate product data
  const productValidation = validateProductData({
    id: input.productId,
    slug: input.slug,
    name: input.name,
    price: input.price,
    image: input.image,
  });

  if (!productValidation.valid) {
    errors.push(...productValidation.errors);
  }

  // Validate quantity
  const quantity = input.quantity || 1;
  const quantityValidation = validateQuantity(quantity);

  if (!quantityValidation.valid) {
    errors.push(quantityValidation.error!);
  }

  // Validate stock
  if (input.stock !== undefined) {
    const stockValidation = isStockAvailable(
      input.stock,
      quantityValidation.value,
    );
    if (!stockValidation.available) {
      errors.push(stockValidation.error!);
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      data: null,
    };
  }

  return {
    valid: true,
    errors: [],
    data: {
      id: input.productId!,
      slug: input.slug!,
      name: input.name!,
      price: input.price!,
      quantity: quantityValidation.value,
      variantId: input.variantId,
      size: input.size,
      color: input.color,
      image: input.image,
      freeDelivery: input.freeDelivery,
    },
  };
}
