import { parseNavigationHref } from "./navigation-href";
import type { ImageOptimizationOptions } from "./image-optimizer";

export const HERO_SLIDE_LIMIT = 12;
export const HERO_SLIDE_TITLE_LIMIT = 160;
export const HERO_SLIDE_URL_LIMIT = 2_048;
export const HERO_SLIDE_PRESENTATION = {
  desktop: { width: 1_300, height: 500 },
  mobile: { width: 640, height: 300 },
} as const;

export type HeroSlideViewport = keyof typeof HERO_SLIDE_PRESENTATION;

export interface HeroSlideFocalPoint {
  /** Horizontal position as a percentage of the source image width. */
  x: number;
  /** Vertical position as a percentage of the source image height. */
  y: number;
}

export const HERO_SLIDE_DEFAULT_FOCAL_POINT: Readonly<HeroSlideFocalPoint> = {
  x: 50,
  y: 50,
};

export interface HeroSlide {
  id: string;
  url: string;
  title: string;
  link: string;
  focalPoint: HeroSlideFocalPoint;
}

export type HeroSlidesValidationResult =
  | { ok: true; slides: HeroSlide[] }
  | { ok: false; errors: string[] };

function normalizeImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > HERO_SLIDE_URL_LIMIT) return undefined;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeFocalCoordinate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return undefined;
  }
  return Number(value.toFixed(2));
}

function normalizeFocalPoint(value: unknown): HeroSlideFocalPoint | undefined {
  // Existing documents without a merchant choice intentionally keep the
  // historical center crop until they are edited.
  if (value === undefined || value === null) {
    return { ...HERO_SLIDE_DEFAULT_FOCAL_POINT };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const x = normalizeFocalCoordinate(row.x);
  const y = normalizeFocalCoordinate(row.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

/** CSS projection for non-destructive previews that crop with object-fit. */
export function getHeroSlideObjectPosition(
  focalPoint: HeroSlideFocalPoint,
): string {
  return `${focalPoint.x}% ${focalPoint.y}%`;
}

/** Cloudflare URL gravity projection for an intentional cover transform. */
export function getHeroSlideCloudflareGravity(
  focalPoint: HeroSlideFocalPoint,
): `${number}x${number}` {
  const x = Number((focalPoint.x / 100).toFixed(4));
  const y = Number((focalPoint.y / 100).toFixed(4));
  return `${x}x${y}`;
}

/**
 * Builds one aspect-ratio-safe Cloudflare transform for hero delivery and
 * previews. A smaller requested width keeps the viewport ratio while using the
 * same merchant focal point as the production banner.
 */
export function getHeroSlideImageTransform(
  viewport: HeroSlideViewport,
  focalPoint: HeroSlideFocalPoint,
  options: { width?: number; quality?: number } = {},
): ImageOptimizationOptions {
  const presentation = HERO_SLIDE_PRESENTATION[viewport];
  const width = options.width ?? presentation.width;
  const height = Math.max(
    1,
    Math.round((width * presentation.height) / presentation.width),
  );

  return {
    width,
    height,
    quality: options.quality ?? (viewport === "desktop" ? 90 : 85),
    format: "auto",
    fit: "cover",
    gravity: getHeroSlideCloudflareGravity(focalPoint),
  };
}

/**
 * Validates and canonicalizes the complete ordered hero slide document.
 * Empty destinations are stored as an empty string and render as non-links.
 */
export function validateAndNormalizeHeroSlides(
  value: unknown,
): HeroSlidesValidationResult {
  if (!Array.isArray(value)) {
    return { ok: false, errors: ["Hero slides must be an array."] };
  }
  if (value.length > HERO_SLIDE_LIMIT) {
    return {
      ok: false,
      errors: [`Use at most ${HERO_SLIDE_LIMIT} hero slides.`],
    };
  }

  const errors: string[] = [];
  const slides: HeroSlide[] = [];
  const ids = new Set<string>();

  value.forEach((entry, index) => {
    const position = index + 1;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`Slide ${position} is invalid.`);
      return;
    }

    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      errors.push(`Slide ${position} needs a stable ID.`);
    } else if (ids.has(id)) {
      errors.push(`Slide ${position} repeats another slide ID.`);
    } else {
      ids.add(id);
    }

    const url = normalizeImageUrl(row.url);
    if (!url) {
      errors.push(`Slide ${position} image must be a credential-free HTTPS URL.`);
    }

    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) {
      errors.push(`Slide ${position} needs descriptive image text.`);
    } else if (title.length > HERO_SLIDE_TITLE_LIMIT) {
      errors.push(
        `Slide ${position} image text must be ${HERO_SLIDE_TITLE_LIMIT} characters or fewer.`,
      );
    }

    const parsedLink = parseNavigationHref(row.link);
    if (!parsedLink.ok) {
      errors.push(`Slide ${position} destination: ${parsedLink.reason}`);
    }

    const focalPoint = normalizeFocalPoint(row.focalPoint);
    if (!focalPoint) {
      errors.push(`Slide ${position} focal point must use horizontal and vertical percentages from 0 to 100.`);
    }

    if (id && url && title && parsedLink.ok && focalPoint) {
      slides.push({
        id,
        url,
        title,
        link: parsedLink.href ?? "",
        focalPoint,
      });
    }
  });

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, slides };
}

/** Public projections fail closed when persisted JSON is malformed or unsafe. */
export function parseStoredHeroSlides(value: unknown): HeroSlide[] {
  if (typeof value !== "string") return [];
  try {
    const result = validateAndNormalizeHeroSlides(JSON.parse(value));
    return result.ok ? result.slides : [];
  } catch {
    return [];
  }
}
