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

/** Screens at or above this density are asked for about 2x, not 3x, pixels. */
const DENSITY_CAP_MEDIA = "(min-resolution: 2.5dppx)";
/** 3 x 0.666 = 1.998: just under 2x, so a slot never rounds past a ladder step. */
export const DENSITY_CAP_SCALE = "0.666";

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

/** Splits one `sizes` entry into its media condition (if any) and length. */
function splitSizesEntry(entry: string): { condition: string | null; length: string } {
  let lengthStart: number;
  if (entry.endsWith(")")) {
    // A math function: walk back to the `(` that opens it, then its name.
    let depth = 0;
    let open = entry.length - 1;
    for (; open >= 0; open -= 1) {
      if (entry[open] === ")") depth += 1;
      else if (entry[open] === "(" && --depth === 0) break;
    }
    lengthStart = open;
    while (lengthStart > 0 && /[a-z-]/i.test(entry[lengthStart - 1]!)) lengthStart -= 1;
  } else {
    lengthStart = entry.lastIndexOf(" ") + 1;
  }
  const condition = entry.slice(0, lengthStart).trim();
  return { condition: condition || null, length: entry.slice(lengthStart) };
}

/**
 * `sizes` scaled by `factor`: every entry's length becomes
 * `calc((length) * factor)`, conditions kept. A card photo drawn inside a
 * padded box (a contained photo with a margin) is narrower than the slot
 * the grid gives it; scaling by the share it fills keeps the chosen
 * rendition at the width actually drawn.
 */
export function scaleSizes(sizes: string, factor: number): string {
  if (!(factor > 0) || factor >= 1) return sizes;
  const scale = Number(factor.toFixed(3));
  return splitTopLevel(sizes).map((entry) => {
    const { condition, length } = splitSizesEntry(entry);
    const inner = /^calc\((.*)\)$/.exec(length)?.[1] ?? length;
    return `${condition ? `${condition} ` : ""}calc((${inner}) * ${scale})`;
  }).join(", ");
}

/**
 * `sizes` that ask a DPR 3 phone for about 2x pixels. A 390px phone at DPR 3
 * would otherwise pick a ~1100px file (the 1600w rendition) for a 366px LCP
 * photo: the extra density is barely visible, but it costs 2-3x the bytes on
 * the slowest connections. Each entry is repeated first under a
 * `(min-resolution: 2.5dppx)` condition with its width scaled by 2/3, so
 * screens of DPR 2.5 and above choose as if their DPR were about 2. Other
 * screens, and browsers without the media feature, keep the original
 * entries. Only for the large LCP images; small slots keep full density.
 */
export function capSizesDensity(sizes: string): string {
  const entries = splitTopLevel(sizes);
  const capped = entries.map((entry) => {
    const { condition, length } = splitSizesEntry(entry);
    const inner = /^calc\((.*)\)$/.exec(length)?.[1] ?? length;
    const media = condition ? `${DENSITY_CAP_MEDIA} and ${condition}` : DENSITY_CAP_MEDIA;
    return `${media} calc((${inner}) * ${DENSITY_CAP_SCALE})`;
  });
  return [...capped, ...entries].join(", ");
}
