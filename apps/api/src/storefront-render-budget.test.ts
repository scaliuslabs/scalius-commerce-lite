// Extends zod with .openapi() before the shared theme schemas load (the routes need it).
import "@hono/zod-openapi";
import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { refreshProductRecommendations, refreshProductSalesStats } from "@scalius/core/modules/catalog";
import {
  STOREFRONT_SECTION_TYPES,
  storefrontSectionDefault,
  storefrontTemplateTheme,
  type StorefrontSection,
} from "@scalius/shared/storefront-theme";

/**
 * D1 budget of each storefront page render. A page is one storefront batch
 * (see storefront-batch.ts) whose parts run concurrently; on a cache miss
 * each part reads D1. `roundTrips` counts D1 calls (a batch is one) and
 * `waves` the dependent rounds, the part that costs a full database round
 * trip each. Budgets are the measured values of this seeded store, so a new
 * query or a new sequential await fails here before it reaches production.
 */
const PAGE_D1_BUDGETS = {
  home: { roundTrips: 13, waves: 2 },
  product: { roundTrips: 21, waves: 3 },
  category: { roundTrips: 7, waves: 3 },
  search: { roundTrips: 7, waves: 2 },
} as const;

const PAGE_PARTS: Record<keyof typeof PAGE_D1_BUDGETS, string[]> = {
  home: ["/api/v1/storefront/layout", "/api/v1/storefront/homepage", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  product: ["/api/v1/storefront/layout", "/api/v1/products/linen-panjabi", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  category: ["/api/v1/storefront/layout", "/api/v1/categories/panjabi/products?page=1&limit=20&sort=newest"],
  search: ["/api/v1/storefront/layout", "/api/v1/products?page=1&limit=20&sort=relevance&search=linen"],
};

const SEED = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
  INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
    ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_panjabi', 1),
    ('p_cotton', 'Cotton Panjabi', 180000, 'cotton-panjabi', 'cat_panjabi', 1);
  INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('opt_size', 'p_linen', 'Size', 'size', 0);
  INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
    ('ov_m', 'opt_size', 'M', 'm', 0), ('ov_l', 'opt_size', 'L', 'l', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, option_combination_key) VALUES
    ('v_linen_m', 'p_linen', 'LIN-M', 250000, 5, 0, 0, 1, 'M'),
    ('v_linen_l', 'p_linen', 'LIN-L', 250000, 5, 0, 0, 1, 'L'),
    ('v_cotton', 'p_cotton', 'COT-1', 180000, 5, 0, 1, 1, NULL);
  INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
    ('v_linen_m', 'opt_size', 'ov_m'), ('v_linen_l', 'opt_size', 'ov_l');
  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
    ('media_linen', 'linen.jpg', 'image', 'media/linen.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600);
  INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_linen', 'p_linen', 'media_linen', 1, 0);
`;

/**
 * The home page is measured on a store that uses **every section type**:
 * banners with original uploads (the rendition lookup), a homepage grid and
 * carousel collection (manual and dynamic), the category rail, and a theme
 * whose sections read every product source (newest, on sale, popular, a
 * category, a collection) and every kind of section image.
 */
function everySectionTheme() {
  const theme = storefrontTemplateTheme("department-mall");
  const sections: StorefrontSection[] = STOREFRONT_SECTION_TYPES.map((type, index) => storefrontSectionDefault(type, `s${index}`));
  const set = (type: string, settings: Record<string, unknown>, id = type) => {
    const section = { id, type, version: 1, settings } as StorefrontSection;
    const at = sections.findIndex((each) => each.type === type && each.id.startsWith("s"));
    if (at >= 0 && id === type) sections[at] = section;
    else sections.push(section);
  };
  set("hero", { layout: "contained-banners", sideBanners: [{ mediaId: "media_side", alt: "Side", href: "/sale" }] });
  set("product-rail", { title: "", source: { kind: "popular" }, limit: 12 });
  set("product-grid", { title: "", source: { kind: "category", categoryId: "cat_panjabi" }, columns: 4, rows: 2 });
  set("deal-block", { title: "", source: { kind: "on-sale" }, endsAt: null });
  set("lookbook", { title: "", mediaId: "media_look", source: { kind: "collection", collectionId: "col_grid" } });
  set("banner", { layout: "two-up", heading: "Eid", text: "", mediaId: "media_banner", cta: null });
  set("editorial", { layout: "image-with-text", heading: "Story", body: "Woven by hand.", mediaId: "media_story", imageSide: "end" });
  set("product-rail", { title: "", source: { kind: "newest" }, limit: 8 }, "rail-newest");
  theme.pages.home = sections;
  return theme;
}

const slide = (id: string, key: string) => ({ id, url: `https://media.test/${key}`, title: id, heading: "", buttonLabel: "", link: "", focalPoint: { x: 50, y: 50 } });
const HOME_SEED = `
  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
    ('media_hero', 'hero.jpg', 'image', 'media/hero.jpg', 1, 'image/jpeg', 'ready', 1600, 600, 1600),
    ('media_side', 'side.jpg', 'image', 'media/side.jpg', 1, 'image/jpeg', 'ready', 600, 480, 600),
    ('media_look', 'look.jpg', 'image', 'media/look.jpg', 1, 'image/jpeg', 'ready', 800, 800, 800),
    ('media_banner', 'banner.jpg', 'image', 'media/banner.jpg', 1, 'image/jpeg', 'ready', 1600, 500, 1600),
    ('media_story', 'story.jpg', 'image', 'media/story.jpg', 1, 'image/jpeg', 'ready', 1200, 900, 1200);
  INSERT INTO hero_sliders (id, type, images) VALUES
    ('hero_desktop', 'desktop', '${JSON.stringify([slide("d1", "media/hero.jpg"), slide("d2", "media/side.jpg")])}'),
    ('hero_mobile', 'mobile', '${JSON.stringify([slide("m1", "media/hero.jpg")])}');
  UPDATE products SET discount_type = 'percentage', discount_bps = 1000 WHERE id = 'p_cotton';
  INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
    ('col_grid', 'Best sellers', 'grid', '{"source":"manual","productIds":["p_linen","p_cotton"],"showOnHomepage":true,"featuredProductId":"p_linen","maxProducts":8}', 0),
    ('col_rail', 'Panjabi', 'carousel', '{"source":"dynamic","categoryIds":["cat_panjabi"],"showOnHomepage":true,"maxProducts":12}', 1);
  INSERT INTO settings (id, key, value, category, type) VALUES
    ('set_homepage', 'document', '{"categoryRail":{"enabled":true,"title":"Shop by category","categoryIds":["cat_panjabi"]},"trustStrip":{"enabled":true}}', 'homepage', 'json');
  INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at) VALUES
    ('o_1', 'A', '01700000001', 'Road', 'city', 'zone', 'delivered', unixepoch(), unixepoch()),
    ('o_2', 'B', '01700000002', 'Road', 'city', 'zone', 'pending', unixepoch(), unixepoch());
  INSERT INTO order_items (id, order_id, product_id, quantity) VALUES ('oi_1', 'o_1', 'p_linen', 1), ('oi_2', 'o_2', 'p_linen', 1);
`;

interface Meter {
  binding: D1Database;
  roundTrips: number;
  waves: number;
}

/**
 * Wraps the D1 binding so every call waits for the current wave: calls made
 * before the wave starts share it, calls made from a result start the next.
 */
function meteredBinding(inner: D1Database): Meter {
  const meter = { roundTrips: 0, waves: 0 } as Meter;
  let queued: Array<() => void> = [];
  const roundTrip = <T>(work: () => Promise<T>): Promise<T> => {
    meter.roundTrips += 1;
    return new Promise<T>((resolve, reject) => {
      queued.push(() => void work().then(resolve, reject));
      if (queued.length === 1) {
        setTimeout(() => {
          meter.waves += 1;
          const run = queued;
          queued = [];
          for (const start of run) start();
        }, 0);
      }
    });
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") {
        return (...args: unknown[]) => wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
      }
      if (["all", "first", "run", "raw"].includes(String(property))) {
        return (...args: unknown[]) => roundTrip(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  meter.binding = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => roundTrip(() => target.batch(statements));
      }
      return Reflect.get(target, property, receiver);
    },
  }) as D1Database;
  return meter;
}

async function renderPage(page: keyof typeof PAGE_PARTS) {
  const { sqlite, binding, db } = createSqliteD1Database();
  sqlite.exec(SEED);
  if (page === "home") {
    sqlite.exec(HOME_SEED);
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)")
      .run(JSON.stringify(everySectionTheme()));
  }
  // The steady state of a live store (unmetered): the catalogue projections
  // and sales stats a release rebuild and the nightly run keep, and every
  // product's stored recommendations.
  await rebuildCatalogProjections(db);
  await refreshProductSalesStats(db);
  await refreshProductRecommendations(db, ["p_linen", "p_cotton"]);
  const meter = meteredBinding(binding);
  const env = {
    DB: meter.binding,
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    JWT_SECRET: "render-budget-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "render-budget-credential-key-0123456789abcdef",
  } as unknown as Env;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const responses = await Promise.all(PAGE_PARTS[page].map((path) =>
    fetchRuntimeApiApp(new Request(`https://api.internal${path}`), env, ctx)));
  const bodies = await Promise.all(responses.map((response) => response.clone().json().catch(() => null)));
  return {
    statuses: responses.map((response) => response.status),
    bodies,
    roundTrips: meter.roundTrips,
    waves: meter.waves,
  };
}

describe("storefront page render D1 budget", () => {
  it("measures the home page on a store whose sections all have data", async () => {
    const theme = everySectionTheme();
    expect(new Set(theme.pages.home.map((section) => section.type))).toEqual(new Set(STOREFRONT_SECTION_TYPES));
    const { bodies } = await renderPage("home");
    const homepage = (bodies[1] as { data: { sections: { lists: Array<{ key: string; products: unknown[] }>; media: unknown[] }; collections: unknown[]; hero: { desktop: { images: Array<{ url: string }> } } } }).data;
    const filled = Object.fromEntries(homepage.sections.lists.map((list) => [list.key, list.products.length]));
    expect(filled).toMatchObject({
      newest: 2,
      "on-sale": 1,
      popular: 1,
      "category:cat_panjabi": 2,
      "collection:col_grid": 2,
    });
    expect(homepage.sections.media).toHaveLength(4);
    expect(homepage.collections).toHaveLength(2);
    // The banner's original upload was pointed at its rendition in the same batch.
    expect(homepage.hero.desktop.images[0]!.url).toBe("https://media.test/media/hero.jpg/1600.webp");
  });

  // Load every route module first: a first dynamic import would otherwise
  // show up as extra waves that production (one bundle) never has.
  beforeAll(async () => {
    for (const page of Object.keys(PAGE_PARTS) as Array<keyof typeof PAGE_PARTS>) await renderPage(page);
  });

  it.each(Object.keys(PAGE_D1_BUDGETS) as Array<keyof typeof PAGE_D1_BUDGETS>)(
    "%s page stays within its D1 round trips and waves",
    async (page) => {
      const result = await renderPage(page);

      expect(result.statuses.every((status) => status === 200), JSON.stringify(result.statuses)).toBe(true);
      expect({ page, roundTrips: result.roundTrips, waves: result.waves }).toEqual({
        page,
        roundTrips: Math.min(result.roundTrips, PAGE_D1_BUDGETS[page].roundTrips),
        waves: Math.min(result.waves, PAGE_D1_BUDGETS[page].waves),
      });
    },
  );
});
