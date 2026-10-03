// The market dimension of the dependency-validated cache (MARKETS-DESIGN D4).
// A market-keyed read (`PUBLIC_API_CACHE_ROUTES`) carries the page's presence
// in its cache key and depends on its own market alone, so a change to one
// market never invalidates another market's entries and never touches the
// market-invariant catalogue; the backup market's price increment advances
// only the reads that price in the shop currency. A market-invariant route
// cannot read a market at all.
import "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getDb } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { createPublicPartReader, renderPublicRead } from "./public-read";
import { MarketInvariantRouteError, publicMarketPresence } from "./utils/public-market";

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
  INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_tee', 'Tee', 50000, 'tee', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
    VALUES ('v_tee', 'p_tee', 'TEE-1', 50000, 5, 0, 1, 1);
`;

async function store() {
  const { sqlite, binding, db } = createSqliteD1Database();
  sqlite.exec(SEED);
  await rebuildCatalogProjections(db);
  const env = {
    DB: binding,
    CF_VERSION_METADATA: { id: "markets-version", tag: "", timestamp: "" },
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    JWT_SECRET: "markets-dvc-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "markets-dvc-credential-key-0123456789abcdef",
  } as unknown as Env;
  const cache = new MemoryCache();
  const read = async (path: string) => {
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
    const body = await settled!.value.response.clone().json().catch(() => null) as { data?: Record<string, unknown> } | null;
    await Promise.all(waits);
    return { status: settled!.value.response.status, cache: settled!.value.cache?.status ?? null, body };
  };
  return { sqlite, read, cache };
}

describe("market-keyed public reads", () => {
  it("render the page's market, keyed by its presence, and 404 an inactive or unknown presence", async () => {
    const { read, sqlite, cache } = await store();
    const root = await read("/api/v1/checkout/config");
    const india = await read("/api/v1/checkout/config?presence=en-in");
    expect(root).toMatchObject({ status: 200, cache: "miss" });
    expect(root.body?.data?.market).toEqual({ id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", locale: "en" });
    expect(india.body?.data?.market).toEqual({ id: "mkt_in", handle: "india", name: "India", locale: "en" });
    // Two entries: the presence is part of the key.
    expect([...cache.entries.keys()].filter((key) => key.includes("/checkout/config"))).toHaveLength(2);
    expect((await read("/api/v1/checkout/config?presence=fr-fr")).status).toBe(404);
    expect((await read("/api/v1/checkout/config?presence=../x")).status).toBe(404);
    sqlite.exec("UPDATE markets SET status = 'draft' WHERE id = 'mkt_np'");
    expect((await read("/api/v1/checkout/config?presence=ne-np")).status).toBe(404);
  });

  it("invalidate only the market that changed", async () => {
    const { read, sqlite } = await store();
    await read("/api/v1/checkout/config");
    await read("/api/v1/checkout/config?presence=en-in");
    await read("/api/v1/checkout/config?presence=ne-np");
    await read("/api/v1/products/tee");
    expect((await read("/api/v1/checkout/config?presence=en-in")).cache).toBe("hit");

    sqlite.exec("UPDATE markets SET name = 'India store' WHERE id = 'mkt_in'");
    const india = await read("/api/v1/checkout/config?presence=en-in");
    expect(india.cache).not.toBe("hit");
    expect((india.body?.data?.market as { name: string }).name).toBe("India store");
    expect((await read("/api/v1/checkout/config?presence=ne-np")).cache).toBe("hit");
    expect((await read("/api/v1/checkout/config")).cache).toBe("hit");
    // The catalogue never depends on a market's identity, countries or presences.
    sqlite.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('LK', 'mkt_in')");
    sqlite.exec("UPDATE market_presences SET locale = 'bn' WHERE id = 'mkp_backup_root'");
    expect((await read("/api/v1/products/tee")).cache).toBe("hit");
    expect((await read("/api/v1/checkout/config?presence=ne-np")).cache).toBe("hit");
    // The root's presence is the backup market's.
    const root = await read("/api/v1/checkout/config");
    expect(root.cache).not.toBe("hit");
    expect((root.body?.data?.market as { locale: string }).locale).toBe("bn");

    // The backup market's price increment prices the catalogue: it invalidates the product.
    sqlite.exec("UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_backup'");
    expect((await read("/api/v1/products/tee")).cache).not.toBe("hit");
  });

  it("refuses a market to a market-invariant route", async () => {
    const app = new OpenAPIHono();
    app.get("/api/v1/products/:slug", async (c) => {
      try {
        publicMarketPresence(c);
        return c.text("read");
      } catch (error) {
        return c.text(error instanceof MarketInvariantRouteError ? "refused" : "other");
      }
    });
    expect(await (await app.request("https://api.internal/api/v1/products/tee?presence=en-in")).text()).toBe("refused");
  });
});
