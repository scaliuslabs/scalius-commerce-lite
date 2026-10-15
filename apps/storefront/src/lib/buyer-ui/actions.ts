import type { BuyerUiAction, BuyerUiBlock } from "@scalius/shared/plugins/buyer-ui";
import { PLUGIN_ID_PATTERN } from "@scalius/shared/plugins/ids";
import type { ProductPageData } from "@/lib/api/products";
import { browserApiUrl } from "@/lib/api/browser-url";
import { unwrapEnvelope } from "@/lib/api/unwrap";
import { currentPresence } from "@/lib/presence-url";
import { isVariantAvailable, resolveBuyerVariants } from "@/lib/product-sellable-variants";
import { calculateVariantPrice } from "@/components/product/lib/pricing-engine";
import { resolveVariantCartMedia } from "@/components/product/lib/cart-media";
import { addDiscountCode, addToCart } from "@/store/cart";

const FAILED = "This action could not be completed. Please try again.";
const UNAVAILABLE = "This item cannot be added here. Open its product page to choose it.";

async function publicRead<T>(path: string, query = new URLSearchParams()): Promise<T> {
  const presence = currentPresence();
  if (presence) query.set("presence", presence);
  const response = await fetch(browserApiUrl(`${path}${query.size ? `?${query}` : ""}`), {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error(UNAVAILABLE); });
  const data = unwrapEnvelope<T>(await response.json().catch(() => null));
  if (!response.ok || !data) throw new Error(UNAVAILABLE);
  return data;
}

async function addLine(action: Extract<BuyerUiAction, { kind: "add_line" }>): Promise<void> {
  if (!action.variantId || action.variantId.length > 128 || !Number.isInteger(action.quantity)
    || action.quantity < 1 || action.quantity > 10) throw new Error(UNAVAILABLE);
  // Resolve through the online store, independent of feed/agent channel publication.
  const listing = await publicRead<{ products: Array<{ id: string; slug: string }> }>(
    "/products", new URLSearchParams({ ids: action.variantId, limit: "1" }),
  );
  const candidate = listing.products?.[0];
  if (!candidate?.slug) throw new Error(UNAVAILABLE);
  const data = await publicRead<ProductPageData>(`/products/${encodeURIComponent(candidate.slug)}`);
  const { product } = data;
  if (!product || product.id !== candidate.id || !product.isActive || product.deletedAt
    || product.availableForSale === false || product.requiresCustomization || product.customizationUnavailable
    || (product.customization?.fields.length ?? 0) > 0 || !Array.isArray(data.variants)) throw new Error(UNAVAILABLE);
  const variant = resolveBuyerVariants(data.variants).variants.find((entry) => entry.id === action.variantId);
  if (!variant || variant.productId !== product.id || !isVariantAvailable(variant)) throw new Error(UNAVAILABLE);
  const price = calculateVariantPrice({
    basePrice: product.price, discountType: product.discountType,
    discountPercentage: product.discountPercentage, discountAmount: product.discountAmount,
  }, variant).finalPrice;
  if (!(price > 0)) throw new Error(UNAVAILABLE);
  const added = await addToCart({
    id: product.id, variantId: variant.id, slug: product.slug, name: product.name,
    price, quantity: action.quantity, freeDelivery: product.freeDelivery,
    options: variant.selectedOptions.map((option) => ({ name: option.name, label: option.value })),
    ...resolveVariantCartMedia(variant, product),
    ...(variant.fulfillmentKind ? { fulfillmentKind: variant.fulfillmentKind } : {}),
  }).catch(() => { throw new Error(FAILED); });
  if (!added) throw new Error("This item could not be added. Check the quantity in your cart.");
}

function message(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120 ? value.trim() : undefined;
}

/** Only explicit buyer clicks run these actions; the renderer sets attributes locally. */
export async function runBuyerUiAction(action: BuyerUiAction, block: BuyerUiBlock): Promise<{ message?: string }> {
  if (action.kind !== "app_route" && !block.target.startsWith("purchase.checkout.")) throw new Error(FAILED);
  if (action.kind === "add_line") {
    await addLine(action);
    return { message: "Item added to your cart." };
  }
  if (action.kind === "apply_code") {
    if (!addDiscountCode(action.code)) throw new Error("This code could not be added, or is already in your cart.");
    return { message: "Code added. Your cart will check whether it applies." };
  }
  if (action.kind !== "app_route" || !PLUGIN_ID_PATTERN.test(block.appId) || !/^[a-z][a-z0-9-]{0,47}$/.test(action.route)) {
    throw new Error(FAILED);
  }
  const response = await fetch(`/apps/${block.appId}/${action.route}`, {
    method: "POST", credentials: "same-origin", redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(action.body ?? {}), signal: AbortSignal.timeout(35_000),
  }).catch(() => { throw new Error(FAILED); });
  // ui.result text only: app responses cannot navigate, inject HTML or mutate the cart.
  const result = await response.json().catch(() => null) as {
    toast?: { message?: unknown; tone?: unknown }; errors?: Record<string, unknown>;
  } | null;
  const error = result?.errors && typeof result.errors === "object"
    ? Object.values(result.errors).map(message).find(Boolean) : undefined;
  const toast = message(result?.toast?.message);
  if (!response.ok || error || result?.toast?.tone === "critical") throw new Error(error ?? toast ?? FAILED);
  return toast ? { message: toast } : {};
}
