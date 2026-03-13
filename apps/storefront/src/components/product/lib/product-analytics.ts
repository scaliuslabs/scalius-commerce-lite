// src/components/product/lib/product-analytics.ts
/**
 * Product Analytics Coordinator
 */

import { trackFbAddToCart } from "@/lib/analytics";
import type { Variant } from "./variant-state-machine";

export interface ProductAnalyticsData {
  id: string;
  name: string;
  price: number;
  category?: string;
}

export interface VariantAnalyticsData {
  id: string;
  size?: string;
  color?: string;
  price: number;
}

export interface AddToCartAnalyticsData {
  product: ProductAnalyticsData;
  variant: VariantAnalyticsData | null;
  quantity: number;
}

/**
 * Track "Add to Cart" event
 * Sends data to Facebook Pixel and Google Analytics
 */
export function trackProductAddToCart(data: AddToCartAnalyticsData): void {
  // Determine which ID to use (variant or product)
  const contentId = data.variant?.id || data.product.id;

  // Build FB Pixel tracking data
  const fbPixelData = {
    content_ids: [contentId],
    content_name: data.product.name,
    content_type: "product" as const,
    contents: [
      {
        id: contentId,
        quantity: data.quantity,
        item_price: data.variant?.price || data.product.price,
      },
    ],
    currency: typeof window !== "undefined" && (window as any).__CURRENCY_CODE__ ? (window as any).__CURRENCY_CODE__ : "BDT",
    value: (data.variant?.price || data.product.price) * data.quantity,
  };

  // Track with Facebook Pixel (also sends to Meta CAPI)
  try {
    trackFbAddToCart(fbPixelData);
  } catch (error) {
    console.error("Failed to track add to cart:", error);
  }

  // Dispatch cart update event for UI components
  dispatchCartUpdateEvent();
}

/**
 * Dispatch cart update event
 */
function dispatchCartUpdateEvent(): void {
  if (typeof document === "undefined") return;

  try {
    document.dispatchEvent(new CustomEvent("cart-updated"));
  } catch (error) {
    console.error("Failed to dispatch cart-updated event:", error);
  }
}

/**
 * Extract product analytics data from DOM
 */
export function extractProductDataFromDOM(
  container: HTMLElement,
): ProductAnalyticsData | null {
  const id = container.dataset.productId;
  const name = container.dataset.productName;
  const priceStr = container.dataset.productPrice;

  if (!id || !name || !priceStr) {
    console.error("Missing required product data in container");
    return null;
  }

  const price = parseInt(priceStr, 10);

  if (isNaN(price)) {
    console.error("Invalid product price");
    return null;
  }

  return {
    id,
    name,
    price,
  };
}

/**
 * Convert variant state machine data to analytics data
 */
export function convertVariantToAnalyticsData(
  variant: Variant | null,
): VariantAnalyticsData | null {
  if (!variant) return null;

  return {
    id: variant.id,
    size: variant.size || undefined,
    color: variant.color || undefined,
    price: variant.discountedPrice,
  };
}

/**
 * Check if Facebook Pixel is loaded
 */
export function isFacebookPixelLoaded(): boolean {
  return typeof window !== "undefined" && typeof window.fbq === "function";
}

/**
 * Check if Google Analytics is loaded
 */
export function isGoogleAnalyticsLoaded(): boolean {
  return typeof window !== "undefined" && Array.isArray(window.dataLayer);
}

/**
 * Get current tracking readiness status
 */
export function getTrackingStatus(): {
  fbPixel: boolean;
  googleAnalytics: boolean;
  ready: boolean;
} {
  const fbPixel = isFacebookPixelLoaded();
  const googleAnalytics = isGoogleAnalyticsLoaded();

  return {
    fbPixel,
    googleAnalytics,
    ready: fbPixel || googleAnalytics,
  };
}
