/**
 * An empty cart is not a dead end: under it, the store's popular products
 * (the public recommendations list without a source product). The categories
 * beside them are server-rendered; this fills only the products, and only
 * once the cart is known to be empty, so a full cart never asks for them.
 */
import type { Product } from "@/lib/api";
import { fetchRecommendationsFromBrowser } from "@/lib/recommendations";
import { formatMoney } from "@/lib/currency";
import { pagePath } from "@/lib/presence-url";
import { productImageSources } from "@/lib/product-media";
import type { ImageSlot } from "@/lib/responsive-image";

const SUGGESTION_LIMIT = 8;
const SUGGESTION_IMAGE: ImageSlot = { width: 240, sizes: "(min-width: 640px) 22vw, 44vw", maxWidth: 480 };

function suggestionCard(product: Product): HTMLLIElement {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = pagePath(`/products/${encodeURIComponent(product.slug)}`);
  link.className = "flex h-full flex-col rounded-lg border border-border bg-card p-2 transition-colors hover:border-foreground/30";

  const sources = productImageSources(product.imageUrl, SUGGESTION_IMAGE);
  const image = document.createElement("img");
  image.src = sources.src;
  if (sources.srcset) image.srcset = sources.srcset;
  if (sources.sizes) image.sizes = sources.sizes;
  image.alt = "";
  image.width = 240;
  image.height = 240;
  image.loading = "lazy";
  image.decoding = "async";
  image.className = "aspect-square w-full rounded-md bg-muted object-cover";

  const name = document.createElement("span");
  name.className = "mt-2 line-clamp-2 text-sm font-medium leading-snug text-foreground";
  name.textContent = product.name;

  const price = document.createElement("span");
  price.className = "mt-auto pt-1 text-sm font-semibold tabular-nums text-foreground";
  price.textContent = formatMoney(product.discountedPrice);

  link.append(image, name, price);
  item.append(link);
  return item;
}

let requested = false;

/** Fills the empty cart's "Popular now" list once; a failed or empty answer leaves it out. */
export async function showEmptyCartSuggestions(): Promise<void> {
  const section = document.querySelector<HTMLElement>("[data-cart-empty-popular]");
  const list = section?.querySelector<HTMLElement>("ul");
  if (!section || !list || requested) return;
  requested = true;
  const recommendations = await fetchRecommendationsFromBrowser([], SUGGESTION_LIMIT);
  if (!recommendations || recommendations.products.length === 0) return;
  list.replaceChildren(...recommendations.products.map(suggestionCard));
  section.hidden = false;
}

/** For tests and page swaps: the next empty cart asks again. */
export function resetEmptyCartSuggestions(): void {
  requested = false;
}
