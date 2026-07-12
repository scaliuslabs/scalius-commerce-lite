import { parseNavigationHref } from "./navigation-href";

export const HERO_SLIDE_LIMIT = 12;
export const HERO_SLIDE_TITLE_LIMIT = 160;
export const HERO_SLIDE_URL_LIMIT = 2_048;

export interface HeroSlide {
  id: string;
  url: string;
  title: string;
  link: string;
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

    if (id && url && title && parsedLink.ok) {
      slides.push({
        id,
        url,
        title,
        link: parsedLink.href ?? "",
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
