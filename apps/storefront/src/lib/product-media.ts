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

/**
 * Keep storefront image transforms on the shopper's existing HTTP connection.
 * Cloudflare's Image Resizing endpoint accepts an absolute source URL, so an
 * optimizer URL such as `https://cdn.example/cdn-cgi/image/x/media/a.webp`
 * can be served as `/cdn-cgi/image/x/https://cdn.example/media/a.webp`.
 */
export function rebaseProductImageTransform(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    const marker = "/cdn-cgi/image/";
    if (!parsed.pathname.startsWith(marker)) return url;
    const transformAndPath = parsed.pathname.slice(marker.length);
    const pathSeparator = transformAndPath.indexOf("/");
    if (pathSeparator <= 0) return url;
    const transform = transformAndPath.slice(0, pathSeparator);
    const sourcePath = transformAndPath.slice(pathSeparator);
    const sourceUrl = `${parsed.origin}${sourcePath}${parsed.search}`;
    return `${marker}${transform}/${sourceUrl}`;
  } catch {
    return url;
  }
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
  const optimized = getOptimizedImageUrl(source, options) || fallback;
  return rebaseProductImageTransform(optimized);
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
