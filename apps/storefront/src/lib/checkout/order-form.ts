/**
 * The order form an app places in its markup (`<scalius-checkout>`, docs/
 * STOREFRONT-COMPONENTS.md "Core embeds"): the buyer picks an option and a
 * quantity and fills in name, phone and address on the landing page itself;
 * the form posts to the quick checkout (`/checkout/quick`), which checks
 * everything, quotes delivery, and places the cash-on-delivery order once
 * the buyer has seen the total. The lines are the same cart lines a product
 * page's quick buy builds, priced by the same engine.
 */
import type { ProductPageData } from "@/lib/api/products";
import { createCartItemKey, type CartItem } from "@/store/cart";
import { resolveVariantCartMedia } from "@/components/product/lib/cart-media";
import { calculateVariantPrice } from "@/components/product/lib/pricing-engine";
import { isVariantAvailable, resolveBuyerVariants } from "@/lib/product-sellable-variants";

export interface OrderFormOption {
  /** The variant id (the radio's value key). */
  id: string;
  /** "Red / XL", or the product name for a product without options. */
  label: string;
  /** The unit price in the store's minor-unit amount the cart uses. */
  price: number;
  /** The posted cart lines (`{ [cartKey]: CartItem }`, quantity 1), JSON. */
  cartItems: string;
}

export { QUICK_CHECKOUT_LINE_MAX_QUANTITY as ORDER_FORM_MAX_QUANTITY } from "./quick-checkout";

/**
 * The options a landing form offers, in the product's option order: every
 * available variant with its price. Empty when the product cannot be bought
 * from a form (inactive, sold out, needs buyer input or a gift card): the
 * embed then links to the product page instead.
 */
export function orderFormOptions(data: ProductPageData, currencyCode: string): OrderFormOption[] {
  const { product, variants } = data;
  if (
    !product.isActive || product.deletedAt || product.availableForSale === false || product.isGiftCard ||
    product.requiresCustomization || product.customizationUnavailable || (product.customization?.fields.length ?? 0) > 0
  ) return [];
  const resolution = resolveBuyerVariants(variants);
  if (resolution.mode === "ambiguous") return [];
  // In the product's own option order (S, M, L, XL), whatever order the variants were made in.
  const rank = (variant: (typeof resolution.variants)[number]) => [...variant.selectedOptions]
    .sort((left, right) => left.position - right.position)
    .map((option) => option.valuePosition);
  const ordered = [...resolution.variants].sort((left, right) => {
    const a = rank(left);
    const b = rank(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (a[index] ?? 0) - (b[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  return ordered.filter(isVariantAvailable).flatMap((variant) => {
    const price = calculateVariantPrice({
      basePrice: product.price,
      discountType: product.discountType,
      discountPercentage: product.discountPercentage,
      discountAmount: product.discountAmount,
      currencyCode,
    }, variant).finalPrice;
    if (!(price > 0)) return [];
    const options = [...variant.selectedOptions].sort((left, right) => left.position - right.position);
    const label = options.length > 0 ? options.map((option) => option.value).join(" / ") : product.name;
    const line: CartItem = {
      id: product.id,
      variantId: variant.id,
      slug: product.slug,
      name: product.name,
      price,
      quantity: 1,
      ...(options.length > 0 ? { options: options.map((option) => ({ name: option.name, label: option.value })) } : {}),
      ...resolveVariantCartMedia(variant, product),
      freeDelivery: product.freeDelivery,
      ...(variant.fulfillmentKind ? { fulfillmentKind: variant.fulfillmentKind } : {}),
    };
    return [{ id: variant.id, label, price, cartItems: JSON.stringify({ [createCartItemKey({ id: product.id, variantId: variant.id })]: line }) }];
  });
}

/** The options' name as the picker's label ("Size", "Size / Colour"); null for a product without options. */
export function orderFormOptionName(data: ProductPageData): string | null {
  const names = new Map<number, string>();
  for (const variant of data.variants) {
    for (const option of variant.selectedOptions) if (!names.has(option.position)) names.set(option.position, option.name);
  }
  const ordered = [...names].sort(([left], [right]) => left - right).map(([, name]) => name.trim()).filter(Boolean);
  return ordered.length > 0 ? ordered.join(" / ") : null;
}
