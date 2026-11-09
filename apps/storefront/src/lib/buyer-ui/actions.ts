import type { BuyerUiBlock } from "@scalius/shared/plugins/buyer-ui";
import type { PluginUiAction } from "@scalius/shared/plugins/ui";
import { isCartSlot } from "./state";
import { appScopedKey, PLUGIN_ID_PATTERN, purchaseOptionAppId } from "@scalius/shared/plugins/ids";
import type { ProductPageData } from "@/lib/api/products";
import { browserApiUrl } from "@/lib/api/browser-url";
import { unwrapEnvelope } from "@/lib/api/unwrap";
import { currentPresence } from "@/lib/presence-url";
import { isVariantAvailable, resolveBuyerVariants } from "@/lib/product-sellable-variants";
import { calculateVariantPrice } from "@/components/product/lib/pricing-engine";
import { resolveVariantCartMedia } from "@/components/product/lib/cart-media";
import { addDiscountCode, addToCart, cartLineKeyFor, type CartLineProperty } from "@/store/cart";
import { acceptedNewCartLine, validateCartLinesInBrowser, validateNewCartLine } from "@/lib/cart/new-line";
import { normalizeCartLinePurchaseOptions } from "@/lib/cart/purchase-option";
import { appLineInputShown } from "@/components/product/lib/app-line-inputs";
import {
  resolveLineProperties,
  withAppLineInputs,
  type AppLineInputDeclaration,
} from "@scalius/shared/line-properties";

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

/** A route or cart action (`set_attribute` and `navigate` run in the renderer). */
export type RunnableAction = Exclude<PluginUiAction, { kind: "navigate" } | { op: "set_attribute" }>;

/**
 * Adds a SKU without buyer inputs of its own to the cart: one-time, or under
 * a purchase option of `appId` (the app that asked), priced by the store for
 * that option. `inputs` are that app's own line inputs by key (`lineInputs`,
 * its manifest's `checkout.lineInputs` as the host drew them): the line
 * carries them as `<app id>.<key>`; a key it does not declare (or does not
 * show on this product) or a value its input refuses is refused, as is any
 * input without `lineInputs`. Returns the line's key; throws the buyer's
 * words when it can't be added.
 */
export async function addVariantLine(
  action: { variantId: string; quantity: number; purchaseOption?: string; inputs?: Record<string, string> },
  appId: string,
  lineInputs: readonly AppLineInputDeclaration[] = [],
): Promise<string> {
  if (!action.variantId || action.variantId.length > 128 || !Number.isInteger(action.quantity)
    || action.quantity < 1 || action.quantity > 10) throw new Error(UNAVAILABLE);
  // An app sells a line only under its own option.
  if (action.purchaseOption !== undefined && purchaseOptionAppId(action.purchaseOption) !== appId) throw new Error(UNAVAILABLE);
  const inputs = Object.entries(action.inputs ?? {});
  if (inputs.some(([, value]) => typeof value !== "string")) throw new Error(UNAVAILABLE);
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
  if (!(price > 0) || ((action.purchaseOption || inputs.length > 0) && product.isGiftCard)) throw new Error(UNAVAILABLE);
  // The app's own line inputs, checked as the buy form checks them (the
  // product's own inputs already sent the buyer to its page).
  const schema = product.isGiftCard ? null : withAppLineInputs(null, [{ appId, inputs: lineInputs }], appLineInputShown(product.customFields));
  const declared = new Set((schema?.fields ?? []).map((field) => field.key));
  const values = inputs.map(([key, value]) => ({ key: appScopedKey(appId, key), value }));
  if (values.some(({ key }) => !declared.has(key))) throw new Error(UNAVAILABLE);
  // The strict check on the values as given: a refused one (a box sent as "on") refuses the add, never drops.
  const resolved = resolveLineProperties(schema, values);
  if (!resolved.ok) throw new Error(UNAVAILABLE);
  let properties: CartLineProperty[] = resolved.properties.map(({ key, value, label, displayValue, priceMinor }) => ({ key, value, label, displayValue, priceMinor }));
  const options = variant.selectedOptions.map((option) => ({ name: option.name, label: option.value }));
  let linePrice = price;
  let purchaseOptions: Array<{ id: string; title: string }> = [];
  if (action.purchaseOption || properties.length > 0) {
    // The app prices its option and inputs: the line takes the store's price for them.
    const checked = acceptedNewCartLine(await validateNewCartLine(validateCartLinesInBrowser, {
      cartKey: "new", productId: product.id, variantId: variant.id, quantity: action.quantity,
      productName: product.name, variantLabel: options.map((option) => option.label).join(" / ") || null,
      ...(properties.length > 0 ? { properties: resolved.canonical } : {}),
      ...(action.purchaseOption ? { purchaseOptions: [action.purchaseOption] } : {}),
    }));
    if (!checked.item) throw new Error(checked.message || UNAVAILABLE);
    linePrice = checked.item.unitPrice;
    const answeredOptions = normalizeCartLinePurchaseOptions(checked.item.purchaseOptions) ?? [];
    purchaseOptions = answeredOptions.length > 0 || !action.purchaseOption
      ? answeredOptions
      : [{ id: action.purchaseOption, title: action.purchaseOption }];
    const answered = (checked.item.properties ?? []).map(({ key, value, label, displayValue, priceMinor }) => ({ key, value, label, displayValue, priceMinor: Number.isSafeInteger(priceMinor) && priceMinor > 0 ? priceMinor : 0 }));
    if (answered.length > 0) properties = answered;
  }
  const line = {
    id: product.id, variantId: variant.id, slug: product.slug, name: product.name,
    price: linePrice, quantity: action.quantity, freeDelivery: product.freeDelivery, options,
    ...(properties.length > 0 ? { properties } : {}),
    ...(purchaseOptions.length > 0 ? { purchaseOptions } : {}),
    ...resolveVariantCartMedia(variant, product),
    ...(variant.fulfillmentKind ? { fulfillmentKind: variant.fulfillmentKind } : {}),
  };
  const added = await addToCart(line).catch(() => { throw new Error(FAILED); });
  if (!added) throw new Error("This item could not be added. Check the quantity in your cart.");
  return cartLineKeyFor(line);
}

function message(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120 ? value.trim() : undefined;
}

/** Only explicit buyer clicks run these actions; the renderer sets attributes and opens pages itself. */
export async function runBuyerUiAction(action: RunnableAction, block: BuyerUiBlock): Promise<{ message?: string }> {
  if (action.kind === "cart") {
    if (!isCartSlot(block.target)) throw new Error(FAILED);
    if (action.op === "add_line") {
      await addVariantLine(action, block.appId);
      return { message: "Item added to your cart." };
    }
    if (!addDiscountCode(action.code)) throw new Error("This code could not be added, or is already in your cart.");
    return { message: "Code added. Your cart will check whether it applies." };
  }
  if (action.kind !== "route" || !PLUGIN_ID_PATTERN.test(block.appId) || !/^[a-z][a-z0-9_-]{0,47}$/.test(action.route)
    || (action.subpath !== undefined && !/^[A-Za-z0-9_~-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/.test(action.subpath))) {
    throw new Error(FAILED);
  }
  const response = await fetch(`/apps/${block.appId}/${action.route}${action.subpath ? `/${action.subpath}` : ""}`, {
    method: action.method ?? "POST", credentials: "same-origin", redirect: "error",
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
