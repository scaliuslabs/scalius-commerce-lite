// Extends zod with .openapi() before the shared theme schemas load (the routes need it).
import "@hono/zod-openapi";
import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createPublicPartReader, renderPublicRead } from "./public-read";
import { MAX_STOREFRONT_BATCH_PARTS } from "@scalius/shared/public-api-cache-routes";
import { getDb } from "@scalius/database/client";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { refreshProductRecommendations, refreshProductSalesStats } from "@scalius/core/modules/catalog";
import { activatePlugin, installPlugin } from "@scalius/core/modules/plugins";
import { parsePluginManifest } from "@scalius/shared/plugins";
import {
  createNavigationMenu,
  createNavigationMenuItem,
  publishNavigationMenu,
  saveNavigationPlacement,
} from "@scalius/core/modules/navigation";
import type { Database } from "@scalius/database/client";
import type { NavigationMenuItemInput } from "@scalius/core/modules/navigation";
import {
  STOREFRONT_SECTION_TYPES,
  storefrontSectionDefault,
  storefrontThemeDocumentSchema,
  storefrontTemplateTheme,
  type StorefrontSection,
  type StorefrontThemeDocument,
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
 * taken from one authoritative validation statement before rendering. We
 * meter that exact SQL separately (exactly one statement in the first wave)
 * and retain the original render budgets below. Total cold cost includes both;
 * this does not hide extra render queries or relax the HTTP timing budget.
 * The same page again is all hits: one validation statement, one wave.
 */
const PAGE_D1_BUDGETS = {
  home: { roundTrips: 10, waves: 2 },
  product: { roundTrips: 19, waves: 3 },
  category: { roundTrips: 5, waves: 3 },
  search: { roundTrips: 5, waves: 2 },
  collection: { roundTrips: 6, waves: 3 },
  landing: { roundTrips: 10, waves: 2 },
  cart: { roundTrips: 13, waves: 2 },
  checkout: { roundTrips: 7, waves: 2 },
} as const;

/** A page template with sections: its part read after the page's batch (theme and collections, then the sections' data). */
const TEMPLATE_PART_D1_BUDGET = { roundTrips: 2, waves: 2 } as const;

const PAGE_PARTS: Record<keyof typeof PAGE_D1_BUDGETS, string[]> = {
  home: ["/api/v1/storefront/layout", "/api/v1/storefront/homepage", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  product: ["/api/v1/storefront/layout", "/api/v1/products/linen-panjabi", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  category: ["/api/v1/storefront/layout", "/api/v1/categories/panjabi/products?page=1&limit=20&sort=newest"],
  search: ["/api/v1/storefront/layout", "/api/v1/products?page=1&limit=20&sort=relevance&search=linen"],
  collection: ["/api/v1/storefront/layout", "/api/v1/collections/col_grid?page=1&limit=20&sort=newest"],
  landing: ["/api/v1/storefront/layout", "/api/v1/storefront/landing/eid", "/api/v1/shipping-methods", "/api/v1/checkout/config"],
  // The buyer shells (cached like public pages; a signed-in buyer renders them live).
  cart: ["/api/v1/storefront/layout", "/api/v1/locations/cities", "/api/v1/shipping-methods", "/api/v1/checkout-languages/active", "/api/v1/checkout/config", "/api/v1/products/recommendations?limit=8"],
  checkout: ["/api/v1/storefront/layout", "/api/v1/checkout/config", "/api/v1/checkout-languages/active"],
};

/** Component sections that name product sources and a picked product (what a theme app's shelf and order sections do). */
const SHELF_MANIFEST = {
  id: "acme.shelf",
  name: "Shelf",
  version: "1.0.0",
  apiVersion: "2026-10",
  description: "Product shelves for the render budget test.",
  author: { name: "Acme" },
  storefront: {
    sections: [
      { type: "shelf", name: "Shelf", settings: [{ key: "heading", label: "Heading", type: "text" }, { key: "products", label: "Products", type: "products", default: "newest", limit: 8 }] },
      { type: "order", name: "Order", settings: [{ key: "product", label: "Product", type: "product" }] },
    ],
  },
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
 * hero slides (with a phone image), a grid and a carousel collection (manual
 * and dynamic) picked by the collections section, category tiles, a product
 * homepage's product, and a theme whose sections read every product source
 * (newest, on sale, popular, a category, a collection) and every kind of
 * section image.
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
  set("hero", {
    layout: "contained-banners",
    slides: [
      { image: "media_hero", phoneImage: "media_side", focalPoint: { x: 50, y: 50 }, alt: "Eid", link: "/sale" },
      { image: "media_side", focalPoint: { x: 50, y: 50 }, alt: "Side", link: null },
    ],
    sideBanners: [{ mediaId: "media_side", alt: "Side", href: "/sale" }],
  });
  set("category-tiles", { style: "photo", title: "", categoryIds: ["cat_panjabi"] });
  set("collections", { carousel: "large", collectionIds: ["col_grid", "col_rail"] });
  set("product-rail", { title: "", source: { kind: "popular" }, limit: 12 });
  set("product-grid", { title: "", source: { kind: "category", categoryId: "cat_panjabi" }, columns: 4, rows: 2 });
  set("deal-block", { title: "", source: { kind: "on-sale" }, promotionId: "promo_deal" });
  set("product-tabs", { title: "", limit: 8, tabs: [{ label: "", source: { kind: "newest" } }, { label: "", source: { kind: "popular" } }] });
  set("shop-by", { title: "", cards: [{ mediaId: "media_banner", title: "Eid", href: "/eid" }] });
  set("banner-mosaic", { tiles: [{ mediaId: "media_story", alt: "", href: null }, { mediaId: "media_look", alt: "", href: null }] });
  set("lookbook", { title: "", mediaId: "media_look", source: { kind: "collection", collectionId: "col_grid" }, photo: "tall" });
  set("banner", { layout: "two-up", heading: "Eid", text: "", mediaId: "media_banner", cta: null });
  set("editorial", { layout: "image-with-text", heading: "Story", body: "Woven by hand.", mediaId: "media_story", imageSide: "end" });
  set("product-rail", { title: "", source: { kind: "newest" }, limit: 8 }, "rail-newest");
  theme.pages.home = sections;
  // The product homepage's product rides in the second batch too.
  theme.pages.homeMode = { kind: "product", productId: "p_linen" };
  return theme;
}

const HOME_SEED = `
  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
    ('media_hero', 'hero.jpg', 'image', 'media/hero.jpg', 1, 'image/jpeg', 'ready', 1600, 600, 1600),
    ('media_side', 'side.jpg', 'image', 'media/side.jpg', 1, 'image/jpeg', 'ready', 600, 480, 600),
    ('media_look', 'look.jpg', 'image', 'media/look.jpg', 1, 'image/jpeg', 'ready', 800, 800, 800),
    ('media_banner', 'banner.jpg', 'image', 'media/banner.jpg', 1, 'image/jpeg', 'ready', 1600, 500, 1600),
    ('media_story', 'story.jpg', 'image', 'media/story.jpg', 1, 'image/jpeg', 'ready', 1200, 900, 1200);
  UPDATE products SET discount_type = 'percentage', discount_bps = 1000 WHERE id = 'p_cotton';
  INSERT INTO brands (id, name, slug, status, logo_media_id) VALUES ('brd_aarong01', 'Aarong', 'aarong', 'published', 'media_look');
  UPDATE products SET brand_id = 'brd_aarong01' WHERE id = 'p_linen';
  INSERT INTO promotions (id, name, method, status, ends_at) VALUES ('promo_deal', 'Eid deal', 'automatic', 'active', unixepoch() + 86400);
  INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
    ('col_grid', 'Best sellers', 'grid', '{"source":"manual","productIds":["p_linen","p_cotton"],"featuredProductId":"p_linen","maxProducts":8}', 0),
    ('col_rail', 'Panjabi', 'carousel', '{"source":"dynamic","categoryIds":["cat_panjabi"],"maxProducts":12}', 1);
  INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at) VALUES
    ('o_1', 'A', '01700000001', 'Road', 'city', 'zone', 'delivered', unixepoch(), unixepoch()),
    ('o_2', 'B', '01700000002', 'Road', 'city', 'zone', 'pending', unixepoch(), unixepoch());
  INSERT INTO order_items (id, order_id, product_id, quantity) VALUES ('oi_1', 'o_1', 'p_linen', 1), ('oi_2', 'o_2', 'p_linen', 1);
`;

/**
 * Six delivered orders of the linen panjabi, handed over through the real
 * fulfilment ledger, each with a published review: the product page shows
 * five and a cursor, and listings get a card rating and the rating facet.
 */
const REVIEW_SEED = Array.from({ length: 6 }, (_, index) => {
  const n = index + 1;
  return `
    INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at)
      VALUES ('o_rev${n}', 'Buyer ${n}', '0170000010${n}', 'Road', 'city', 'zone', 'confirmed', unixepoch(), unixepoch());
    INSERT INTO order_items (id, order_id, product_id, quantity, fulfillment_type) VALUES ('oi_rev${n}', 'o_rev${n}', 'p_linen', 1, 'ship');
    INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES ('ful_rev${n}', 'o_rev${n}', 'ship', 'key_rev${n}', 'admin');
    INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES ('fln_rev${n}', 'ful_rev${n}', 'o_rev${n}', 'oi_rev${n}', 1);
    UPDATE orders SET status = 'delivered' WHERE id = 'o_rev${n}';
    INSERT INTO product_reviews (id, product_id, order_id, order_item_id, reviewer_key, author_type, author_display_name, rating, title, body, status, published_at)
      VALUES ('rev_budget_${n}', 'p_linen', 'o_rev${n}', 'oi_rev${n}', 'order:o_rev${n}', 'guest_receipt', 'Buyer ${n}.', ${n === 6 ? 3 : 5}, 'Fits well', 'Soft linen.', 'published', unixepoch() - ${n * 60});
  `;
}).join("");

interface Meter {
  binding: D1Database;
  roundTrips: number;
  waves: number;
  calls: Array<{ kind: "validation" | "render"; wave: number }>;
}

/**
 * Wraps the D1 binding so every call waits for the current wave: calls made
 * before the wave starts share it, calls made from a result start the next.
 */
function meteredBinding(inner: D1Database): Meter {
  const meter = { roundTrips: 0, waves: 0, calls: [] } as unknown as Meter;
  let queued: Array<() => void> = [];
  const roundTrip = <T>(work: () => Promise<T>, kind: "validation" | "render" = "render"): Promise<T> => {
    meter.roundTrips += 1;
    return new Promise<T>((resolve, reject) => {
      queued.push(() => {
        meter.calls.push({ kind, wave: meter.waves });
        void work().then(resolve, reject);
      });
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
  // Identify only readValidationSnapshot, which reads clock, Platform value
  // and revision, and exact dependency keys in one statement. Other cache or
  // settings reads count against the render budget, never this allowance.
  const isValidation = (query: string) => query.includes('LEFT JOIN "cache_clock" c')
    && query.includes('LEFT JOIN "cache_dep" d')
    && query.includes("AS pv") && query.includes("AS pr")
    && query.includes("st.\"category\" = 'platform'")
    && query.includes('d."dep" IN (SELECT CAST(value AS TEXT) FROM json_each(');
  const wrapStatement = (statement: D1PreparedStatement, query: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") {
        return (...args: unknown[]) => wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args), query);
      }
      if (["all", "first", "run", "raw"].includes(String(property))) {
        return (...args: unknown[]) => roundTrip(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args), isValidation(query) ? "validation" : "render");
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  meter.binding = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query), query);
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

async function renderPage(
  page: keyof typeof PAGE_PARTS,
  extraSeed = "",
  options: {
    paths?: readonly string[];
    prepare?: (db: Database) => Promise<void>;
    /** App component sections (Noor's) added to the home page. */
    components?: StorefrontSection[];
    editTheme?: (theme: StorefrontThemeDocument) => void;
  } = {},
) {
  const { sqlite, binding, db } = createSqliteD1Database();
  sqlite.exec(SEED);
  if (extraSeed) sqlite.exec(extraSeed);
  await options.prepare?.(db);
  if (options.components?.length) {
    // An app with component sections reading products; activation grants its storefront code.
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('shelf-owner', 'Owner', 'shelf-owner@shop.test', 1, 'admin', 1)").run();
    const parsed = parsePluginManifest(SHELF_MANIFEST);
    if (!parsed.ok) throw new Error("Invalid shelf manifest");
    const shelf = await installPlugin(db, { manifest: parsed.manifest, source: "bundled", bundleSha256: "c".repeat(64), actorUserId: "shelf-owner" });
    await activatePlugin(db, "acme.shelf", { actorUserId: "shelf-owner", expectedRevision: shelf.revision });
  }
  const sectionPage = page === "home" || page === "landing";
  const theme = sectionPage ? everySectionTheme() : storefrontTemplateTheme("department-mall");
  if (sectionPage) {
    sqlite.exec(HOME_SEED);
    // Room for three component sections within the page cap (the same core sections go with or without them).
    if (options.components) theme.pages.home = [...theme.pages.home.slice(0, -3), ...options.components];
    theme.pages.landing.eid = { title: "ঈদের বাছাই", description: "", sections: structuredClone(theme.pages.home) };
  } else if (page === "collection") {
    sqlite.exec(`INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
      ('col_grid', 'Best sellers', 'grid', '{"source":"manual","productIds":["p_linen","p_cotton"],"maxProducts":8}', 0)`);
  }
  options.editTheme?.(theme);
  expect(storefrontThemeDocumentSchema.safeParse(theme).error?.issues ?? []).toEqual([]);
  sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)")
    .run(JSON.stringify(theme));
  // The steady state of a live store (unmetered): the catalogue projections
  // and sales stats a release rebuild and the nightly run keep, and every
  // product's stored recommendations.
  await rebuildCatalogProjections(db);
  await refreshProductSalesStats(db);
  await refreshProductRecommendations(db, ["p_linen", "p_cotton"]);
  const meter = meteredBinding(binding);
  const baseEnv = {
    CF_VERSION_METADATA: { id: "render-budget-version", tag: "", timestamp: "" },
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
      maxConcurrentRenders: MAX_STOREFRONT_BATCH_PARTS,
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
  const env = { ...baseEnv, DB: meter.binding } as unknown as Env;
  const paths = options.paths ?? PAGE_PARTS[page];
  const { parts, bodies } = await readBatch(env, paths);
  const miss = { roundTrips: meter.roundTrips, waves: meter.waves };
  const validationCalls = meter.calls.filter((call) => call.kind === "validation");
  const renderCalls = meter.calls.filter((call) => call.kind === "render");
  const validation = {
    roundTrips: validationCalls.length,
    waves: new Set(validationCalls.map((call) => call.wave)).size,
    firstWave: validationCalls[0]?.wave,
  };
  const render = {
    roundTrips: renderCalls.length,
    waves: new Set(renderCalls.map((call) => call.wave)).size,
    firstWave: renderCalls[0]?.wave,
  };
  const again = await readBatch(env, paths);
  return {
    statuses: parts.map((part) => part.response.status),
    bodies,
    roundTrips: miss.roundTrips,
    waves: miss.waves,
    validation,
    render,
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
    // The seeded theme is a valid document (an invalid one would render the default theme).
    expect(storefrontThemeDocumentSchema.safeParse(theme).error?.issues ?? []).toEqual([]);
    const { bodies } = await renderPage("home");
    const homepage = (bodies[1] as { data: { sections: {
      lists: Array<{ key: string; products: unknown[] }>;
      media: Array<{ id: string; url: string }>;
      brands: unknown[];
      promotions: unknown[];
      categories: Array<{ id: string }>;
      collections: Array<{ id: string }>;
      homeProduct: { id: string; slug: string } | null;
    } } }).data;
    const filled = Object.fromEntries(homepage.sections.lists.map((list) => [list.key, list.products.length]));
    expect(filled).toMatchObject({
      newest: 2,
      "on-sale": 1,
      popular: 1,
      "category:cat_panjabi": 2,
      "collection:col_grid": 2,
    });
    expect(homepage.sections.media).toHaveLength(5);
    // The brand wall and the deal countdown ride in the same second batch.
    expect(homepage.sections.brands).toEqual([expect.objectContaining({ id: "brd_aarong01", name: "Aarong", logo: expect.objectContaining({ mediaId: "media_look" }) })]);
    expect(homepage.sections.promotions).toEqual([{ id: "promo_deal", endsAt: expect.any(String) }]);
    expect(homepage.sections.collections.map((collection) => collection.id)).toEqual(["col_grid", "col_rail"]);
    expect(homepage.sections.categories.map((category) => category.id)).toEqual(["cat_panjabi"]);
    expect(homepage.sections.homeProduct).toMatchObject({ id: "p_linen" });
    // A slide's image is its media row's published rendition.
    expect(homepage.sections.media.find((asset) => asset.id === "media_hero")!.url).toMatch(/media\/hero\.jpg\/1600\.webp$/);
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

  it("reads a landing page's sections through the home planner, including media and every product source", async () => {
    const result = await renderPage("landing");
    const body = (result.bodies[1] as { data: {
      title: string;
      description: string;
      sections: { lists: Array<{ key: string; products: unknown[] }>; media: unknown[]; homeProduct: unknown };
    } }).data;
    expect(body).toMatchObject({ title: "ঈদের বাছাই", description: "" });
    // Every section type is on the page (the layout's theme names them; this read carries their data).
    const layout = (result.bodies[0] as { data: { theme: { pages: { landing: Record<string, { sections: StorefrontSection[] }> } } } }).data;
    expect(new Set(layout.theme.pages.landing.eid!.sections.map((section) => section.type))).toEqual(new Set(STOREFRONT_SECTION_TYPES));
    expect(Object.fromEntries(body.sections.lists.map((list) => [list.key, list.products.length]))).toMatchObject({
      newest: 2, "on-sale": 1, popular: 1, "category:cat_panjabi": 2, "collection:col_grid": 2,
    });
    expect(body.sections.media).toHaveLength(5);
    expect(body.sections.homeProduct).toBeNull();
  });

  it.each(["product", "category", "collection", "search"] as const)("%s page: the editor's block edits (modules, toolbar) use the existing parts and budget", async (page) => {
    const result = await renderPage(page, "", {
      editTheme: (theme) => {
        theme.blocks.product = { ...theme.blocks.product, below: [...theme.blocks.product.below].reverse() };
        theme.blocks.listing = { ...theme.blocks.listing, toolbar: theme.blocks.listing.toolbar.filter((piece) => piece !== "breadcrumb") };
      },
    });
    const theme = (result.bodies[0] as { data: { theme: StorefrontThemeDocument } }).data.theme;
    expect(theme.blocks.product.below).toEqual([...storefrontTemplateTheme("department-mall").blocks.product.below].reverse());
    expect(theme.blocks.listing.toolbar).not.toContain("breadcrumb");
    expect(result.statuses).toEqual(PAGE_PARTS[page].map(() => 200));
    expect(result.render.roundTrips).toBeLessThanOrEqual(PAGE_D1_BUDGETS[page].roundTrips);
    expect(result.render.waves).toBeLessThanOrEqual(PAGE_D1_BUDGETS[page].waves);
    expect(result.hit).toEqual({ roundTrips: 1, waves: 1, statuses: PAGE_PARTS[page].map(() => "hit"), sameBodies: true });
  });

  // A page template's own sections cost only the stores that add them: a page whose template has
  // none never requests the template part (its parts and budgets above are unchanged); one that
  // has sections reads them after its batch, from the template part alone.
  it.each(["product", "collection"] as const)("reads the %s template's sections from its own part, only when it has some", async (kind) => {
    const page = kind === "product" ? "product" : "collection";
    const result = await renderPage(page, "", {
      paths: [`/api/v1/storefront/template/${kind}`],
      editTheme: (theme) => {
        theme.pages.templates[kind] = {
          sections: [
            { ...storefrontSectionDefault("product-rail", "rail"), settings: { ...storefrontSectionDefault("product-rail", "rail").settings, source: { kind: "newest" } } } as StorefrontSection,
            { ...storefrontSectionDefault("faq", "faq"), settings: { heading: "Questions", items: [{ question: "Delivery?", answer: "Two days." }] } } as StorefrontSection,
          ],
          main: 1,
        };
      },
    });
    expect(result.statuses).toEqual([200]);
    const sections = (result.bodies[0] as { data: { sections: { lists: Array<{ key: string; products: unknown[] }> } } }).data.sections;
    expect(sections.lists.find((list) => list.key === "newest")?.products).toHaveLength(2);
    expect({ roundTrips: result.render.roundTrips, waves: result.render.waves }).toEqual(TEMPLATE_PART_D1_BUDGET);
    expect(result.hit).toEqual({ roundTrips: 1, waves: 1, statuses: ["hit"], sameBodies: true });
  });

  it("reads a reviewed product's summary and first five reviews in its existing render budget (20 round trips, 3 waves) plus authoritative validation", async () => {
    const result = await renderPage("product", REVIEW_SEED);
    const product = (result.bodies[1] as { data: { product: { reviews: { summary: { count: number; average: number }; items: unknown[]; nextCursor: string | null } } } }).data.product;
    expect(product.reviews.summary).toMatchObject({ count: 6, average: 4.66 });
    expect(product.reviews.items).toHaveLength(5);
    expect(product.reviews.nextCursor).toEqual(expect.any(String));
    process.stdout.write(`[storefront budget] reviewed product: render ${result.render.roundTrips} trips/${result.render.waves} waves\n`);
    expect(result.render.roundTrips).toBeLessThanOrEqual(20);
    expect(result.render.waves).toBeLessThanOrEqual(PAGE_D1_BUDGETS.product.waves);
  });

  it("gives listing cards their rating and counts the rating facet without a new round trip", async () => {
    const reviewed = await renderPage("category", REVIEW_SEED);
    const body = (reviewed.bodies[1] as { data: { products: Array<{ id: string; rating: unknown }>; ratingFacet: Array<{ min: number; count: number }> } }).data;
    expect(body.products.find((product) => product.id === "p_linen")?.rating).toEqual({ average: 4.66, count: 6 });
    expect(body.products.find((product) => product.id === "p_cotton")?.rating).toBeNull();
    expect(body.ratingFacet).toEqual([{ min: 4, count: 1 }, { min: 3, count: 1 }, { min: 2, count: 1 }]);
    expect(reviewed.render.roundTrips).toBeLessThanOrEqual(PAGE_D1_BUDGETS.category.roundTrips);
    expect(reviewed.render.waves).toBeLessThanOrEqual(PAGE_D1_BUDGETS.category.waves);
  });

  it("reads a layout with header and footer menus and linked policies in two waves", async () => {
    // Policy pages, a published category, collection and page for menu targets.
    const seed = `
      INSERT INTO pages (id, content_type, title, slug, content, is_published) VALUES
        ('page_refund', 'page', 'Refund policy', 'refund-policy', '', 1),
        ('page_privacy', 'page', 'Privacy policy', 'privacy-policy', '', 1),
        ('page_about', 'page', 'About us', 'about-us', '', 1);
      INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
        ('col_new', 'New in', 'grid', '{"source":"manual","productIds":["p_linen"],"maxProducts":8}', 0);
      INSERT INTO settings (id, key, value, type, category) VALUES
        ('policies', 'document', '{"refund":"page_refund","privacy":"page_privacy"}', 'json', 'policies');
    `;
    const resource = (resourceType: "page" | "category" | "collection" | "product", resourceId: string) =>
      ({ type: "resource", resourceType, resourceId }) as const;
    const placeMenu = async (
      db: Database,
      name: string,
      placement: { id: string; surface: "header" | "footer"; slot: "primary" | "column"; position: number },
      items: Array<{ label: string; target: NavigationMenuItemInput["target"]; children?: Array<{ label: string; target: NavigationMenuItemInput["target"] }> }>,
    ) => {
      const menu = await createNavigationMenu(db, { name });
      let revision = menu.revision;
      for (const item of items) {
        const created = await createNavigationMenuItem(db, menu.id, { expectedRevision: revision, label: item.label, labelMode: "custom", target: item.target });
        revision = created.revision;
        const parentId = (created.item as { id: string }).id;
        for (const child of item.children ?? []) {
          revision = (await createNavigationMenuItem(db, menu.id, { expectedRevision: revision, parentId, label: child.label, labelMode: "custom", target: child.target })).revision;
        }
      }
      await publishNavigationMenu(db, menu.id, { expectedRevision: revision });
      await saveNavigationPlacement(db, { ...placement, expectedRevision: 0, menuId: menu.id });
    };
    const result = await renderPage("search", seed, {
      paths: ["/api/v1/storefront/layout"],
      prepare: async (db) => {
        await placeMenu(db, "Main", { id: "placement_header", surface: "header", slot: "primary", position: 0 }, [
          { label: "Panjabi", target: resource("category", "cat_panjabi"), children: [
            { label: "Linen", target: resource("product", "p_linen") },
            { label: "New in", target: resource("collection", "col_new") },
          ] },
          { label: "About", target: resource("page", "page_about") },
        ]);
        await placeMenu(db, "Help", { id: "placement_footer_help", surface: "footer", slot: "column", position: 0 }, [
          { label: "Refunds", target: resource("page", "page_refund") },
          { label: "Search", target: { type: "internal_path", path: "/search" } },
        ]);
        await placeMenu(db, "Shop", { id: "placement_footer_shop", surface: "footer", slot: "column", position: 1 }, [
          { label: "Cotton", target: resource("product", "p_cotton") },
        ]);
      },
    });
    const layout = (result.bodies[0] as { data: {
      navigation: Array<{ title: string; href?: string; subMenu?: Array<{ title: string; href?: string }> }>;
      footerMenus: Array<{ title: string; links: Array<{ title: string; href?: string }> }>;
      policies: Array<{ kind: string; title: string; path: string }>;
    } }).data;
    expect(layout.navigation).toEqual([
      expect.objectContaining({ title: "Panjabi", href: "/categories/panjabi", subMenu: [
        expect.objectContaining({ title: "Linen", href: "/products/linen-panjabi" }),
        expect.objectContaining({ title: "New in", href: "/collections/col_new" }),
      ] }),
      expect.objectContaining({ title: "About", href: "/about-us" }),
    ]);
    expect(layout.footerMenus.map((menu) => [menu.title, menu.links.map((link) => link.href)])).toEqual([
      ["Help", ["/refund-policy", "/search"]],
      ["Shop", ["/products/cotton-panjabi"]],
    ]);
    expect(layout.policies).toEqual([
      { kind: "refund", title: "Refund policy", path: "/refund-policy" },
      { kind: "privacy", title: "Privacy policy", path: "/privacy-policy" },
    ]);
    // The layout batch carries the placed menus; the policy pages and every
    // linked resource ride one second batch.
    expect({ roundTrips: result.render.roundTrips, waves: result.render.waves }).toEqual({ roundTrips: 2, waves: 2 });
    expect(result.stored).toEqual(["miss"]);
    expect(result.hit).toEqual({ roundTrips: 1, waves: 1, statuses: ["hit"], sameBodies: true });
  });

  // Load every route module first: a first dynamic import would otherwise
  // show up as extra waves that production (one bundle) never has.
  beforeAll(async () => {
    for (const page of Object.keys(PAGE_PARTS) as Array<keyof typeof PAGE_PARTS>) await renderPage(page);
  }, 60_000);

  it.each(Object.keys(PAGE_D1_BUDGETS) as Array<keyof typeof PAGE_D1_BUDGETS>)(
    "%s page stays within its D1 round trips and waves",
    async (page) => {
      const result = await renderPage(page);

      expect(result.statuses.every((status) => status === 200), JSON.stringify(result.statuses)).toBe(true);
      expect(result.validation).toEqual({ roundTrips: 1, waves: 1, firstWave: 1 });
      expect(result.render.firstWave).toBe(2);
      expect({ page, roundTrips: result.render.roundTrips, waves: result.render.waves }).toEqual({
        page,
        roundTrips: Math.min(result.render.roundTrips, PAGE_D1_BUDGETS[page].roundTrips),
        waves: Math.min(result.render.waves, PAGE_D1_BUDGETS[page].waves),
      });
      expect({ roundTrips: result.roundTrips, waves: result.waves }).toEqual({
        roundTrips: result.validation.roundTrips + result.render.roundTrips,
        waves: result.validation.waves + result.render.waves,
      });
      // Every part was stored with its dependency proof.
      expect(result.stored).toEqual(PAGE_PARTS[page].map(() => "miss"));
      process.stdout.write(`[storefront budget] ${page}: render ${result.render.roundTrips} trips/${result.render.waves} waves; validation ${result.validation.roundTrips}/${result.validation.waves}; hit ${result.hit.roundTrips}/${result.hit.waves}\n`);
    },
  );

  it("gives app component sections their products and images from the homepage's batches", async () => {
    const section = (id: string, type: string, values: Record<string, unknown>): StorefrontSection =>
      ({ id, type: "app", version: 1, settings: { app: `acme.shelf/${type}`, values } }) as StorefrontSection;
    const listed = section("noor-products", "shelf", { heading: "New", products: "newest" });
    const picked = section("noor-order", "order", { product: "p_linen" });
    const collected = section("noor-collected", "shelf", { heading: "Best", products: "collection:col_grid" });
    const measure = async (components: StorefrontSection[]) => {
      const result = await renderPage("home", "", { components });
      const apps = (result.bodies[1] as { data: { sections: { apps: Array<{ sectionId: string; component?: { lists: Array<{ source: string; products: unknown[] }> } }> } } }).data.sections.apps;
      expect(result.hit).toEqual({ roundTrips: 1, waves: 1, statuses: PAGE_PARTS.home.map(() => "hit"), sameBodies: true });
      return { apps, render: { roundTrips: result.render.roundTrips, waves: result.render.waves } };
    };
    const plain = await measure([]);
    const one = await measure([listed, picked]);
    expect(one.apps.map((app) => [app.sectionId, app.component?.lists.map((list) => [list.source, list.products.length])])).toEqual([
      ["noor-products", [["newest", 2]]],
      ["noor-order", [["product:p_linen", 1]]],
    ]);
    const two = await measure([listed, picked, collected]);
    expect(two.apps.find((app) => app.sectionId === "noor-collected")?.component?.lists).toEqual([{ source: "collection:col_grid", products: [expect.anything(), expect.anything()] }]);
    // The true cost, measured: the apps' read (beside the second batch) names the sections'
    // schemas, so their images, lists and picked products are one more batch and wave; a
    // collection source reads the collection's rules first, one more again.
    expect(one.render).toEqual({ roundTrips: plain.render.roundTrips + 2, waves: plain.render.waves + 1 });
    expect(two.render).toEqual({ roundTrips: plain.render.roundTrips + 3, waves: plain.render.waves + 2 });
  });

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
