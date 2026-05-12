import {
  getOptimizedImageUrl,
  type ImageOptimizationOptions,
} from "./image-optimizer";

export const PRODUCT_IMAGE_FALLBACK = "/placeholder-product.svg";

type ProductImageVariant = ImageOptimizationOptions & {
  descriptor: string;
};

function normalizeImageSource(url: string | null | undefined): string {
  return typeof url === "string" ? url.trim() : "";
}

function isSvgImage(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  return path.endsWith(".svg");
}

export function hasProductImage(url: string | null | undefined): boolean {
  return normalizeImageSource(url) !== "";
}

export function getProductImageUrl(
  url: string | null | undefined,
  options: ImageOptimizationOptions = {},
  fallback = PRODUCT_IMAGE_FALLBACK,
): string {
  const source = normalizeImageSource(url) || fallback;
  if (isSvgImage(source)) return source;
  return getOptimizedImageUrl(source, options) || fallback;
}

export function getProductImageSrcSet(
  url: string | null | undefined,
  variants: ProductImageVariant[],
): string {
  const source = normalizeImageSource(url);
  if (!source || isSvgImage(source)) return "";

  return variants
    .map((variant) => {
      const { descriptor, ...options } = variant;
      const optimized = getProductImageUrl(source, options);
      return optimized ? `${optimized} ${descriptor}` : "";
    })
    .filter(Boolean)
    .join(", ");
}
