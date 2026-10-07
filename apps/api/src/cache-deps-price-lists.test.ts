// Price lists and FX-derived prices in the dependency-validated cache
// (MARKETS-DESIGN D5, "Step 4a implemented"). A presence's catalogue reads
// are market-keyed: a market that prices like the backup market answers the
// root's bytes; an FX market or a live price list prices the presence's
// cards, product page and feed. A market's pricing and its active public
// lists advance only `pl:<market>`, their prices only `pl:<market>:<product>`,
// so the root catalogue and other markets stay cached; a list's schedule
// bounds the entry's validity.
import "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { createPublicPartReader, renderPublicRead } from "./public-read";

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

const SEED = `
  INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active'), ('mkt_np', 'nepal', 'Nepal', 'active');
  INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in'), ('NP', 'mkt_np');
  INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES
    ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en'), ('mkp_np', 'mkt_np', 'subfolder', 'ne-np', 'ne');
  INSERT INTO products (id, name, price_minor, slug, is_active, discount_type, discount_bps) VALUES
    ('p_tee', 'Tee', 50000, 'tee', 1, 'percentage', 1000),
    ('p_cap', 'Cap', 20000, 'cap', 1, NULL, 0);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
    ('v_tee', 'p_tee', 'TEE-1', 50000, 5, 0, 1, 1),
    ('v_cap', 'p_cap', 'CAP-1', 20000, 5, 0, 1, 1);
`;

interface ProductPage {
  data?: {
    product?: { price: number; discountedPrice: number; discountType: string | null; discountAmount: number };
    variants?: Array<{ price: number; discountType: string | null; discountAmount: number; discountPercentage: number }>;
  };
}

interface Listing {
  data?: { products?: Array<{ id: string; price: number; discountedPrice: number }>; priceRange?: { min: number; max: number } };
}

async function store() {
  const { sqlite, binding, db } = createSqliteD1Database();
  sqlite.exec(SEED);
  await rebuildCatalogProjections(db);
  const env = {
    DB: binding,
    CF_VERSION_METADATA: { id: "price-lists-version", tag: "", timestamp: "" },
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    JWT_SECRET: "price-lists-dvc-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "price-lists-dvc-credential-key-0123456789abcdef",
  } as unknown as Env;
  const cache = new MemoryCache();
  const read = async <T = Record<string, unknown>>(path: string) => {
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
    const [settled] = await reader.readParts([new Request(`https://api.internal${path}`)], null);
    if (settled!.status === "rejected") throw settled!.reason;
    const text = await settled!.value.response.clone().text();
    await Promise.all(waits);
    return {
      status: settled!.value.response.status,
      cache: settled!.value.cache?.status ?? null,
      text,
      body: (text ? JSON.parse(text) : null) as T,
    };
  };
  return { sqlite, read };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("price lists and FX in the dependency-validated cache", () => {
  it("answers the root's bytes for a market that prices like the backup market", async () => {
    const { read } = await store();
    for (const path of ["/api/v1/products/tee", "/api/v1/products?limit=10", "/api/v1/products/feed?limit=10", "/api/v1/products/compare?ids=p_tee,p_cap"]) {
      const root = await read(path);
      const india = await read(`${path}${path.includes("?") ? "&" : "?"}presence=en-in`);
      expect(india.status, path).toBe(200);
      expect(india.text, path).toBe(root.text);
    }
    // An unknown presence is not a market.
    expect((await read("/api/v1/products/tee?presence=fr-fr")).status).toBe(404);
  });

  it("derives an FX market's prices from the base prices and keeps the root and other markets cached", async () => {
    const { read, sqlite } = await store();
    await read("/api/v1/products/tee");
    await read("/api/v1/products/tee?presence=ne-np");
    const before = await read<ProductPage>("/api/v1/products/tee?presence=en-in");
    expect(before.body.data?.product?.discountedPrice).toBe(450);

    // +10 %, rounded up to 10 taka, ending in 9 taka.
    sqlite.exec("UPDATE markets SET price_mode = 'fx', price_adjustment_bps = 1000, price_rounding_minor = 1000, price_ending_minor = 900 WHERE id = 'mkt_in'");
    const india = await read<ProductPage>("/api/v1/products/tee?presence=en-in");
    expect(india.cache).not.toBe("hit");
    // 500 → 550 → 549 (compare-at) and 450 → 495 → 500 → 499.
    expect(india.body.data?.variants?.[0]).toMatchObject({ price: 549, discountType: "flat", discountAmount: 50, discountPercentage: 0 });
    expect(india.body.data?.product).toMatchObject({ price: 549, discountedPrice: 499 });
    expect((await read("/api/v1/products/tee")).cache).toBe("hit");
    expect((await read("/api/v1/products/tee?presence=ne-np")).cache).toBe("hit");

    const listing = await read<Listing>("/api/v1/products?presence=en-in&sort=price-asc");
    expect(listing.body.data?.products?.map((product) => [product.id, product.discountedPrice])).toEqual([["p_cap", 219], ["p_tee", 499]]);
    expect(listing.body.data?.priceRange).toEqual({ min: 219, max: 499 });
    // A price filter is in the market's prices: at most 230 is the cap alone.
    const filtered = await read<Listing>("/api/v1/products?presence=en-in&maxPrice=230");
    expect(filtered.body.data?.products?.map((product) => product.id)).toEqual(["p_cap"]);
  });

  it("prices a presence from its live list and invalidates only what a price edit touches", async () => {
    const { read, sqlite } = await store();
    sqlite.exec(`
      INSERT INTO price_lists (id, name, kind, market_id, status) VALUES ('pl_india', 'India', 'market', 'mkt_in', 'active');
      INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor, compare_at_minor) VALUES ('pl_india', 'v_tee', 'BDT', 42000, 52000);
    `);
    const india = await read<ProductPage>("/api/v1/products/tee?presence=en-in");
    expect(india.body.data?.variants?.[0]).toMatchObject({ price: 520, discountType: "flat", discountAmount: 100 });
    expect(india.body.data?.product).toMatchObject({ price: 520, discountedPrice: 420 });
    const cap = await read<ProductPage>("/api/v1/products/cap?presence=en-in");
    expect(cap.body.data?.product?.discountedPrice).toBe(200);
    await read("/api/v1/products/cap");
    const root = await read<ProductPage>("/api/v1/products/tee");
    expect(root.body.data?.product?.discountedPrice).toBe(450);
    const nepal = await read<ProductPage>("/api/v1/products/tee?presence=ne-np");
    expect(nepal.text).toBe(root.text);
    const listing = await read<Listing>("/api/v1/products?presence=en-in");
    expect(listing.body.data?.products?.find((product) => product.id === "p_tee")?.discountedPrice).toBe(420);

    // A price edit reaches the product's reads in that market only.
    sqlite.exec("UPDATE price_list_prices SET amount_minor = 41000 WHERE variant_id = 'v_tee'");
    const edited = await read<ProductPage>("/api/v1/products/tee?presence=en-in");
    expect(edited.cache).not.toBe("hit");
    expect(edited.body.data?.product?.discountedPrice).toBe(410);
    // The cap's page recommends the tee, priced in the market: it reads again too.
    expect((await read("/api/v1/products/cap?presence=en-in")).cache).not.toBe("hit");
    expect((await read("/api/v1/products/cap")).cache).toBe("hit");
    expect((await read("/api/v1/products/tee")).cache).toBe("hit");
    expect((await read("/api/v1/products/tee?presence=ne-np")).cache).toBe("hit");
    expect((await read("/api/v1/products?presence=en-in")).cache).not.toBe("hit");

    // A draft list and a segment list are never public.
    sqlite.exec(`
      INSERT INTO customer_segments (id, name, definition) VALUES ('seg_vip001', 'VIP', '{"version":1,"match":"all","conditions":[]}');
      INSERT INTO price_lists (id, name, kind, market_id, segment_id, status) VALUES ('pl_vip01', 'VIP', 'segment', 'mkt_in', 'seg_vip001', 'active');
      INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_draft', 'Draft', 'sale', 'mkt_in');
      INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_vip01', 'v_tee', 'BDT', 30000), ('pl_draft', 'v_tee', 'BDT', 10000);
    `);
    const unchanged = await read<ProductPage>("/api/v1/products/tee?presence=en-in");
    expect(unchanged.cache).toBe("hit");
    expect(unchanged.body.data?.product?.discountedPrice).toBe(410);

    // Activating the sale list wins over the market list (sale > market).
    sqlite.exec("UPDATE price_lists SET status = 'active' WHERE id = 'pl_draft'");
    const sale = await read<ProductPage>("/api/v1/products/tee?presence=en-in");
    expect(sale.cache).not.toBe("hit");
    expect(sale.body.data?.product).toMatchObject({ discountedPrice: 100, price: 410 });
    expect((await read("/api/v1/products/tee")).cache).toBe("hit");
  });

  it("is valid only until a list's schedule starts or ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-07T10:00:00Z");
    vi.setSystemTime(start);
    const { read, sqlite } = await store();
    const startsAt = Math.floor(start.getTime() / 1000) + 3600;
    sqlite.exec(`
      INSERT INTO price_lists (id, name, kind, market_id, status, starts_at, ends_at) VALUES ('pl_sale1', 'Sale', 'sale', 'mkt_in', 'active', ${startsAt}, ${startsAt + 3600});
      INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_sale1', 'v_cap', 'BDT', 15000);
    `);
    expect((await read<ProductPage>("/api/v1/products/cap?presence=en-in")).body.data?.product?.discountedPrice).toBe(200);
    expect((await read("/api/v1/products/cap?presence=en-in")).cache).toBe("hit");
    vi.setSystemTime(new Date((startsAt + 1) * 1000));
    const during = await read<ProductPage>("/api/v1/products/cap?presence=en-in");
    expect(during.cache).not.toBe("hit");
    expect(during.body.data?.product).toMatchObject({ discountedPrice: 150, price: 200 });
    vi.setSystemTime(new Date((startsAt + 3601) * 1000));
    const after = await read<ProductPage>("/api/v1/products/cap?presence=en-in");
    expect(after.cache).not.toBe("hit");
    expect(after.body.data?.product?.discountedPrice).toBe(200);
  });
});
