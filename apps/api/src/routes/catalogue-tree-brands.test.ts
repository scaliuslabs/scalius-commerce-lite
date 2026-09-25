// Public tree and brand routes end to end on the catalog runtime (node:sqlite D1).
import "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import publicCatalogApp from "../runtime/public-catalog-app";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";

const SEED = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_electronics', 'Electronics', 'electronics', 'published');
  INSERT INTO categories (id, name, slug, status, parent_id) VALUES
    ('cat_phones', 'Phones', 'phones', 'published', 'cat_electronics'),
    ('cat_drafts', 'Drafts', 'drafts', 'draft', 'cat_electronics');
  INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_android', 'Android', 'android', 'published', 'cat_phones');
  INSERT INTO brands (id, name, slug, status) VALUES
    ('brd_walton01', 'Walton', 'walton', 'published'),
    ('brd_draft001', 'Draft', 'draft-brand', 'draft');
  INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active, created_at) VALUES
    ('prod_root', 'Root item', 100000, 'root-item', 'cat_electronics', NULL, 1, 1700000003),
    ('prod_leaf', 'Walton phone', 200000, 'walton-phone', 'cat_android', 'brd_walton01', 1, 1700000002);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES
    ('var_root', 'prod_root', 'SKU-ROOT', 100000, 3, 1, 1),
    ('var_leaf', 'prod_leaf', 'SKU-LEAF', 200000, 3, 1, 1);
`;

async function request(path: string) {
  const { sqlite, binding, db } = createSqliteD1Database();
  sqlite.exec(SEED);
  // Seeded with raw SQL: fill the stored buyer state as a release does.
  await rebuildCatalogProjections(db);
  return publicCatalogApp.request(`https://api.example.test/api/v1${path}`, {}, {
    DB: binding,
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
  } as unknown as Env);
}

async function data(path: string) {
  const response = await request(path);
  expect(response.status, path).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

describe("public category tree routes", () => {
  it("serves the published tree, children, breadcrumb and tree context", async () => {
    const tree = await data("/categories/tree") as { nodes: Array<{ id: string; parentId: string | null }>; truncated: boolean };
    expect(tree.nodes.map((node) => [node.id, node.parentId])).toEqual([
      ["cat_electronics", null],
      ["cat_phones", "cat_electronics"],
      ["cat_android", "cat_phones"],
    ]);
    expect(tree.truncated).toBe(false);

    const { children } = await data("/categories/electronics/children") as { children: Array<{ id: string }> };
    expect(children.map((child) => child.id)).toEqual(["cat_phones"]);
    const { breadcrumb } = await data("/categories/android/breadcrumb") as { breadcrumb: Array<{ id: string }> };
    expect(breadcrumb.map((item) => item.id)).toEqual(["cat_electronics", "cat_phones", "cat_android"]);
    expect((await request("/categories/drafts/breadcrumb")).status).toBe(404);
    expect((await request("/categories/drafts/children")).status).toBe(404);
  });

  it("lists a category's published subtree by default and only its own products on request", async () => {
    const subtree = await data("/categories/electronics/products") as {
      products: Array<{ id: string; category: { id: string } | null }>;
      category: { children: Array<{ id: string }>; breadcrumb: Array<{ id: string }> };
    };
    expect(subtree.products.map((product) => [product.id, product.category?.id])).toEqual([
      ["prod_root", "cat_electronics"],
      ["prod_leaf", "cat_android"],
    ]);
    expect(subtree.category.children.map((child) => child.id)).toEqual(["cat_phones"]);
    expect(subtree.category.breadcrumb.map((item) => item.id)).toEqual(["cat_electronics"]);

    const own = await data("/categories/electronics/products?includeSubcategories=false") as { products: Array<{ id: string }> };
    expect(own.products.map((product) => product.id)).toEqual(["prod_root"]);
  });
});

describe("public brand routes", () => {
  it("serves published brands, their products and sitemap entries; drafts are 404s", async () => {
    const list = await data("/brands") as { brands: Array<{ slug: string }> };
    expect(list.brands.map((brand) => brand.slug)).toEqual(["walton"]);
    const { brand } = await data("/brands/walton") as { brand: { id: string; logo: unknown } };
    expect(brand).toMatchObject({ id: "brd_walton01", logo: null });
    const listing = await data("/brands/walton/products") as { products: Array<{ id: string }>; brand: { slug: string } };
    expect(listing.products.map((product) => product.id)).toEqual(["prod_leaf"]);
    expect(listing.brand.slug).toBe("walton");
    const sitemap = await data("/brands/sitemap") as { brands: Array<{ slug: string }> };
    expect(sitemap.brands.map((entry) => entry.slug)).toEqual(["walton"]);

    expect((await request("/brands/draft-brand")).status).toBe(404);
    expect((await request("/brands/draft-brand/products")).status).toBe(404);
  });

  it("puts the published brand on the product page read", async () => {
    const page = await data("/products/walton-phone") as { product: { brand: unknown } };
    expect(page.product.brand).toEqual({ id: "brd_walton01", name: "Walton", slug: "walton", canonicalPath: null });
    const unbranded = await data("/products/root-item") as { product: { brand: unknown } };
    expect(unbranded.product.brand).toBeNull();
  });
});
