// The product page's own check of a line before it reaches the cart
// (product-controller.ts). It runs in the buyer's browser on every add, so
// it stays small: its problems are codes for the controller, which shows
// the page's own words, never these.
import type { BuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
import { PUBLIC_BUYER_QUANTITY_CEILING } from "@scalius/shared/buyer-availability";

export const QUANTITY_CONSTRAINTS = {
  MIN: 1,
  MAX: PUBLIC_BUYER_QUANTITY_CEILING,
} as const;

/** Clamp quantity to valid range */
export function clampQuantity(quantity: number): number {
  return Math.max(
    QUANTITY_CONSTRAINTS.MIN,
    Math.min(QUANTITY_CONSTRAINTS.MAX, quantity),
  );
}

/**
 * Why a line was refused: the product's facts are missing, the quantity is
 * out of range, the SKU's band is sold out, or (an untracked band only)
 * fewer are left than asked for.
 */
export type AddToCartProblem = "product" | "quantity" | "out_of_stock" | "stock";

export interface AddToCartValidation {
  valid: boolean;
  errors: AddToCartProblem[];
  data: {
    id: string;
    slug: string;
    name: string;
    price: number;
    quantity: number;
    variantId?: string;
    image?: string;
    imageMediaId?: string;
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
  reservedStock?: number;
  trackInventory?: boolean;
  availabilityBand?: BuyerAvailabilityBand;
  variantId?: string;
  image?: string;
  imageMediaId?: string;
  freeDelivery?: boolean;
}): AddToCartValidation {
  const errors: AddToCartProblem[] = [];
  if (!input.productId?.trim() || !input.slug?.trim() || !input.name?.trim() || input.price == null || input.price < 0) errors.push("product");
  const quantity = input.quantity || 1;
  if (!Number.isInteger(quantity) || quantity < QUANTITY_CONSTRAINTS.MIN || quantity > QUANTITY_CONSTRAINTS.MAX) errors.push("quantity");
  // A public band is the buyer's truth (live cart validation checks the
  // quantity); only a SKU without one is checked against its stock here.
  if (input.availabilityBand === "out_of_stock") errors.push("out_of_stock");
  else if (input.availabilityBand === undefined && input.trackInventory !== false && input.stock !== undefined) {
    const available = Math.max(0, input.stock - (input.reservedStock ?? 0));
    if (available <= 0) errors.push("out_of_stock");
    else if (quantity > available) errors.push("stock");
  }
  if (errors.length > 0) return { valid: false, errors, data: null };
  return {
    valid: true,
    errors: [],
    data: {
      id: input.productId!,
      slug: input.slug!,
      name: input.name!,
      price: input.price!,
      quantity,
      variantId: input.variantId,
      image: input.image,
      imageMediaId: input.imageMediaId,
      freeDelivery: input.freeDelivery,
    },
  };
}
