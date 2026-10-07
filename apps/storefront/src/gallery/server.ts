/**
 * What the gallery server (scripts/gallery-server.mjs) asks of the gallery:
 * the entries, how to render one (which real page, at which URL, with which
 * request runtime), the fixture API and the fixture images.
 *
 * Dev and test only. Nothing in the production build imports this folder,
 * and a production build refuses to evaluate it.
 */
import { resolveStorefrontTheme } from "@scalius/shared/storefront-theme";
import { answerFixtureApi, entryTheme, galleryApiBase, GALLERY_API_PREFIX, unansweredReads } from "./api";
import { galleryEntries, galleryEntry, type GalleryEntry, type GalleryPage } from "./entries";
import { PRODUCT_SCENARIO_SLUGS, mediaShape, setFixtureOrigin } from "./fixtures";

if (import.meta.env.PROD) {
  throw new Error("The storefront gallery is dev and test only.");
}

export { answerFixtureApi, galleryEntry, GALLERY_API_PREFIX };

const PAGES: Record<GalleryPage, { module: string; path: (entry: GalleryEntry) => string; params: (entry: GalleryEntry) => Record<string, string> }> = {
  home: { module: "/src/pages/index.astro", path: () => "/", params: () => ({}) },
  landing: { module: "/src/pages/pages/[slug].astro", path: () => "/pages/eid-sale", params: () => ({ slug: "eid-sale" }) },
  product: {
    module: "/src/pages/products/[slug].astro",
    path: (entry) => `/products/${PRODUCT_SCENARIO_SLUGS[entry.scenario.product ?? "fashion"]}`,
    params: (entry) => ({ slug: PRODUCT_SCENARIO_SLUGS[entry.scenario.product ?? "fashion"] }),
  },
  category: { module: "/src/pages/categories/[slug].astro", path: () => "/categories/women", params: () => ({ slug: "women" }) },
  collection: { module: "/src/pages/collections/[id].astro", path: () => "/collections/col-eid", params: () => ({ id: "col-eid" }) },
  brand: { module: "/src/pages/brands/[slug].astro", path: () => "/brands/samsung", params: () => ({ slug: "samsung" }) },
  search: {
    module: "/src/pages/search/index.astro",
    path: (entry) => `/search?q=${entry.scenario.listing === "empty" ? "zzz-nothing" : "saree"}`,
    params: () => ({}),
  },
  cart: { module: "/src/pages/cart.astro", path: () => "/cart", params: () => ({}) },
  page: { module: "/src/pages/[slug].astro", path: () => "/returns", params: () => ({ slug: "returns" }) },
};

export interface GalleryRenderPlan {
  entry: GalleryEntry;
  page: string;
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  runtime: Record<string, unknown>;
}

/** How the server renders one entry: the real page module, its URL and request runtime. */
export function galleryRenderPlan(id: string, origin: string): GalleryRenderPlan | null {
  const entry = galleryEntry(id);
  if (!entry) return null;
  setFixtureOrigin(origin);
  const page = PAGES[entry.page];
  const presence = entry.scenario.locale === "ar" ? "ar-ae" : null;
  const path = page.path(entry);
  return {
    entry,
    page: page.module,
    url: `${origin}${presence ? `/${presence}${path === "/" ? "" : path}` : path}`,
    headers: {},
    params: page.params(entry),
    runtime: {
      PUBLIC_API_URL: `${galleryApiBase(origin, entry.id)}/api/v1`,
      PUBLIC_API_BASE_URL: galleryApiBase(origin, entry.id),
      STOREFRONT_URL: origin,
      CDN_DOMAIN_URL: new URL(origin).host,
      STORE_TIME_ZONE: "Asia/Dhaka",
      inflightReads: new Map(),
      ...(presence ? { MARKET_PRESENCE: presence } : {}),
    },
  };
}

export interface GalleryIndexEntry {
  id: string;
  family: string;
  title: string;
  page: GalleryPage;
  locale: string;
  dir: "ltr" | "rtl";
  path: string;
  focus: GalleryEntry["focus"];
  interact: NonNullable<GalleryEntry["interact"]>;
  /** Variants the resolver replaced for the fixture store (should be none). */
  fallbacks: string[];
  /** Reads the fixture API could not answer when the entry last rendered. */
  unanswered: string[];
}

export function galleryIndex(): GalleryIndexEntry[] {
  return galleryEntries().map((entry) => {
    const resolved = resolveStorefrontTheme(entryTheme(entry), {
      productCount: 1000, skuCount: 1000, topCategoryCount: 18, categoryDepth: 3, categoryGroups: 7, menuTopItems: 18, menuDepth: 3, menuGroups: 7,
      brandCount: 24, hasCollections: true, hasDeliveryMethods: true, hasKeySpecs: true, hasEmiPlans: true, hasDigitalLines: true, hasReviews: true, hasContentBlocks: true,
    });
    return {
      id: entry.id,
      family: entry.family,
      title: entry.title,
      page: entry.page,
      locale: entry.scenario.locale === "ar" ? "ar" : entry.scenario.locale === "bn" ? "bn" : "en",
      dir: entry.scenario.locale === "ar" ? "rtl" : "ltr",
      path: `/__gallery/e/${entry.id}`,
      focus: entry.focus,
      interact: entry.interact ?? [],
      fallbacks: resolved.fallbacks.map((fallback) => `${fallback.kind} ${fallback.key}: ${fallback.requested} -> ${fallback.resolved ?? "left out"}`),
      unanswered: [...(unansweredReads.get(entry.id) ?? [])],
    };
  });
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The index page: every entry by family, linking its render. */
export function galleryIndexHtml(): string {
  const entries = galleryIndex();
  const families = new Map<string, GalleryIndexEntry[]>();
  for (const entry of entries) families.set(entry.family, [...(families.get(entry.family) ?? []), entry]);
  const sections = [...families].map(([family, items]) => `<section><h2>${escapeHtml(family)} <small>${items.length}</small></h2><ul>${items
    .map((item) => `<li><a href="${escapeHtml(item.path)}">${escapeHtml(item.title)}</a>${item.fallbacks.length ? ` <em>falls back: ${escapeHtml(item.fallbacks.join("; "))}</em>` : ""}</li>`)
    .join("")}</ul></section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Storefront gallery</title><style>
body{margin:0;padding:24px 16px;font:15px/1.5 system-ui,sans-serif;color:#1d1c1a;background:#fff}h1{margin:0 0 4px}p{margin:0 0 24px;color:#555}
main{max-width:1200px;margin:0 auto;columns:3 320px;column-gap:32px}section{break-inside:avoid;margin:0 0 24px}h2{font-size:16px;margin:0 0 8px}small{color:#666;font-weight:400}
ul{margin:0;padding:0 0 0 18px}a{color:#1d4ed8}em{color:#a14d00;font-size:13px}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}p,small{color:#aaa}a{color:#93b4ff}em{color:#f3b36b}}
</style></head><body><header style="max-width:1200px;margin:0 auto"><h1>Storefront gallery</h1><p>${entries.length} entries: real pages, fixture data (docs/STOREFRONT-QUALITY.md).</p></header><main>${sections}</main></body></html>`;
}

function hue(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** A fixture image: `<id>.jpg/<w>.webp` (a rendition) or `<id>.jpg`, drawn as an SVG of the id's shape. */
export function galleryMedia(path: string): { contentType: string; body: string } | null {
  const match = /^([a-z0-9-]+)\.jpg(?:\/\d+\.webp)?$/.exec(path);
  if (!match) return null;
  const id = match[1]!;
  const { width, height } = mediaShape(id);
  const h = hue(id);
  const label = id.replace(/^[a-z]+-/, "").replace(/-/g, " ");
  const logo = id.startsWith("logo-");
  const body = logo
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="hsl(${h} 30% 96%)"/><text x="50%" y="56%" text-anchor="middle" font-family="Georgia,serif" font-size="${height * 0.34}" font-weight="700" fill="hsl(${h} 45% 25%)">${escapeHtml(label)}</text></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 38% 78%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 42% 52%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width * 0.7}" cy="${height * 0.35}" r="${Math.min(width, height) * 0.22}" fill="hsl(${h} 50% 92% / .5)"/><rect x="${width * 0.12}" y="${height * 0.55}" width="${width * 0.5}" height="${height * 0.3}" rx="${width * 0.02}" fill="hsl(${(h + 180) % 360} 30% 30% / .25)"/><text x="${width * 0.06}" y="${height * 0.94}" font-family="system-ui,sans-serif" font-size="${Math.min(width, height) * 0.05}" fill="hsl(${h} 40% 18% / .7)">${escapeHtml(label)}</text></svg>`;
  return { contentType: "image/svg+xml", body };
}
