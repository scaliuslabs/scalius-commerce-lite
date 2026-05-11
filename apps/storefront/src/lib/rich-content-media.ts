import { escapeHtml } from "@scalius/shared/html-escape";
import { getOptimizedImageUrl } from "./image-optimizer";

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
const SRC_ATTR_RE = /\s+src\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const MANAGED_ATTR_RE =
  /\s+(?:src|srcset|sizes|loading|decoding)\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+)/gi;
const VOID_ATTR_RE = /\s+(?:loading|decoding)(?=\s|>|$)/gi;
const SKIPPED_SRC_RE = /^(?:data:|blob:|javascript:|vbscript:|#)/i;

function readAttributeValue(match: RegExpMatchArray): string {
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function shouldSkipImage(src: string): boolean {
  const clean = src.trim();
  if (!clean || SKIPPED_SRC_RE.test(clean)) return true;
  return clean.split("?")[0]?.toLowerCase().endsWith(".svg") ?? false;
}

function responsiveVariant(src: string, width: number): string {
  return getOptimizedImageUrl(src, {
    width,
    quality: width <= 400 ? 80 : 85,
    format: "auto",
    fit: "scale-down",
  });
}

/**
 * Applies the storefront image optimizer to images inside admin-authored rich
 * HTML. Attribute parsing is deliberately narrow: it only manages image loading
 * attributes and preserves the rest of the original tag untouched.
 */
export function optimizeRichContentImages(html: string): string {
  if (!html) return "";

  return html.replace(IMG_TAG_RE, (tag, attrs: string) => {
    const srcMatch = attrs.match(SRC_ATTR_RE);
    if (!srcMatch) return tag;

    const originalSrc = readAttributeValue(srcMatch);
    if (shouldSkipImage(originalSrc)) return tag;

    const src = responsiveVariant(originalSrc, 600);
    const widths = [320, 480, 600, 900];
    const variants = widths.map((width) => ({
      width,
      url: responsiveVariant(originalSrc, width),
    }));

    if (
      src === originalSrc &&
      variants.every((variant) => variant.url === originalSrc)
    ) {
      return tag;
    }

    const srcset = variants
      .map((variant) => `${variant.url} ${variant.width}w`)
      .join(", ");

    const managed = attrs
      .replace(MANAGED_ATTR_RE, "")
      .replace(VOID_ATTR_RE, "")
      .trim();
    const managedPrefix = managed ? ` ${managed}` : "";

    return `<img${managedPrefix} src="${escapeHtml(src)}" srcset="${escapeHtml(srcset)}" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 75vw, 900px" loading="lazy" decoding="async">`;
  });
}
