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

export function capImageSrcSet(srcset: string | undefined, maxWidth: number): string | undefined {
  if (!srcset) return srcset;
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
  const srcset = slot.maxWidth ? capImageSrcSet(all, slot.maxWidth) : all;
  return { src, srcset, sizes: slot.sizes };
}

/**
 * A card's hover photo from its CDN URL: the 480px rendition as `src` and
 * every rendition up to the card's cap (`maxWidth`, the photo's own) as
 * `srcset`; plain `src` for images without renditions. The card names only
 * the URL, and its intent script builds these, so the HTML never carries a
 * second rendition list per card.
 */
export function hoverImageSources(url: string, maxWidth?: number): { src: string; srcset?: string } {
  const all = mediaImageSrcSet(url) || undefined;
  return { src: mediaImageUrl(url, 480), srcset: maxWidth ? capImageSrcSet(all, maxWidth) : all };
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

/** Multiply a simple slot length directly, avoiding a nested calc in every card. */
function scaledLength(length: string, factor: number): string {
  const number = (value: number) => String(Number(value.toFixed(10)));
  const linear = /^calc\(([\d.]+)vw - ([\d.]+)(px|rem)\)$/.exec(length);
  if (linear) return `calc(${number(Number(linear[1]) * factor)}vw - ${number(Number(linear[2]) * factor)}${linear[3]})`;
  const simple = /^([\d.]+)(px|vw|rem)$/.exec(length);
  if (simple) return `${number(Number(simple[1]) * factor)}${simple[2]}`;
  const inner = /^calc\((.*)\)$/.exec(length)?.[1] ?? length;
  return `calc((${inner}) * ${factor})`;
}

/**
 * `sizes` scaled by `factor`, conditions kept. A card photo drawn inside a
 * padded box (a contained photo with a margin) is narrower than the slot
 * the grid gives it; scaling by the share it fills keeps the chosen
 * rendition at the width actually drawn.
 */
export function scaleSizes(sizes: string, factor: number): string {
  if (!(factor > 0) || factor >= 1) return sizes;
  const scale = Number(factor.toFixed(3));
  return splitTopLevel(sizes).map((entry) => {
    const { condition, length } = splitSizesEntry(entry);
    return `${condition ? `${condition} ` : ""}${scaledLength(length, scale)}`;
  }).join(", ");
}

/** A `sizes` entry the collapse below can evaluate: `(max-width: Npx)` and a px or `calc(a vw - b px)` length. */
interface SimpleSizesEntry {
  /** The entry's `(max-width: Npx)`, or null for the unconditioned last entry. */
  max: number | null;
  /** Declared px at a viewport width. */
  at: (viewport: number) => number;
}

function simpleSizesEntries(sizes: string): SimpleSizesEntry[] | null {
  const entries: SimpleSizesEntry[] = [];
  for (const entry of splitTopLevel(sizes)) {
    const { condition, length } = splitSizesEntry(entry);
    const max = condition === null ? null : /^\(max-width: (\d+)px\)$/.exec(condition)?.[1];
    if (max === undefined) return null;
    const linear = /^calc\(([\d.]+)vw - ([\d.]+)px\)$/.exec(length);
    const px = /^([\d.]+)px$/.exec(length);
    const vw = /^([\d.]+)vw$/.exec(length);
    const at = linear
      ? (viewport: number) => (Number(linear[1]) * viewport) / 100 - Number(linear[2])
      : px
        ? () => Number(px[1])
        : vw
          ? (viewport: number) => (Number(vw[1]) * viewport) / 100
          : null;
    if (!at) return null;
    entries.push({ max: max === null ? null : Number(max), at });
  }
  return entries.length > 0 && entries.at(-1)!.max === null ? entries : null;
}

/** Screen densities a collapsed range is checked at (DPR 2.5+ above phones: full density). */
const COLLAPSE_DENSITIES = [1, 1.25, 1.5, 2, 2.5, 3] as const;
/** The widest viewport a collapse is checked to; past the container cap the last entry is a constant. */
const COLLAPSE_VIEWPORT_LIMIT = 2560;
const collapseCache = new Map<string, string>();

/**
 * Card `sizes` with its desktop steps (from `fromViewportPx`) merged: each
 * merged range declares the widest card it covers, as one px length, as
 * long as no viewport of it at any density fetches more than one rendition
 * step (`ladder`, ascending widths) above what its own step would. A card
 * grid changes columns every ~200px of a wide container, so the steps of a
 * 2560px container otherwise cost a dozen entries on every card. Entries
 * below `fromViewportPx` (phones and tablets) stay exact, and nothing is
 * ever declared narrower than drawn. `sizes` the merge cannot evaluate are
 * returned unchanged.
 */
export function collapseWideSizes(sizes: string, ladder: readonly number[], fromViewportPx = 1024): string {
  const key = `${fromViewportPx}|${ladder.join(",")}|${sizes}`;
  const cached = collapseCache.get(key);
  if (cached !== undefined) return cached;
  const entries = simpleSizesEntries(sizes);
  const first = entries?.findIndex((_entry, index) => index > 0 && entries[index - 1]!.max! >= fromViewportPx - 1) ?? -1;
  if (!entries || first < 0 || entries.length - first < 2) {
    collapseCache.set(key, sizes);
    return sizes;
  }
  const step = (width: number) => {
    const index = ladder.findIndex((candidate) => candidate >= width);
    return index < 0 ? ladder.length - 1 : index;
  };
  // Each entry's viewport range from `fromViewportPx` on.
  const ranges = entries.map((entry, index) => ({
    entry,
    from: index === 0 ? 0 : entries[index - 1]!.max! + 1,
    to: entry.max ?? Math.max(COLLAPSE_VIEWPORT_LIMIT, (entries[index - 1]?.max ?? 0) + 1),
  })).slice(first);
  const widest = (group: typeof ranges) =>
    Math.ceil(Math.max(...group.flatMap(({ entry, from, to }) => [entry.at(from), entry.at(to)])) - 1e-9);
  const fits = (group: typeof ranges, width: number) => group.every(({ entry, from, to }) => {
    for (let viewport = from; viewport <= to; viewport += 1) {
      const own = entry.at(viewport);
      for (const density of COLLAPSE_DENSITIES) {
        if (step(width * density) - step(own * density) > 1) return false;
      }
    }
    return true;
  });
  const source = splitTopLevel(sizes);
  const out = source.slice(0, first);
  let start = 0;
  while (start < ranges.length) {
    let end = start;
    while (end + 1 < ranges.length && fits(ranges.slice(start, end + 2), widest(ranges.slice(start, end + 2)))) end += 1;
    const group = ranges.slice(start, end + 1);
    const width = widest(group);
    const last = group.at(-1)!.entry.max;
    // A lone range that a constant cannot cover within a step keeps its own entry.
    if (group.length === 1 && !fits(group, width)) out.push(source[first + start]!);
    else out.push(last === null ? `${width}px` : `(max-width: ${last}px) ${width}px`);
    start = end + 1;
  }
  const collapsed = out.join(", ");
  collapseCache.set(key, collapsed);
  return collapsed;
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
    const media = condition ? `${DENSITY_CAP_MEDIA} and ${condition}` : DENSITY_CAP_MEDIA;
    return `${media} ${scaledLength(length, Number(DENSITY_CAP_SCALE))}`;
  });
  return [...capped, ...entries].join(", ");
}

/** The widest viewport the card photos' density cap covers: phones (below Tailwind's `sm`). */
export const PHONE_DENSITY_CAP_MAX_VIEWPORT_PX = 639;
/** From here up (tablets and computers) card `sizes` steps may merge (collapseWideSizes). */
export const CARD_SIZES_COLLAPSE_FROM_PX = 640;

/**
 * `capSizesDensity` for phones only, for the photos repeated on every card:
 * the capped copies stop at `maxViewportPx`, so a listing does not repeat
 * every desktop step twice on every card. DPR 2.5+ screens wider than that
 * (rare: some tablets and foldables) choose at their full density, still
 * bounded by the card's capped `srcset`. `sizes` whose conditions are not
 * plain `(max-width: Npx)` steps get the full cap.
 */
export function capPhoneSizesDensity(sizes: string, maxViewportPx = PHONE_DENSITY_CAP_MAX_VIEWPORT_PX): string {
  const entries = splitTopLevel(sizes);
  const capped: string[] = [];
  let covered = 0;
  for (const entry of entries) {
    if (covered >= maxViewportPx) break;
    const { condition, length } = splitSizesEntry(entry);
    const max = condition === null ? null : /^\(max-width: (\d+)px\)$/.exec(condition)?.[1];
    if (max === undefined) return capSizesDensity(sizes);
    const until = max === null ? maxViewportPx : Math.min(Number(max), maxViewportPx);
    capped.push(`${DENSITY_CAP_MEDIA} and (max-width: ${until}px) ${scaledLength(length, Number(DENSITY_CAP_SCALE))}`);
    covered = until;
  }
  return [...capped, ...entries].join(", ");
}
