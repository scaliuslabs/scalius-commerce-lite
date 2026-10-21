// The parts of a theme an app draws (the API's `ThemeAppPart`): an app's
// page lists the published ones before it is turned off, and a refused
// publish (`theme_apps_unavailable`) lists the draft's parts per app. Both
// read them in the same plain words.
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { themeAppPartsMessages } from "~/i18n/theme-app-parts";

/** One part, as the API describes it. */
export interface ThemeAppPart {
  kind: "section" | "section_skin" | "skin" | "product_block";
  type: string;
  target?: string;
  path: string;
  place: {
    page: "home" | "landing" | "template" | "theme";
    slug?: string;
    template?: "product" | "collection" | "cart" | "page";
    index?: number;
  };
  /** The app's name for the part; absent when it no longer declares it. */
  name?: string;
}

export interface ThemeAppsProblem {
  pluginId: string;
  /** Absent when the app is not installed. */
  name?: string;
  reason: "app_inactive" | "not_declared";
  parts: ThemeAppPart[];
}

/** The API's refusal code for a publish that draws with apps that are not ready. */
export const THEME_APPS_UNAVAILABLE = "theme_apps_unavailable";

const KINDS = new Set(["section", "section_skin", "skin", "product_block"]);
const PAGES = new Set(["home", "landing", "template", "theme"]);

function readPart(value: unknown): ThemeAppPart | null {
  const part = value as Partial<ThemeAppPart> | null;
  if (!part || typeof part !== "object" || !KINDS.has(part.kind as string) || typeof part.type !== "string" || typeof part.path !== "string") return null;
  if (!part.place || typeof part.place !== "object" || !PAGES.has(part.place.page as string)) return null;
  return part as ThemeAppPart;
}

/** The apps a refused publish names, with their parts; null for any other failure. */
export function themeAppsUnavailable(error: unknown): { apps: ThemeAppsProblem[]; moreParts: number } | null {
  if (!(error instanceof AdminApiResponseError) || error.code !== THEME_APPS_UNAVAILABLE) return null;
  const details = error.details as { apps?: unknown; moreParts?: unknown } | null | undefined;
  if (!details || !Array.isArray(details.apps)) return null;
  const apps = details.apps.flatMap((value: unknown): ThemeAppsProblem[] => {
    const app = value as Partial<ThemeAppsProblem> | null;
    if (!app || typeof app.pluginId !== "string" || (app.reason !== "app_inactive" && app.reason !== "not_declared")) return [];
    const parts = Array.isArray(app.parts) ? app.parts.flatMap((part) => readPart(part) ?? []) : [];
    return [{ pluginId: app.pluginId, ...(typeof app.name === "string" ? { name: app.name } : {}), reason: app.reason, parts }];
  });
  if (apps.length === 0) return null;
  return { apps, moreParts: typeof details.moreParts === "number" && details.moreParts > 0 ? details.moreParts : 0 };
}

type PartKey = keyof (typeof themeAppPartsMessages)["en"];
type Translate = (key: PartKey, vars?: Record<string, string | number>) => string;

const UNITS: Record<string, PartKey> = {
  header: "unit_header",
  footer: "unit_footer",
  product_card: "unit_product_card",
  product_main: "unit_product_main",
  listing_main: "unit_listing_main",
};

function pageText(place: ThemeAppPart["place"], t: Translate): string {
  if (place.page === "landing") return t("page_landing", { slug: place.slug ?? "" });
  if (place.page === "template") return t(`template_${place.template ?? "page"}` as PartKey);
  return t("page_home");
}

/** A part in plain words: "Header (skin)", "Home page: section 3 'Studio hero'", "Product page app component". */
export function themeAppPartText(part: ThemeAppPart, t: Translate): string {
  const named = part.name ? { name: part.name } : null;
  if (part.kind === "skin") {
    const unit = t(UNITS[part.target ?? ""] ?? "unit_section");
    return named ? t("partSkinNamed", { unit, ...named }) : t("partSkin", { unit });
  }
  if (part.kind === "product_block") return named ? t("partProductBlockNamed", named) : t("partProductBlock");
  const vars = { page: pageText(part.place, t), position: (part.place.index ?? 0) + 1 };
  if (part.kind === "section_skin") return named ? t("partSectionSkinNamed", { ...vars, ...named }) : t("partSectionSkin", vars);
  return named ? t("partSectionNamed", { ...vars, ...named }) : t("partSection", vars);
}
