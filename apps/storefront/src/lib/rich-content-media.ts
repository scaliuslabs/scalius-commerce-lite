// Images in merchant rich text, presented while the sanitizer writes them
// (renderRichHtml): our media serves pre-generated renditions, and every image
// loads lazily and off the main thread unless it is the page's first.
import { mediaImageSrcSet, mediaImageUrl } from "./media-url";

const SKIPPED_SRC_RE = /^(?:data:|blob:|javascript:|vbscript:|#)/i;
/** What presentation decides about an image; the merchant's own value is left out. */
const MANAGED_IMAGE_ATTRIBUTES = ["src", "srcset", "sizes", "loading", "decoding", "fetchpriority"];

/** A source that is no image file to optimize: none, a data or blob URI, a script URL or a fragment. */
export function shouldSkipImage(src: string): boolean {
  const clean = src.trim();
  return !clean || SKIPPED_SRC_RE.test(clean);
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
      const optimized = mediaImageUrl(src, getSrcsetCandidateWidth(descriptor));

      if (!optimized || optimized === src) return trimmed;
      return descriptor ? `${optimized} ${descriptor}` : optimized;
    })
    .filter(Boolean)
    .join(", ");
}

function getImagePlan(isPriorityImage: boolean) {
  return isPriorityImage
    ? { srcWidth: 960, sizes: "100vw", loading: "eager", fetchpriority: "high" }
    : {
        srcWidth: 640,
        sizes: "(max-width: 640px) 100vw, (max-width: 1024px) 75vw, 900px",
        loading: "lazy",
        fetchpriority: null,
      };
}

function positiveSize(value: string | null): string | null {
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const size = Number(value);
  return size > 0 && size <= 10_000 ? value : null;
}

/**
 * `width`/`height` for an external image whose URL states both, as image
 * CDNs do (`?w=1200&h=800`, `?width=…&height=…`). Nothing when either is
 * unknown: a guessed ratio would be worse than none.
 */
function knownDimensions(src: string): [string, string] | null {
  try {
    const params = new URL(src).searchParams;
    const width = positiveSize(params.get("w") ?? params.get("width"));
    const height = positiveSize(params.get("h") ?? params.get("height"));
    return width && height ? [width, height] : null;
  } catch {
    return null;
  }
}

/**
 * Presents an image of rich text: our media at a rendition with a srcset,
 * any other image as authored, and every one lazy and decoded off the main
 * thread (the first of priority content eager and high priority). The
 * merchant's width/height stay (they reserve the box); a source without them
 * gets its known intrinsic size. Returns false for an image without a source
 * it can load (a data URI, none), which is left as it is and not counted.
 */
export function presentRichContentImage(attributes: Map<string, string>, priority: boolean): boolean {
  const originalSrc = attributes.get("src") ?? "";
  if (shouldSkipImage(originalSrc)) return false;
  const plan = getImagePlan(priority);
  const srcset = mediaImageSrcSet(originalSrc);
  for (const name of MANAGED_IMAGE_ATTRIBUTES) attributes.delete(name);
  if (!srcset) {
    // No renditions (an external image, or an original of ours): the same file.
    attributes.set("src", originalSrc);
    const dimensions = attributes.has("width") || attributes.has("height") ? null : knownDimensions(originalSrc);
    if (dimensions) {
      attributes.set("width", dimensions[0]);
      attributes.set("height", dimensions[1]);
    }
  } else {
    attributes.set("src", mediaImageUrl(originalSrc, plan.srcWidth));
    attributes.set("srcset", srcset);
    attributes.set("sizes", plan.sizes);
  }
  attributes.set("loading", plan.loading);
  attributes.set("decoding", "async");
  if (plan.fetchpriority) attributes.set("fetchpriority", plan.fetchpriority);
  return true;
}

/** Presents a `<source>` of rich text: our media at its renditions. */
export function presentRichContentSource(attributes: Map<string, string>): void {
  const srcset = attributes.get("srcset");
  if (srcset) attributes.set("srcset", optimizeSrcsetValue(srcset));
  const src = attributes.get("src");
  if (src && !shouldSkipImage(src)) {
    const optimized = mediaImageUrl(src, 1200);
    if (optimized) attributes.set("src", optimized);
  }
}
