/**
 * Pre-generated WebP renditions of uploaded images.
 *
 * Renditions live beside the untouched original object:
 *   media/<id>.<ext>             original upload (downloads, saved references)
 *   media/<id>.<ext>/<w>.webp    one rendition per width in mediaVariantWidths()
 *
 * The API publishes the largest rendition as the media URL. Because the width
 * ladder is fixed, that URL alone tells every consumer (storefront, admin,
 * feeds, rich content) which smaller renditions exist, so no transform service
 * and no extra metadata round-trip are needed. Any other URL is served as-is.
 */

/**
 * 480 sits between the usual 320/640 steps so two-column phone grids and the
 * mobile product image (~160–270 CSS px at DPR 2–3) do not jump to 640.
 */
export const MEDIA_VARIANT_WIDTHS = [160, 320, 480, 640, 960, 1600] as const;
/** The largest (master) rendition; wider sources are scaled down to it. */
export const MEDIA_VARIANT_MAX_WIDTH = 2400;
/** Social, JSON-LD and catalog feed images: Google/Meta want ≥ 1200 px. */
export const MEDIA_DISCOVERY_IMAGE_WIDTH = 1200;

/** Widths to generate for a source image: ladder steps below the master, then the master. */
export function mediaVariantWidths(sourceWidth: number): number[] {
  const master = Math.min(Math.floor(sourceWidth), MEDIA_VARIANT_MAX_WIDTH);
  if (!Number.isSafeInteger(master) || master < 1) return [];
  return [...MEDIA_VARIANT_WIDTHS.filter((width) => width < master), master];
}

/** WebP quality per rendition: smaller steps are usually shown at DPR 2–3. */
export function mediaVariantQuality(width: number): number {
  return width <= 960 ? 0.75 : 0.82;
}

export function mediaVariantObjectKey(objectKey: string, width: number): string {
  return `${objectKey}/${width}.webp`;
}

const VARIANT_PATH = /^(.*\.[A-Za-z0-9]{1,10})\/([1-9]\d{0,3})\.webp$/;

interface ParsedVariantUrl {
  base: string;
  suffix: string;
  widths: number[];
}

function parseVariantUrl(url: string): ParsedVariantUrl | null {
  const suffixIndex = url.search(/[?#]/);
  const path = suffixIndex < 0 ? url : url.slice(0, suffixIndex);
  const match = VARIANT_PATH.exec(path);
  if (!match || !/(?:^|\/)media\//.test(match[1]!)) return null;
  const master = Number(match[2]);
  if (master > MEDIA_VARIANT_MAX_WIDTH) return null;
  return {
    base: match[1]!,
    suffix: suffixIndex < 0 ? "" : url.slice(suffixIndex),
    widths: mediaVariantWidths(master),
  };
}

function variantAt(parsed: ParsedVariantUrl, width: number): string {
  return `${parsed.base}/${width}.webp${parsed.suffix}`;
}

/**
 * The smallest rendition at least `width` pixels wide (or the master when
 * none is). URLs without renditions are returned unchanged.
 */
export function mediaImageUrl(url: string | null | undefined, width: number): string {
  if (!url) return "";
  const parsed = parseVariantUrl(url);
  if (!parsed) return url;
  const chosen = parsed.widths.find((candidate) => candidate >= width)
    ?? parsed.widths.at(-1)!;
  return variantAt(parsed, chosen);
}

/** `srcset` for every rendition, or "" when the URL has none. */
export function mediaImageSrcSet(url: string | null | undefined): string {
  const parsed = url ? parseVariantUrl(url) : null;
  if (!parsed) return "";
  return parsed.widths
    .map((width) => `${variantAt(parsed, width)} ${width}w`)
    .join(", ");
}

/** The untouched upload behind a rendition URL (downloads, editing). */
export function mediaOriginalUrl(url: string | null | undefined): string {
  const parsed = url ? parseVariantUrl(url) : null;
  return parsed ? `${parsed.base}${parsed.suffix}` : url ?? "";
}

const MEDIA_ORIGINAL_PATH = /(?:^|\/)media\/[^/?#]+\.([A-Za-z0-9]{1,10})$/;
/** Vector files scale without renditions: never an "original" to avoid. */
const VECTOR_EXTENSIONS = new Set(["svg"]);

/**
 * A raster upload of our own media store served as uploaded (a legacy or
 * failed-rendition image, up to 2400px and ~1MB): `media/<id>.<ext>` with
 * no rendition suffix. Small slots (cards) show their placeholder instead
 * while the public read queues its render job. External URLs and SVGs are
 * not ours to resize and return false.
 */
export function isUnrenderedMediaOriginal(url: string | null | undefined): boolean {
  if (!url || parseVariantUrl(url)) return false;
  const suffixIndex = url.search(/[?#]/);
  const path = suffixIndex < 0 ? url : url.slice(0, suffixIndex);
  const match = MEDIA_ORIGINAL_PATH.exec(path);
  return Boolean(match && !VECTOR_EXTENSIONS.has(match[1]!.toLowerCase()));
}
