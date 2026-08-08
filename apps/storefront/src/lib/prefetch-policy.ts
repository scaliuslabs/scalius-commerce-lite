import { hasStorefrontProductVariantSelectionParams } from "@scalius/shared/storefront-cache-path";
import { transformHtmlAnchorAttributes } from "@scalius/shared/html-anchor-transform";
import { isPrivateStorefrontPathname } from "./cache-policy";

const STOREFRONT_URL_BASE = "https://storefront-prefetch.invalid";

/**
 * Astro prefetches every internal link by default. Private commerce routes and
 * product option URLs deliberately bypass the public HTML cache, so fetching
 * them before an intentional navigation only creates private SSR/API work.
 */
export function getStorefrontPrefetchAttribute(
  href: string | URL | null | undefined,
  pageBase?: string | URL,
): "false" | undefined {
  if (!href) return undefined;

  const rawHref = href instanceof URL ? href.href : href.trim();
  if (!rawHref) return undefined;
  if (!pageBase && rawHref.startsWith("?")) return "false";

  let baseUrl: URL;
  let url: URL;
  try {
    baseUrl = pageBase instanceof URL
      ? pageBase
      : new URL(pageBase ?? STOREFRONT_URL_BASE, STOREFRONT_URL_BASE);
    url = href instanceof URL ? href : new URL(rawHref, baseUrl);
  } catch {
    return undefined;
  }

  if (pageBase && url.origin !== baseUrl.origin) return undefined;

  return isPrivateStorefrontPathname(url.pathname) ||
    hasStorefrontProductVariantSelectionParams(url)
    ? "false"
    : undefined;
}

/**
 * Applies the same policy to sanitized merchant-authored HTML. Static Astro
 * attributes cannot cover links embedded in CMS page, blog, or footer copy.
 */
export function applyStorefrontPrefetchPolicyToHtml(
  html: string,
  pageBase?: string | URL,
): string {
  return transformHtmlAnchorAttributes(html, (attributes) => {
    if (!getStorefrontPrefetchAttribute(attributes.href, pageBase)) {
      return undefined;
    }
    return { ...attributes, "data-astro-prefetch": "false" };
  });
}
