// Extends zod with .openapi() before the shared theme schemas load (the routes need it).
import "@hono/zod-openapi";
import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createPublicPartReader, renderPublicRead } from "./public-read";
import { getDb } from "@scalius/database/client";
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
 *
 * Every part renders the way the dependency-validated part reader renders it
 * (public-read.ts, strict mode): inside a dependency scope, so every key a
 * read declares is paid for here, with its s0 and the Platform settings row
 * taken from the data center's clock snapshot. A declaration that needs a
 * read of its own must fold it into a statement or batch the render already
 * runs, or it fails this budget. The same page again is all hits: one
 * validation statement, one wave.
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
  -- A legacy tab (mirrored into a block), a body block, a bundle tier and EMI plans:
  -- the product page reads them in the waves it already has.
  INSERT INTO product_rich_content (id, product_id, title, content, sort_order) VALUES ('prc_care', 'p_linen', 'Care', '<p>Hand wash.</p>', 0);
  INSERT INTO product_content_blocks (id, product_id, placement, position, type, version, settings) VALUES
    ('pcb_promise', 'p_linen', 'after-buy-box', 0, 'guarantee', 1, '{"heading":"","text":"7-day returns."}');
  INSERT INTO product_bundles (id, product_id, quantity, discount_type, discount_bps) VALUES ('pbd_linen_pair', 'p_linen', 2, 'percentage', 1000);
  INSERT INTO settings (id, key, value, type, category) VALUES
    ('emi', 'document', '{"enabled":true,"plans":[{"id":"city-6","provider":"City Bank","months":6,"feeBps":300,"minAmountMinor":0}]}', 'json', 'emi');
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

class MemoryCache {
  readonly entries = new Map<string, Response>();
  async match(key: RequestInfo | URL) {
    return this.entries.get(String(key))?.clone();
  }
  async put(key: RequestInfo | URL, response: Response) {
    this.entries.set(String(key), response);
  }
  async delete(key: RequestInfo | URL) {
    return this.entries.delete(String(key));
  }
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
  const baseEnv = {
    CF_VERSION_METADATA: { id: "render-budget-version", tag: "", timestamp: "" },
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    JWT_SECRET: "render-budget-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "render-budget-credential-key-0123456789abcdef",
  };
  const cache = new MemoryCache();
  const readBatch = async (env: Env, paths: readonly string[]) => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise), passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const reader = createPublicPartReader({
      mode: "strict",
      env,
      cache,
      db: () => getDb(env),
      render: (part) => renderPublicRead(part, env, ctx),
      waitUntil: (promise) => void waits.push(promise),
      maxConcurrentRenders: 4,
      random: () => 1,
    });
    const settled = await reader.readParts(paths.map((path) => new Request(`https://api.internal${path}`)), null);
    const parts = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const bodies = await Promise.all(parts.map((part) => part.response.clone().json().catch(() => null)));
    await Promise.all(waits);
    return { parts, bodies };
  };
  // The data center already holds a clock snapshot (any earlier batch left one).
  await readBatch({ ...baseEnv, DB: binding } as unknown as Env, ["/api/v1/checkout-languages/active"]);
  const env = { ...baseEnv, DB: meter.binding } as unknown as Env;
  const { parts, bodies } = await readBatch(env, PAGE_PARTS[page]);
  const miss = { roundTrips: meter.roundTrips, waves: meter.waves };
  const again = await readBatch(env, PAGE_PARTS[page]);
  return {
    statuses: parts.map((part) => part.response.status),
    bodies,
    roundTrips: miss.roundTrips,
    waves: miss.waves,
    stored: parts.map((part) => part.cache?.status ?? null),
    hit: {
      roundTrips: meter.roundTrips - miss.roundTrips,
      waves: meter.waves - miss.waves,
      statuses: again.parts.map((part) => part.cache?.status ?? null),
      sameBodies: JSON.stringify(again.bodies) === JSON.stringify(bodies),
    },
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

  it("measures the product page with its tabs, content blocks, bundle tiers and EMI line", async () => {
    const { bodies } = await renderPage("product");
    const product = (bodies[1] as { data: { product: Record<string, unknown> } }).data.product;
    expect(product.additionalInfo).toEqual([{ id: "prc_care", title: "Care", content: "<p>Hand wash.</p>" }]);
    expect(product.contentBlocks).toEqual([
      { id: "pcb_promise", placement: "after-buy-box", type: "guarantee", version: 1, settings: { heading: "", text: "7-day returns." } },
    ]);
    expect(product.bundles).toEqual([
      { quantity: 2, discountType: "percentage", discountPercentage: 10, price: null, label: null, isActive: true },
    ]);
    // ৳2,500 + 3% = ৳2,575 over 6 months = ৳429.17 -> ৳430.
    expect(product.emi).toEqual({ provider: "City Bank", months: 6, monthly: 430, monthlyMinor: 43_000 });
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
      // Every part was stored with its dependency proof.
      expect(result.stored).toEqual(PAGE_PARTS[page].map(() => "miss"));
    },
  );

  it.each(Object.keys(PAGE_D1_BUDGETS) as Array<keyof typeof PAGE_D1_BUDGETS>)(
    "%s page again is all validated hits: one statement, one wave",
    async (page) => {
      const { hit } = await renderPage(page);

      expect(hit).toEqual({
        roundTrips: 1,
        waves: 1,
        statuses: PAGE_PARTS[page].map(() => "hit"),
        sameBodies: true,
      });
    },
  );
});
