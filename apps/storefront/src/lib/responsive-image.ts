/**
 * `src` / `srcset` / `sizes` for one image slot, from an already resolved
 * media URL. Pure (no runtime CDN lookup), so SSR markup and client scripts
 * that swap images build identical attributes.
 */
import { mediaImageSrcSet, mediaImageUrl } from "@scalius/shared/media-variants";

export interface ImageSlot {
  /** Rendition for `src` (the fallback when `srcset` is not used). */
  width: number;
  /** The slot's rendered CSS width at each breakpoint. */
  sizes: string;
  /**
   * The largest width the slot can ever need (its biggest CSS width at the
   * highest DPR). Bigger renditions are left out of `srcset`, which keeps
   * repeated small slots (thumbnails) light in the HTML.
   */
  maxWidth?: number;
}

export interface ResponsiveImageSources {
  src: string;
  /** Only present when the image has pre-generated renditions. */
  srcset?: string;
  sizes?: string;
}

function capCandidates(srcset: string, maxWidth: number): string {
  // Media URLs never contain ", " (spaces are not valid in a URL), and the
  // shared helper lists candidates by ascending width.
  const kept: string[] = [];
  for (const candidate of srcset.split(", ")) {
    kept.push(candidate);
    const width = Number(/ (\d+)w$/.exec(candidate)?.[1]);
    if (width >= maxWidth) break;
  }
  return kept.join(", ");
}

/**
 * Sources for `url` in `slot`. URLs without renditions (legacy uploads, SVG,
 * external images) get a plain `src` and no `srcset`/`sizes`.
 */
export function responsiveImageSources(
  url: string,
  slot: ImageSlot,
): ResponsiveImageSources {
  const src = mediaImageUrl(url, slot.width);
  const all = mediaImageSrcSet(url);
  if (!src || !all) return { src };
  const srcset = slot.maxWidth ? capCandidates(all, slot.maxWidth) : all;
  return { src, srcset, sizes: slot.sizes };
}
