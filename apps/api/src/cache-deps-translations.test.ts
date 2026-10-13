// Translations in the dependency-validated cache (MARKETS-DESIGN D9, "Step 4b
// implemented"). A presence's reads fold the translations of its language;
// a root read folds none and keeps its bytes. A translation edit advances
// only its resource's `tr:<type>:<id>`, so the root and the presences of
// other languages stay cached; a handle lookup that may name another
// resource declares the type's handle space.
import "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
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
  INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active');
  INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in');
  INSERT INTO store_languages (locale, published) VALUES ('bn', 1), ('fr', 0);
  INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES
    ('mkp_en', 'mkt_in', 'subfolder', 'en-in', 'en'), ('mkp_bn', 'mkt_in', 'subfolder', 'bn-in', 'bn');
  INSERT INTO products (id, name, description, price_minor, slug, is_active) VALUES
    ('p_tee', 'Tee', '<p>Cotton tee.</p>', 50000, 'tee', 1),
    ('p_cap', 'Cap', NULL, 20000, 'cap', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
    ('v_tee', 'p_tee', 'TEE-1', 50000, 5, 0, 1, 1),
    ('v_cap', 'p_cap', 'CAP-1', 20000, 5, 0, 1, 1);
  INSERT INTO translations (id, resource_type, resource_id, locale, market_id, fields) VALUES
    ('tr_tee_bn', 'product', 'p_tee', 'bn', NULL, '{"name":"টি-শার্ট"}'),
    ('tr_cap_bn', 'product', 'p_cap', 'bn', NULL, '{"name":"টুপি"}'),
    ('tr_tee_fr', 'product', 'p_tee', 'fr', NULL, '{"name":"T-shirt"}');
  INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'ti-shirt', 'p_tee');
`;

interface ProductPage {
  data?: { product?: { id: string; name: string; slug: string; description: string | null; localizedSlugs?: Record<string, string>; sourceSlug?: string } };
}

async function store() {
  const { sqlite, binding } = createSqliteD1Database();
  const env = {
    DB: binding,
    CF_VERSION_METADATA: { id: "translations-version", tag: "", timestamp: "" },
    JWT_SECRET: "translations-dvc-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "translations-dvc-credential-key-0123456789abcdef",
  } as unknown as Env;
  sqlite.exec(SEED);
  await rebuildCatalogProjections(getDb(env));
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

describe("translations in the dependency-validated cache", () => {
  it("folds a presence's language, keeps the root's bytes and reaches a page by any of its handles", async () => {
    const { read } = await store();
    const root = await read<ProductPage>("/api/v1/products/tee");
    expect(root.body.data?.product).toMatchObject({ name: "Tee", slug: "tee", localizedSlugs: { bn: "ti-shirt" }, sourceSlug: "tee" });
    // The default language's presence has nothing to fold: the root's bytes.
    expect((await read("/api/v1/products/tee?presence=en-in")).text).toBe(root.text);

    const bangla = await read<ProductPage>("/api/v1/products/tee?presence=bn-in");
    // A translated field, its localized handle, and an untranslated field from the source.
    expect(bangla.body.data?.product).toMatchObject({ name: "টি-শার্ট", slug: "ti-shirt", description: "<p>Cotton tee.</p>" });
    expect((await read<ProductPage>("/api/v1/products/ti-shirt?presence=bn-in")).text).toBe(bangla.text);
    // A buyer who switches language on a localized URL still reaches the page.
    expect((await read<ProductPage>("/api/v1/products/ti-shirt")).body.data?.product?.name).toBe("Tee");
    expect((await read<ProductPage>("/api/v1/products/ti-shirt?presence=en-in")).body.data?.product?.slug).toBe("tee");

    const cards = await read<{ data?: { products?: Array<{ id: string; name: string }> } }>("/api/v1/products?presence=bn-in&sort=name-asc");
    expect(cards.body.data?.products?.map((card) => card.name).sort()).toEqual(["টি-শার্ট", "টুপি"]);
  });

  it("advances only the edited resource's reads", async () => {
    const { read, sqlite } = await store();
    const paths = ["/api/v1/products/tee", "/api/v1/products/cap", "/api/v1/products/tee?presence=bn-in", "/api/v1/products/cap?presence=bn-in"];
    for (const path of paths) {
      await read(path);
      expect((await read(path)).cache, path).toBe("hit");
    }

    sqlite.exec(`UPDATE translations SET fields = '{"name":"নতুন টি-শার্ট"}' WHERE id = 'tr_tee_bn'`);
    const edited = await read<ProductPage>("/api/v1/products/tee?presence=bn-in");
    expect(edited.cache).not.toBe("hit");
    expect(edited.body.data?.product?.name).toBe("নতুন টি-শার্ট");
    // The cap's Bangla page recommends the tee by its Bangla name: it reads again.
    expect((await read("/api/v1/products/cap?presence=bn-in")).cache).not.toBe("hit");
    // The root cap page shows the tee by its source name: still valid.
    expect((await read("/api/v1/products/cap")).cache).toBe("hit");
    // The root tee page depends on the tee's handles (`tr:handles:product:p_tee`), not its text.
    expect((await read("/api/v1/products/tee")).cache).toBe("hit");
    // A handle edit reaches it: its alternates change.
    sqlite.exec("UPDATE localized_slugs SET slug = 'ti-shirt-2' WHERE resource_id = 'p_tee'");
    const rootTee = await read<ProductPage>("/api/v1/products/tee");
    expect(rootTee.cache).not.toBe("hit");
    expect(rootTee.body.data?.product?.localizedSlugs).toEqual({ bn: "ti-shirt-2" });

    // A draft language's translation changes no root bytes.
    const rootBefore = await read("/api/v1/products/cap");
    sqlite.exec(`INSERT INTO translations (id, resource_type, resource_id, locale, fields) VALUES ('tr_cap_fr', 'product', 'p_cap', 'fr', '{"name":"Casquette"}')`);
    expect((await read("/api/v1/products/cap")).text).toBe(rootBefore.text);
  });

  it("serves an unpublished language's presence no more, and a new handle at once", async () => {
    const { read, sqlite } = await store();
    expect((await read("/api/v1/products/cap?presence=bn-in")).status).toBe(200);
    expect((await read("/api/v1/products/tupi?presence=bn-in")).status).toBe(404);

    sqlite.exec("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'tupi', 'p_cap')");
    const byHandle = await read<ProductPage>("/api/v1/products/tupi?presence=bn-in");
    expect(byHandle.status).toBe(200);
    expect(byHandle.body.data?.product).toMatchObject({ id: "p_cap", name: "টুপি", slug: "tupi" });

    sqlite.exec("UPDATE store_languages SET published = 0 WHERE locale = 'bn'");
    expect((await read("/api/v1/products/cap?presence=bn-in")).status).toBe(404);
  });

  it("serves a published language at its subfolder of the backup market (`/bn`), at the root's prices, until it is unpublished", async () => {
    const { read, sqlite } = await store();
    const root = await read<ProductPage & { data?: { product?: { price?: number } } }>("/api/v1/products/tee");
    const bangla = await read<ProductPage & { data?: { product?: { price?: number } } }>("/api/v1/products/tee?presence=bn");
    expect(bangla.body.data?.product).toMatchObject({ name: "টি-শার্ট", slug: "ti-shirt", description: "<p>Cotton tee.</p>" });
    expect(bangla.body.data?.product?.price).toBe(root.body.data?.product?.price);
    expect((await read("/api/v1/products/tee?presence=bn")).cache).toBe("hit");
    // A draft language has no subfolder: its translations never leak through the shape.
    expect((await read("/api/v1/products/tee?presence=fr")).status).toBe(404);
    // The default language is the root's alone.
    expect((await read("/api/v1/products/tee?presence=en")).status).toBe(404);

    sqlite.exec("UPDATE store_languages SET published = 0 WHERE locale = 'bn'");
    expect((await read("/api/v1/products/tee?presence=bn")).status).toBe(404);
  });

  it("refuses a localized handle that another resource uses as its own", async () => {
    const { sqlite } = await store();
    expect(() => sqlite.exec("INSERT INTO localized_slugs (resource_type, locale, slug, resource_id) VALUES ('product', 'bn', 'cap', 'p_tee')"))
      .toThrow(/LOCALIZED_SLUG_TAKEN/);
    expect(() => sqlite.exec("UPDATE products SET slug = 'ti-shirt' WHERE id = 'p_cap'")).toThrow(/LOCALIZED_SLUG_TAKEN/);
  });
});
