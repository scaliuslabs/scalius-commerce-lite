import { escapeHtml } from "@scalius/shared/html-escape";
import { getOptimizedImageUrl } from "./image-optimizer";

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
const SOURCE_TAG_RE = /<source\b([^>]*)>/gi;
const SRC_ATTR_RE = /\s+src\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const SRCSET_ATTR_RE =
  /\s+srcset\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const MANAGED_ATTR_RE =
  /\s+(?:src|srcset|sizes|loading|decoding)\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+)/gi;
const VOID_ATTR_RE = /\s+(?:loading|decoding)(?=\s|>|$)/gi;
const CSS_URL_RE =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*?))\s*\)/gi;
const SKIPPED_SRC_RE = /^(?:data:|blob:|javascript:|vbscript:|#)/i;
const SKIPPED_CSS_ASSET_RE =
  /\.(?:css|js|json|svg|woff2?|ttf|otf|eot)(?:[?#].*)?$/i;

function readAttributeValue(match: RegExpMatchArray): string {
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function shouldSkipImage(src: string): boolean {
  const clean = src.trim();
  if (!clean || SKIPPED_SRC_RE.test(clean)) return true;
  return clean.split("?")[0]?.toLowerCase().endsWith(".svg") ?? false;
}

function shouldSkipCssAsset(src: string): boolean {
  const clean = src.trim();
  return !clean || SKIPPED_SRC_RE.test(clean) || SKIPPED_CSS_ASSET_RE.test(clean);
}

function escapeCssUrl(url: string): string {
  return url.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\f]/g, "");
}

function responsiveVariant(src: string, width: number): string {
  return getOptimizedImageUrl(src, {
    width,
    quality: width <= 400 ? 80 : 85,
    format: "auto",
    fit: "scale-down",
  });
}

function getSrcsetCandidateWidth(descriptor: string): number {
  const width = descriptor
    .split(/\s+/)
    .map((part) => part.match(/^(\d+)w$/i)?.[1])
    .find(Boolean);
  return width ? Number(width) : 1200;
}

function optimizeSrcsetValue(srcset: string): string {
  return srcset
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return "";

      const [src, ...descriptors] = trimmed.split(/\s+/);
      if (!src || shouldSkipImage(src)) return trimmed;

      const descriptor = descriptors.join(" ");
      const optimized = responsiveVariant(
        src,
        getSrcsetCandidateWidth(descriptor),
      );

      if (!optimized || optimized === src) return trimmed;
      return descriptor ? `${optimized} ${descriptor}` : optimized;
    })
    .filter(Boolean)
    .join(", ");
}

function optimizeSourceTags(html: string): string {
  return html.replace(SOURCE_TAG_RE, (tag, attrs: string) => {
    const srcsetMatch = attrs.match(SRCSET_ATTR_RE);
    const srcMatch = attrs.match(SRC_ATTR_RE);

    if (!srcsetMatch && !srcMatch) return tag;

    let nextAttrs = attrs;

    if (srcsetMatch) {
      const originalSrcset = readAttributeValue(srcsetMatch);
      const optimizedSrcset = optimizeSrcsetValue(originalSrcset);
      if (optimizedSrcset !== originalSrcset) {
        nextAttrs = nextAttrs.replace(
          SRCSET_ATTR_RE,
          ` srcset="${escapeHtml(optimizedSrcset)}"`,
        );
      }
    }

    if (srcMatch) {
      const originalSrc = readAttributeValue(srcMatch);
      if (!shouldSkipImage(originalSrc)) {
        const optimizedSrc = responsiveVariant(originalSrc, 1200);
        if (optimizedSrc && optimizedSrc !== originalSrc) {
          nextAttrs = nextAttrs.replace(
            SRC_ATTR_RE,
            ` src="${escapeHtml(optimizedSrc)}"`,
          );
        }
      }
    }

    return `<source${nextAttrs}>`;
  });
}

/**
 * Applies the storefront image optimizer to images inside admin-authored rich
 * HTML. Attribute parsing is deliberately narrow: it only manages image loading
 * attributes and preserves the rest of the original tag untouched.
 */
export function optimizeRichContentImages(html: string): string {
  if (!html) return "";

  const optimizedHtml = html.replace(IMG_TAG_RE, (tag, attrs: string) => {
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

  return optimizeCssImageUrls(optimizeSourceTags(optimizedHtml));
}

/**
 * Applies the storefront image optimizer to CSS image references. This covers
 * widget CSS, inline background images, and `<style>` blocks inside rich HTML.
 */
export function optimizeCssImageUrls(css: string): string {
  if (!css) return "";

  return css.replace(CSS_URL_RE, (match, doubleQuoted, singleQuoted, bare) => {
    const originalSrc = (doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
    if (shouldSkipCssAsset(originalSrc)) return match;

    const optimized = getOptimizedImageUrl(originalSrc, {
      width: 1600,
      quality: 85,
      format: "auto",
      fit: "cover",
    });

    if (!optimized || optimized === originalSrc) return match;
    return `url("${escapeCssUrl(optimized)}")`;
  });
}
