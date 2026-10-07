import type { ProductPageData } from "@/lib/api/products";
import type { CartItem } from "@/store/cart";
import { resolveVariantCartMedia } from "@/components/product/lib/cart-media";
import { calculateVariantPrice } from "@/components/product/lib/pricing-engine";
import { trackProductAddToCart } from "@/components/product/lib/product-analytics";
import { isVariantAvailable, resolveBuyerVariants } from "@/lib/product-sellable-variants";

/** Listing data has no SKU ID; the public detail read resolves the exact simple SKU on click. */
export function quickAddCartLine(data: ProductPageData, currencyCode: string): CartItem | null {
  const { product, variants } = data;
  if (
    !product.isActive || product.deletedAt || product.availableForSale === false ||
    product.hasVariants || product.requiresCustomization || product.customizationUnavailable ||
    (product.customization?.fields.length ?? 0) > 0
  ) return null;
  const resolution = resolveBuyerVariants(variants);
  const variant = resolution.mode === "simple" ? resolution.variants[0] : null;
  if (!variant || !isVariantAvailable(variant)) return null;
  const price = calculateVariantPrice({
    basePrice: product.price,
    discountType: product.discountType,
    discountPercentage: product.discountPercentage,
    discountAmount: product.discountAmount,
    currencyCode,
  }, variant).finalPrice;
  if (!(price > 0)) return null;
  return {
    id: product.id,
    variantId: variant.id,
    slug: product.slug,
    name: product.name,
    price,
    quantity: 1,
    ...resolveVariantCartMedia(variant, product),
    freeDelivery: product.freeDelivery,
    ...(variant.fulfillmentKind ? { fulfillmentKind: variant.fulfillmentKind } : {}),
  };
}

export function initQuickAddCards(): void {
  document.addEventListener("click", async (event) => {
    const target = event.target;
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[data-card-quick-add]") : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (link.dataset.busy) return;
    link.dataset.busy = "true";
    link.setAttribute("aria-busy", "true");
    try {
      const slug = new URL(link.href).pathname.split("/").pop();
      if (!slug) throw new Error("Missing product handle");
      const [{ getProductBySlugResult }, { addToCart, cartLineKeyFor }] = await Promise.all([
        import("@/lib/api/products"),
        import("@/store/cart"),
      ]);
      const result = await getProductBySlugResult(decodeURIComponent(slug));
      const line = result.state === "found"
        ? quickAddCartLine(result.data, window.__CURRENCY_CODE__ || "BDT")
        : null;
      if (!line || !(await addToCart(line))) throw new Error("Product requires its detail page");
      trackProductAddToCart({
        product: { id: line.id, name: line.name, price: line.price },
        variant: { id: line.variantId!, price: line.price },
        quantity: 1,
      });
      const addedLineKey = await cartLineKeyFor({ id: line.id, variantId: line.variantId! }).catch(() => undefined);
      document.dispatchEvent(new CustomEvent("open-cart", { detail: { addedLineKey } }));
    } catch {
      window.location.assign(link.href);
    } finally {
      delete link.dataset.busy;
      link.removeAttribute("aria-busy");
    }
  });
}
