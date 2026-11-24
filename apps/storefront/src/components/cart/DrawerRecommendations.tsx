// The cart drawer's suggestions ("You might also like", the drawer part
// `recommendations`): loaded with the open drawer once it holds items, never
// with the first add to cart, whose script budget it would spend on a rail
// that is fetched 400ms later anyway.
import React, { useEffect, useState } from "react";
import type { ProductRecommendations } from "@/lib/api/types";
import { formatMoney } from "@/lib/currency";
import { priceCopy as storefrontPriceCopy } from "@/lib/price-copy";
import { pagePath } from "@/lib/presence-url";
import { productImageSources } from "@/lib/product-media";
import { fetchRecommendationsFromBrowser, recommendationQuery, recommendationTitle } from "@/lib/recommendations";
import type { ImageSlot } from "@/lib/responsive-image";
import { pageLanguage } from "@/lib/store-time-zone";

const CART_RECOMMENDATION_LIMIT = 4;
const CART_RECOMMENDATION_IMAGE: ImageSlot = { width: 160, sizes: "98px", maxWidth: 320 };
const cartRecommendationCache = new Map<string, ProductRecommendations | null>();

/**
 * Fetched once per cart contents, 400ms after the drawer opens with these
 * products in it. Products already in the cart are never suggested.
 */
function useCartRecommendations(productIds: readonly string[]) {
  const key = recommendationQuery([...productIds], CART_RECOMMENDATION_LIMIT);
  const [result, setResult] = useState<ProductRecommendations | null>(null);
  useEffect(() => {
    if (productIds.length === 0) return;
    if (cartRecommendationCache.has(key)) {
      setResult(cartRecommendationCache.get(key) ?? null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchRecommendationsFromBrowser([...productIds], CART_RECOMMENDATION_LIMIT, controller.signal)
        .then((recommendations) => {
          if (controller.signal.aborted) return;
          cartRecommendationCache.set(key, recommendations);
          setResult(recommendations);
        });
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // `key` encodes the product ids.
  }, [key]);
  if (!result || productIds.length === 0) return null;
  const inCart = new Set(productIds);
  const products = result.products.filter((product) => !inCart.has(product.id));
  return products.length > 0 ? { reason: result.reason, products } : null;
}

export default function DrawerRecommendations({ productIds }: { productIds: readonly string[] }) {
  const recommendations = useCartRecommendations(productIds);
  if (!recommendations) return null;
  const priceCopy = storefrontPriceCopy(pageLanguage());
  return (
    <section aria-labelledby="cart-recommendations-title" className="pt-2" data-part="drawer-recommendations">
      <h3 id="cart-recommendations-title" className="mb-2 text-xs font-bold text-foreground sm:text-sm">
        {recommendationTitle(recommendations.reason)}
      </h3>
      {/* Padding inside the scroller gives the focus outline room: overflow clips it. */}
      <ul data-h-rail className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1">
        {recommendations.products.map((product) => {
          const { src, srcset, sizes } = productImageSources(product.imageUrl, CART_RECOMMENDATION_IMAGE);
          return (
            <li key={product.id} className="w-28 shrink-0">
              <a
                href={pagePath(`/products/${encodeURIComponent(product.slug)}`)}
                className="flex h-full flex-col rounded-lg border border-border bg-card p-1.5 transition-colors hover:border-foreground/30"
              >
                <img
                  src={src}
                  srcSet={srcset}
                  sizes={sizes}
                  alt={product.imageAlt || product.name}
                  width={100}
                  height={100}
                  loading="lazy"
                  decoding="async"
                  className="aspect-square w-full rounded-md bg-muted object-cover"
                />
                <span className="mt-1 line-clamp-2 text-xs font-medium leading-tight text-foreground">
                  {product.name}
                </span>
                <span className="mt-auto pt-0.5 text-xs font-semibold tabular-nums text-foreground">
                  {product.priceVaries
                    ? priceCopy.from(formatMoney(product.discountedPrice))
                    : formatMoney(product.discountedPrice)}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
