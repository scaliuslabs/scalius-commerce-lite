// A placed offer's Add to cart and Buy now with JavaScript: another
// product's SKU the merchant placed under the page's own offers
// (PlacedOffers.astro, a skin's `buyOffer` button; both bound by the host).
// One unit of the offer joins the cart from the line facts the page wrote
// (`#product-offer-lines`), at the price the page showed; the cart check
// prices and checks it as every line, and checkout decides. Loaded on the
// first press (product-controller.ts); without it the button posts the
// offer to its product's buy route.
import { addToCart, cartLineKeyFor, startBuyNow, type CartItem } from "@/store/cart";
import { isFulfillmentKind } from "@scalius/shared/fulfilment";
import { pagePath } from "@/lib/presence-url";

type OfferLine = Omit<CartItem, "quantity" | "propertiesHash" | "variantId"> & { variantId: string };

const text = (value: unknown, max: number) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

/** The cart line of one offer from the page's line facts, or null when the page names none for it. */
export function placedOfferLine(lines: unknown, variantId: string): OfferLine | null {
  const found = Array.isArray(lines) ? lines.find((line) => (line as { variantId?: unknown })?.variantId === variantId) as Record<string, unknown> | undefined : undefined;
  if (!found) return null;
  const id = text(found.id, 160);
  const slug = text(found.slug, 512);
  const name = text(found.name, 500);
  const price = typeof found.price === "number" && Number.isFinite(found.price) && found.price >= 0 ? found.price : null;
  if (!id || !slug || !name || price === null) return null;
  const options = Array.isArray(found.options)
    ? found.options.flatMap((option) => {
        const { name: axis, label } = (option ?? {}) as { name?: unknown; label?: unknown };
        return typeof axis === "string" && typeof label === "string" ? [{ name: axis, label }] : [];
      })
    : [];
  return {
    id,
    variantId,
    slug,
    name,
    price,
    ...(typeof found.image === "string" && found.image ? { image: found.image } : {}),
    ...(typeof found.imageMediaId === "string" && found.imageMediaId ? { imageMediaId: found.imageMediaId } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(isFulfillmentKind(found.fulfillmentKind) ? { fulfillmentKind: found.fulfillmentKind } : {}),
  };
}

/** Adds the button's offer (Buy now: then the cart). False when it could not be added here. */
export async function buyPlacedOffer(button: HTMLButtonElement): Promise<boolean> {
  let lines: unknown = [];
  try {
    lines = JSON.parse(document.getElementById("product-offer-lines")?.textContent ?? "[]");
  } catch {
    return false;
  }
  const line = placedOfferLine(lines, button.value);
  if (!line) return false;
  if (button.dataset.buyIntent === "buy") {
    if (!(await startBuyNow(line))) return false;
    window.location.href = pagePath("/cart");
    return true;
  }
  if (!(await addToCart(line))) return false;
  const addedLineKey = await cartLineKeyFor(line).catch(() => undefined);
  document.dispatchEvent(new CustomEvent("open-cart", { detail: { addedLineKey } }));
  return true;
}
