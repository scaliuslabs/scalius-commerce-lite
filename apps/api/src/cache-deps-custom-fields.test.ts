// Custom fields (COMMERCE-HOOKS H4) in the dependency-validated cache: every
// buyer read that carries `customFields` (product with its SKUs, category,
// brand, collection, CMS page) renders through the real routes in a strict
// scope with no coarse fallback, shows only storefront-visible values, and a
// committed value or definition change advances a key the read declared, so
// a cached page refreshes within the frontier window.
import "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { withDependencyScope, type CacheDependencies } from "@scalius/core/cache-deps";
import {
  createCustomFieldDefinition,
  createCustomFieldDefinitionSchema,
  setCustomFieldValues,
  updateCustomFieldDefinition,
} from "@scalius/core/modules/custom-fields";
import { MERCHANT_CUSTOM_FIELD_WRITER, type CustomFieldOwnerType } from "@scalius/shared/custom-fields";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";

const SEED = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
  INSERT INTO brands (id, name, slug, status) VALUES ('brd_walton01', 'Walton', 'walton', 'published');
  INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active) VALUES
    ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_panjabi', 'brd_walton01', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
    ('v_linen', 'p_linen', 'LIN-1', 250000, 5, 0, 1, 1);
  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
    ('media_linen', 'linen.jpg', 'image', 'media/linen.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600),
    ('media_logo', 'walton.png', 'image', 'media/walton.png', 1, 'image/png', 'ready', 400, 400, 400);
  UPDATE brands SET logo_media_id = 'media_logo' WHERE id = 'brd_walton01';
  INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_linen', 'p_linen', 'media_linen', 1, 0);
  INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
    ('col_grid', 'Best sellers', 'grid', '{"source":"manual","productIds":["p_linen"],"maxProducts":8}', 0);
  INSERT INTO pages (id, title, slug, content, is_published) VALUES ('pg_about', 'About', 'about', '<p>x</p>', 1);
  INSERT INTO customers (id, name, phone) VALUES ('cus_a', 'Buyer', '01711000000');
`;

const merchant = { writer: MERCHANT_CUSTOM_FIELD_WRITER };

async function seeded() {
  const { sqlite, db, binding } = createSqliteD1Database();
  sqlite.exec(SEED);
  await rebuildCatalogProjections(db);
  const define = (ownerType: CustomFieldOwnerType, name: string, type: string, storefrontVisible = true) =>
    createCustomFieldDefinition(db, createCustomFieldDefinitionSchema.parse({ ownerType, name, type, storefrontVisible }), merchant);
  const fields = {
    care: await define("product", "Care guide", "multi_line_text"),
    msrp: await define("product", "MSRP", "money"),
    cost: await define("product", "Cost note", "single_line_text", false),
    fit: await define("variant", "Fit", "single_line_text"),
    banner: await define("category", "Banner note", "single_line_text"),
    origin: await define("brand", "Origin", "single_line_text"),
    season: await define("collection", "Season", "list.single_line_text"),
    hero: await define("page", "Hero colour", "color"),
    vip: await define("customer", "VIP", "boolean", false),
  };
  const set = (ownerType: CustomFieldOwnerType, ownerId: string, values: Array<[{ id: string }, unknown]>) =>
    setCustomFieldValues(db, ownerType, ownerId, { values: values.map(([definition, value]) => ({ definitionId: definition.id, value })) }, merchant);
  await set("product", "p_linen", [[fields.care, "Hand wash"], [fields.msrp, { amountMinor: 300000, currency: "BDT" }], [fields.cost, "secret"]]);
  await set("variant", "v_linen", [[fields.fit, "Slim"]]);
  await set("category", "cat_panjabi", [[fields.banner, "Eid edit"]]);
  await set("brand", "brd_walton01", [[fields.origin, "Bangladesh"]]);
  await set("collection", "col_grid", [[fields.season, ["Eid", "Winter"]]]);
  await set("page", "pg_about", [[fields.hero, "#ff0000"]]);
  await set("customer", "cus_a", [[fields.vip, true]]);
  const env = {
    DB: binding,
    JWT_SECRET: "cache-deps-custom-fields-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "cache-deps-custom-fields-credential-key-0123456789",
    STOREFRONT_URL: "https://shop.test",
  } as unknown as Env;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  return { sqlite, db, env, ctx, fields, set };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

async function render(seed: Seeded, url: string): Promise<{ status: number; body: { data: Record<string, unknown> }; dependencies: CacheDependencies }> {
  const { value, dependencies } = await withDependencyScope(async () => {
    const response = await fetchRuntimeApiApp(new Request(`https://api.internal${url}`), seed.env, seed.ctx);
    return { status: response.status, body: await response.json() as { data: Record<string, unknown> } };
  }, { strict: true, label: url, log: () => undefined });
  return { ...value, dependencies };
}

const clock = (seed: Seeded) => (seed.sqlite.prepare("SELECT seq FROM cache_clock").get() as { seq: number }).seq;
const advancedSince = (seed: Seeded, s0: number, keys: readonly string[]) =>
  (seed.sqlite.prepare("SELECT dep FROM cache_dep WHERE seq > ? AND dep IN (SELECT value FROM json_each(?)) ORDER BY dep")
    .all(s0, JSON.stringify(keys)) as Array<{ dep: string }>).map((row) => row.dep);

/** Render, write, render: the response changed and a key the first render declared advanced. */
async function expectRefresh(seed: Seeded, url: string, write: () => Promise<unknown>): Promise<string[]> {
  const s0 = clock(seed);
  const before = await render(seed, url);
  expect(before.status, url).toBe(200);
  await write();
  const after = await render(seed, url);
  expect(JSON.stringify(after.body), `${url} changed`).not.toBe(JSON.stringify(before.body));
  const advanced = advancedSince(seed, s0, before.dependencies.keys);
  expect(advanced, `${url}: a changed response must advance a declared key`).not.toEqual([]);
  return advanced;
}

const READS = [
  ["/api/v1/products/linen-panjabi", "cf:product"],
  ["/api/v1/categories/panjabi", "cf:category"],
  ["/api/v1/categories/panjabi/products", "cf:category"],
  ["/api/v1/brands/walton", "cf:brand"],
  ["/api/v1/brands/walton/products", "cf:brand"],
  ["/api/v1/collections/col_grid", "cf:collection"],
  ["/api/v1/pages/slug/about", "cf:page"],
  ["/api/v1/pages/pg_about", "cf:page"],
  ["/api/v1/storefront/pages/slug/about", "cf:page"],
] as const;

describe("custom fields in buyer reads", () => {
  it("covers every read strictly and declares the owner type's definitions key", async () => {
    const seed = await seeded();
    for (const [url, key] of READS) {
      const { status, dependencies } = await render(seed, url);
      expect(status, url).toBe(200);
      expect(dependencies.coarseTables, url).toEqual([]);
      expect(dependencies.uncacheable, url).toEqual([]);
      expect(dependencies.keys, url).toContain(key);
    }
  });

  it("shows storefront-visible values only, in the wire form", async () => {
    const seed = await seeded();
    const product = (await render(seed, "/api/v1/products/linen-panjabi")).body.data as {
      product: { customFields: unknown[] };
      variants: Array<{ id: string; customFields: unknown[] }>;
    };
    expect(product.product.customFields).toEqual([
      { namespace: "custom", key: "care_guide", name: "Care guide", type: "multi_line_text", value: "Hand wash" },
      { namespace: "custom", key: "msrp", name: "MSRP", type: "money", value: { amountMinor: 300000, currency: "BDT" } },
    ]);
    expect(product.variants.find((variant) => variant.id === "v_linen")?.customFields).toEqual([
      { namespace: "custom", key: "fit", name: "Fit", type: "single_line_text", value: "Slim" },
    ]);
    const category = (await render(seed, "/api/v1/categories/panjabi")).body.data as { category: { customFields: unknown[] } };
    expect(category.category.customFields).toEqual([expect.objectContaining({ key: "banner_note", value: "Eid edit" })]);
    const listing = (await render(seed, "/api/v1/categories/panjabi/products")).body.data as { category: { customFields: unknown[] } };
    expect(listing.category.customFields).toEqual(category.category.customFields);
    const brand = (await render(seed, "/api/v1/brands/walton")).body.data as { brand: { customFields: unknown[] } };
    expect(brand.brand.customFields).toEqual([expect.objectContaining({ key: "origin", value: "Bangladesh" })]);
    const collection = (await render(seed, "/api/v1/collections/col_grid")).body.data as { collection: { customFields: unknown[] } };
    expect(collection.collection.customFields).toEqual([expect.objectContaining({ key: "season", value: ["Eid", "Winter"] })]);
    const page = (await render(seed, "/api/v1/storefront/pages/slug/about")).body.data as { page: { customFields: unknown[] } };
    expect(page.page.customFields).toEqual([expect.objectContaining({ key: "hero_colour", value: "#ff0000" })]);
    for (const [url] of READS) {
      const text = JSON.stringify((await render(seed, url)).body);
      expect(text, url).not.toContain("secret");
      expect(text, url).not.toContain("vip");
    }
  });

  it("refreshes each owner's read when a storefront-visible value changes", async () => {
    const seed = await seeded();
    const { fields, set } = seed;
    expect(await expectRefresh(seed, "/api/v1/products/linen-panjabi", () => set("product", "p_linen", [[fields.care, "Dry clean"]])))
      .toContain("p:p_linen");
    expect(await expectRefresh(seed, "/api/v1/products/linen-panjabi", () => set("variant", "v_linen", [[fields.fit, "Regular"]])))
      .toContain("p:p_linen");
    expect(await expectRefresh(seed, "/api/v1/categories/panjabi/products", () => set("category", "cat_panjabi", [[fields.banner, null]])))
      .toContain("c:*");
    expect(await expectRefresh(seed, "/api/v1/brands/walton", () => set("brand", "brd_walton01", [[fields.origin, "Japan"]])))
      .toContain("b:brd_walton01");
    expect(await expectRefresh(seed, "/api/v1/collections/col_grid", () => set("collection", "col_grid", [[fields.season, ["Summer"]]])))
      .toContain("col:col_grid");
    expect(await expectRefresh(seed, "/api/v1/storefront/pages/slug/about", () => set("page", "pg_about", [[fields.hero, "#00ff00"]])))
      .toContain("pg:pg_about");
  });

  it("refreshes reads when a visible definition is renamed or hidden, and not for hidden values", async () => {
    const seed = await seeded();
    const { db, fields, set } = seed;
    expect(await expectRefresh(seed, "/api/v1/products/linen-panjabi", () =>
      updateCustomFieldDefinition(db, fields.care.id, { expectedRevision: fields.care.revision, name: "Care" }, merchant)))
      .toContain("cf:product");
    expect(await expectRefresh(seed, "/api/v1/products/linen-panjabi", () =>
      updateCustomFieldDefinition(db, fields.msrp.id, { expectedRevision: fields.msrp.revision, storefrontVisible: false }, merchant)))
      .toContain("cf:product");
    // A hidden value is not a buyer fact: nothing the product page declared moves.
    const s0 = clock(seed);
    const before = await render(seed, "/api/v1/products/linen-panjabi");
    await set("product", "p_linen", [[fields.cost, "another secret"]]);
    expect(advancedSince(seed, s0, before.dependencies.keys)).toEqual([]);
  });
});
