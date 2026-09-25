/**
 * Facet counts at catalogue scale equal brute force (opt-in, local only).
 *
 * Opens a COPY of a D1 SQLite file seeded by `scripts/catalog-scale-seed.mjs`
 * (30k products, ~83k SKUs), types it the way a merchant would (brand
 * entities from the seeded Brand attribute, a small category tree, "Display
 * Size" converted to a number with a unit, "RAM" and "Warranty" to enums
 * through the real conversion, one category attribute set), fills the
 * catalogue projections, then compares every listing facet, value count,
 * range and total from `catalog/facets.ts` with counts computed in memory
 * straight from the source tables (live public eligibility, attribute rows,
 * live SKU option rows, published brands).
 *
 *   cp <state>/v3/d1/miniflare-D1DatabaseObject/<id>.sqlite /tmp/catalog-1b/facets.sqlite
 *   CATALOG_FACETS_SQLITE=/tmp/catalog-1b/facets.sqlite \
 *   CATALOG_FACETS_OUT=/tmp/catalog-1b/facets-report.json \
 *   pnpm --dir packages/core exec vitest run src/modules/catalog/facets-scale.local.test.ts --maxWorkers=1
 *
 * The file is written to (typing, projections): never point it at a shared
 * or remote database.
 */
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Binding } from "@scalius/database/testing/sqlite-d1";
import {
  canonicalAttributeNumber,
  normalizeAttributeValue,
} from "@scalius/shared/catalog-attributes";
import {
  catalogProjectionRefreshStatements,
  rebuildCatalogProjections,
  selectLiveCatalogBuyerState,
} from "../products";
import { convertAttributeValueType } from "../attributes";
import {
  getStorefrontBrandProducts,
  getStorefrontCategoryProducts,
  resolvePublicAttributeFilters,
  type PublicProductFacet,
} from ".";

const SQLITE = process.env.CATALOG_FACETS_SQLITE;
const OUT = process.env.CATALOG_FACETS_OUT;
const VALUE_CAP = 100;
const BRAND_VALUE_CAP = 500;

type Query = Record<string, string[]>;
type ProductFacts = {
  attributes: Map<string, { key: string; number: number | null }>;
  skus: Array<Map<string, string>>;
  brandId: string | null;
};
type Scope = { name: string; productIds: string[]; category?: { id: string; subtree: boolean; setAttributeIds?: Set<string> }; brandId?: string };

let db: Database;
let sqlite: DatabaseSync;
const facts = new Map<string, ProductFacts>();
const attributeMeta = new Map<string, { slug: string; type: string; display: string }>();
const urlValue = new Map<string, string>();
const brandSlugs = new Map<string, string>();
/** Published, live categories (id to slug), every category's parent, and each product's category. */
const categorySlugs = new Map<string, string>();
const categoryParents = new Map<string, string | null>();
const productCategory = new Map<string, string | null>();
const report: Array<Record<string, unknown>> = [];

const slugify = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function all<T>(query: string, ...params: Array<string | number>): T[] {
  return sqlite.prepare(query).all(...params) as T[];
}

/** Merchant typing on the raw seed: brands, a tree, typed attributes, a category set. */
async function typeTheSeed(): Promise<{ laptop: string; children: string[]; setCategory: string }> {
  const refresh = (ids: readonly string[]) => catalogProjectionRefreshStatements(db, ids);
  if (all<{ n: number }>("SELECT count(*) AS n FROM brands")[0]!.n === 0) {
    const values = all<{ value: string }>("SELECT DISTINCT value FROM product_attribute_values WHERE attribute_id = 'attr_scale_brand' ORDER BY value");
    const insert = sqlite.prepare("INSERT INTO brands (id, name, slug, status) VALUES (?, ?, ?, ?)");
    values.forEach(({ value }, index) => insert.run(`brd_scale_${String(index).padStart(4, "0")}`, value, slugify(value) || `brand-${index}`, index % 25 === 7 ? "draft" : "published"));
    sqlite.exec(`
      UPDATE products SET brand_id = (
        SELECT b.id FROM product_attribute_values v JOIN brands b ON b.name = v.value
        WHERE v.product_id = products.id AND v.attribute_id = 'attr_scale_brand'
      );
      UPDATE product_attributes SET slug = 'maker', name = 'Maker' WHERE id = 'attr_scale_brand';
    `);
  }
  const [laptop] = all<{ id: string }>(`SELECT category_id AS id FROM products WHERE category_id IS NOT NULL
    GROUP BY category_id ORDER BY count(*) DESC LIMIT 1`);
  const children = all<{ id: string }>(`SELECT c.id FROM categories c WHERE c.status = 'published' AND c.deleted_at IS NULL
    AND c.id <> ? AND c.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id)
    ORDER BY c.id LIMIT 3`, laptop!.id).map((row) => row.id);
  for (const child of children) sqlite.prepare("UPDATE categories SET parent_id = ? WHERE id = ? AND parent_id IS NULL").run(laptop!.id, child);
  const [setCategory] = all<{ id: string }>(`SELECT p.category_id AS id FROM products p JOIN categories c ON c.id = p.category_id
    WHERE c.status = 'published' AND c.id NOT IN (${[laptop!.id, ...children].map(() => "?").join(",")})
    GROUP BY p.category_id ORDER BY count(*) DESC LIMIT 1 OFFSET 3`, laptop!.id, ...children);

  const attributeId = (name: string) => all<{ id: string; valueType: string }>("SELECT id, value_type AS valueType FROM product_attributes WHERE name = ?", name)[0]!;
  const conversions: Array<[string, "number" | "enum", Record<string, unknown>]> = [
    ["Display Size", "number", { unit: "inch", facetDisplay: "range" }],
    ["RAM", "enum", { facetDisplay: "checkbox" }],
    ["Warranty", "enum", { facetDisplay: "search_list" }],
  ];
  for (const [name, valueType, extra] of conversions) {
    const attribute = attributeId(name);
    if (attribute.valueType === valueType) continue;
    const started = performance.now();
    const result = await convertAttributeValueType(db, { attributeId: attribute.id, valueType, ...extra }, refresh);
    report.push({ step: `convert ${name} -> ${valueType}`, ms: Math.round(performance.now() - started), rows: result.rows, converted: result.converted, newValues: result.newValues });
  }
  sqlite.exec(`UPDATE product_attributes SET filterable = 1 WHERE name IN ('Display Size', 'RAM', 'Warranty')`);
  const ram = attributeId("RAM").id;
  sqlite.prepare("UPDATE attribute_values SET swatch_hex = '#112233' WHERE attribute_id = ? AND normalized_value = '8gb'").run(ram);
  const set = [attributeId("Warranty").id, ram, attributeId("Processor").id];
  sqlite.prepare("DELETE FROM category_attribute_sets WHERE category_id = ?").run(setCategory!.id);
  set.forEach((id, index) => sqlite.prepare("INSERT INTO category_attribute_sets (category_id, attribute_id, sort_order) VALUES (?, ?, ?)").run(setCategory!.id, id, index));

  const started = performance.now();
  let cursor: string | null = null;
  for (;;) {
    const chunk = await rebuildCatalogProjections(db, { afterProductId: cursor, limit: 2_700 });
    if (chunk.done) break;
    cursor = chunk.nextAfterProductId;
  }
  report.push({ step: "rebuild projections", ms: Math.round(performance.now() - started) });
  return { laptop: laptop!.id, children, setCategory: setCategory!.id };
}

/** Everything the brute force counts, read from the sources (not the projections). */
async function loadFacts(): Promise<Map<string, { isPublic: boolean; categoryId: string | null; brandId: string | null }>> {
  const live = await selectLiveCatalogBuyerState(db, sql`1 = 1`).all();
  const state = new Map(live.map((row) => [row.productId, {
    isPublic: Number(row.isPublic) === 1,
    categoryId: row.categoryId,
    brandId: row.brandId,
  }]));
  for (const row of all<{ id: string; slug: string }>("SELECT id, slug FROM brands WHERE status = 'published' AND deleted_at IS NULL")) {
    brandSlugs.set(row.id, row.slug);
  }
  for (const row of all<{ id: string; slug: string; parentId: string | null; live: number }>(`SELECT id, slug, parent_id AS parentId,
    (status = 'published' AND deleted_at IS NULL) AS live FROM categories`)) {
    categoryParents.set(row.id, row.parentId);
    if (row.live) categorySlugs.set(row.id, row.slug);
  }
  for (const [productId, row] of state) {
    productCategory.set(productId, row.categoryId);
    facts.set(productId, { attributes: new Map(), skus: [], brandId: row.brandId && brandSlugs.has(row.brandId) ? row.brandId : null });
  }
  for (const row of all<{ id: string; slug: string; type: string; display: string }>(`SELECT id, slug, value_type AS type, facet_display AS display
    FROM product_attributes WHERE deleted_at IS NULL AND filterable = 1 AND slug <> 'brand'`)) {
    attributeMeta.set(row.id, row);
  }
  const values = all<{ productId: string; attributeId: string; value: string; valueId: string | null; valueNumber: number | null; normalized: string | null }>(`
    SELECT pav.product_id AS productId, pav.attribute_id AS attributeId, pav.value, pav.value_id AS valueId,
      pav.value_number AS valueNumber, av.normalized_value AS normalized
    FROM product_attribute_values pav LEFT JOIN attribute_values av ON av.id = pav.value_id`);
  for (const row of values) {
    const meta = attributeMeta.get(row.attributeId);
    const product = facts.get(row.productId);
    if (!meta || !product) continue;
    let key: string | null;
    if (meta.type === "enum") key = row.valueId;
    else if (meta.type === "number") key = row.valueNumber === null ? null : canonicalAttributeNumber(row.valueNumber);
    else if (meta.type === "boolean") key = row.valueNumber === null ? null : String(Math.trunc(row.valueNumber));
    else key = normalizeAttributeValue(row.value).slice(0, 200) || null;
    if (!key) continue;
    product.attributes.set(row.attributeId, { key, number: meta.type === "number" || meta.type === "boolean" ? row.valueNumber : null });
    urlValue.set(`${row.attributeId}\u0000${key}`, meta.type === "enum" ? row.normalized! : key);
  }
  const skuRows = all<{ skuId: string; productId: string; axis: string; value: string }>(`
    SELECT v.id AS skuId, v.product_id AS productId, 'option.' || replace(d.normalized_name, ' ', '-') AS axis,
      substr(ov.normalized_value, 1, 200) AS value
    FROM product_variants v
    JOIN product_variant_option_values x ON x.variant_id = v.id
    JOIN product_option_definitions d ON d.id = x.option_definition_id AND d.deleted_at IS NULL
    JOIN product_option_values ov ON ov.id = x.option_value_id AND ov.deleted_at IS NULL
    WHERE v.deleted_at IS NULL AND v.id <> 'default'
    ORDER BY v.id`);
  const skus = new Map<string, { productId: string; axes: Map<string, string> }>();
  for (const row of skuRows) {
    const sku = skus.get(row.skuId) ?? { productId: row.productId, axes: new Map<string, string>() };
    if (!sku.axes.has(row.axis)) sku.axes.set(row.axis, row.value);
    skus.set(row.skuId, sku);
  }
  for (const sku of skus.values()) facts.get(sku.productId)?.skus.push(sku.axes);
  return state;
}

type Filter = Awaited<ReturnType<typeof resolvePublicAttributeFilters>>[number];

function bruteForce(scope: Scope, filters: Filter[]) {
  const attributeFilters = filters.filter((filter) => filter.kind === "attribute");
  const optionFilters = filters.filter((filter) => filter.kind === "option");
  const brand = filters.find((filter) => filter.kind === "brand");
  const matchesAttributes = (product: ProductFacts, except?: string) => attributeFilters.every((filter) => {
    if (filter.id === except) return true;
    const value = product.attributes.get(filter.id);
    if (!value) return false;
    if (filter.keys.length > 0 && !filter.keys.includes(value.key)) return false;
    if (filter.range) {
      if (value.number === null) return false;
      if (filter.range.min !== null && value.number < filter.range.min) return false;
      if (filter.range.max !== null && value.number > filter.range.max) return false;
    }
    return true;
  });
  const skuMatches = (sku: Map<string, string>, except?: string) =>
    optionFilters.every((filter) => filter.id === except || filter.keys.includes(sku.get(filter.id) ?? "\u0000"));
  const matchesOptions = (product: ProductFacts) => optionFilters.length === 0 || product.skus.some((sku) => skuMatches(sku));
  const matchesBrand = (product: ProductFacts) => !brand || (product.brandId !== null && brand.keys.includes(product.brandId));

  const counts = new Map<string, Map<string, number>>();
  const bump = (facet: string, value: string, hit: boolean) => {
    const values = counts.get(facet) ?? new Map<string, number>();
    values.set(value, (values.get(value) ?? 0) + (hit ? 1 : 0));
    counts.set(facet, values);
  };
  const numbers = new Map<string, number[]>();
  let total = 0;
  for (const productId of scope.productIds) {
    const product = facts.get(productId)!;
    const inAttributes = matchesAttributes(product);
    const inOptions = matchesOptions(product);
    const inBrand = matchesBrand(product);
    if (inAttributes && inOptions && inBrand) total += 1;
    for (const [attributeId, value] of product.attributes) {
      if (scope.category?.setAttributeIds && !scope.category.setAttributeIds.has(attributeId)) continue;
      const hit = matchesAttributes(product, attributeId) && inOptions && inBrand;
      bump(attributeId, value.key, hit);
      if (hit && value.number !== null) numbers.set(attributeId, [...(numbers.get(attributeId) ?? []), value.number]);
    }
    const optionValues = new Map<string, Set<string>>();
    const optionHits = new Map<string, Set<string>>();
    for (const sku of product.skus) {
      for (const [axis, value] of sku) {
        optionValues.set(axis, (optionValues.get(axis) ?? new Set()).add(value));
        if (skuMatches(sku, axis) && inAttributes && inBrand) optionHits.set(axis, (optionHits.get(axis) ?? new Set()).add(value));
      }
    }
    for (const [axis, values] of optionValues) {
      for (const value of values) bump(axis, value, optionHits.get(axis)?.has(value) ?? false);
    }
    if (!scope.brandId && product.brandId) bump("brand", product.brandId, inAttributes && inOptions);
    // The category-tree facet: a subtree listing counts each child of the
    // listing category over its subtree; a flat category none; a brand page
    // the published category each product sits in.
    const categoryId = productCategory.get(productId) ?? null;
    const everySelection = inAttributes && inOptions && inBrand;
    if (scope.category?.subtree) {
      let node = categoryId;
      while (node && categoryParents.get(node) !== scope.category.id) node = categoryParents.get(node) ?? null;
      if (node && categorySlugs.has(node)) bump("category", node, everySelection);
    } else if (!scope.category && categoryId && categorySlugs.has(categoryId)) {
      bump("category", categoryId, everySelection);
    }
  }
  return { counts, numbers, total };
}

function compareFacets(label: string, scope: Scope, filters: Filter[], facets: PublicProductFacet[], apiTotal: number) {
  const brute = bruteForce(scope, filters);
  expect(apiTotal, `${label}: total`).toBe(brute.total);
  let values = 0;
  for (const facet of facets) {
    const key = facet.kind === "brand" || facet.kind === "category" ? facet.kind : facet.id;
    const expected = brute.counts.get(key);
    const selected = filters.find((filter) => (filter.kind === "brand" ? "brand" : filter.id) === key);
    if (!expected) {
      // Only a selection nothing in scope carries is listed without rows.
      expect(selected, `${label}: unexpected facet ${key}`).toBeDefined();
      continue;
    }
    if (facet.display === "range") {
      const hits = brute.numbers.get(key) ?? [];
      expect(facet.range, `${label}: ${key} range`).toEqual(hits.length > 0
        ? { min: Math.min(...hits), max: Math.max(...hits) }
        : null);
      continue;
    }
    const toUrl = (value: string) => facet.kind === "brand"
      ? brandSlugs.get(value)!
      : facet.kind === "category" ? categorySlugs.get(value)!
      : facet.kind === "attribute" ? urlValue.get(`${facet.id}\u0000${value}`)! : value;
    const want = new Map([...expected].map(([value, count]) => [toUrl(value), count]));
    for (const value of facet.values) {
      if (want.has(value.value)) expect(value.count, `${label}: ${key}=${value.value}`).toBe(want.get(value.value));
      else expect(selected?.values ?? [], `${label}: ${key}=${value.value} has no rows`).toContain(value.value);
      values += 1;
    }
    const shown = new Set(facet.values.map((value) => value.value));
    const omitted = [...want].filter(([value]) => !shown.has(value));
    const cap = facet.kind === "brand" ? BRAND_VALUE_CAP : VALUE_CAP;
    if (want.size <= cap) expect(omitted, `${label}: ${key} omitted values`).toEqual([]);
    else {
      expect(facet.values.length, `${label}: ${key} cap`).toBeGreaterThanOrEqual(cap);
      const lowestShown = Math.min(...facet.values.filter((value) => !selected?.values.includes(value.value)).map((value) => value.count));
      for (const [, count] of omitted) expect(count, `${label}: ${key} kept the most common values`).toBeLessThanOrEqual(lowestShown);
    }
  }
  // Every brute-force facet with a public value is offered (below the attribute cap).
  for (const [key, values] of brute.counts) {
    if (key.startsWith("attr") && facets.filter((facet) => facet.kind === "attribute").length >= 50) continue;
    if (attributeMeta.get(key) || key.startsWith("option.") || key === "brand" || key === "category") {
      expect(facets.some((facet) => (facet.kind === "brand" || facet.kind === "category" ? facet.kind : facet.id) === key) || values.size < (key === "category" ? 2 : 1), `${label}: facet ${key} missing`).toBe(true);
    }
  }
  return { facets: facets.length, values, total: brute.total };
}

describe.skipIf(!SQLITE)("catalogue-scale facet counts equal brute force", () => {
  let scopes: Scope[] = [];
  beforeAll(async () => {
    sqlite = new DatabaseSync(SQLITE!);
    sqlite.exec("PRAGMA foreign_keys = ON");
    db = drizzle(createSqliteD1Binding(sqlite), { schema }) as unknown as Database;
    const { laptop, children, setCategory } = await typeTheSeed();
    const state = await loadFacts();
    const publicIn = (predicate: (row: { categoryId: string | null; brandId: string | null }) => boolean) =>
      [...state].filter(([, row]) => row.isPublic && predicate(row)).map(([id]) => id);
    // A subtree listing holds the category and every published descendant (closure).
    const publishedSubtree = (id: string) => new Set(all<{ id: string }>(`SELECT cc.descendant_id AS id FROM category_closure cc
      JOIN categories c ON c.id = cc.descendant_id AND c.status = 'published' AND c.deleted_at IS NULL
      WHERE cc.ancestor_id = ?`, id).map((row) => row.id));
    const subtree = publishedSubtree(laptop);
    void children;
    const [bigRoot] = all<{ id: string }>(`SELECT cc.ancestor_id AS id FROM products p JOIN category_closure cc ON cc.descendant_id = p.category_id
      JOIN categories r ON r.id = cc.ancestor_id AND r.parent_id IS NULL AND r.status = 'published'
      GROUP BY cc.ancestor_id ORDER BY count(*) DESC LIMIT 1`);
    const rootSubtree = publishedSubtree(bigRoot!.id);
    const [smallLeaf] = all<{ id: string }>(`SELECT p.category_id AS id FROM products p JOIN categories c ON c.id = p.category_id
      WHERE c.status = 'published' GROUP BY p.category_id HAVING count(*) BETWEEN 20 AND 60 ORDER BY p.category_id LIMIT 1`);
    const [bigBrand] = all<{ id: string }>(`SELECT p.brand_id AS id FROM products p JOIN brands b ON b.id = p.brand_id AND b.status = 'published'
      GROUP BY p.brand_id ORDER BY count(*) DESC LIMIT 1`);
    const setIds = new Set(all<{ id: string }>("SELECT attribute_id AS id FROM category_attribute_sets WHERE category_id = ?", setCategory).map((row) => row.id));
    scopes = [
      { name: "largest category", productIds: publicIn((row) => row.categoryId === laptop), category: { id: laptop, subtree: false } },
      { name: "largest category subtree", productIds: publicIn((row) => subtree.has(row.categoryId ?? "")), category: { id: laptop, subtree: true } },
      { name: "largest root subtree", productIds: publicIn((row) => rootSubtree.has(row.categoryId ?? "")), category: { id: bigRoot!.id, subtree: true } },
      { name: "small leaf", productIds: publicIn((row) => row.categoryId === smallLeaf!.id), category: { id: smallLeaf!.id, subtree: false } },
      { name: "category with an attribute set", productIds: publicIn((row) => row.categoryId === setCategory), category: { id: setCategory, subtree: false, setAttributeIds: setIds } },
      { name: "largest brand", productIds: publicIn((row) => row.brandId === bigBrand!.id), brandId: bigBrand!.id },
    ];
  }, 600_000);

  async function run(scope: Scope, query: Query) {
    const filters = await resolvePublicAttributeFilters(db, query, [], { brand: !scope.brandId });
    const started = performance.now();
    const params = { page: 1, limit: 20, attributeFilters: filters };
    const result = scope.brandId
      ? await getStorefrontBrandProducts(db, { id: scope.brandId }, params)
      : await getStorefrontCategoryProducts(db, {
        id: scope.category!.id, name: "x", slug: "x", description: null, imageUrl: null, metaTitle: null,
        metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false, createdAt: null, updatedAt: null,
      }, params, { includeDescendants: scope.category!.subtree });
    const ms = Math.round(performance.now() - started);
    const summary = compareFacets(`${scope.name} ${JSON.stringify(query)}`, scope, filters, result.facets, result.pagination.total);
    report.push({ scope: scope.name, products: scope.productIds.length, query, ms, ...summary });
    return result;
  }

  /** Common values of a scope, so every query below selects something real. */
  function common(scope: Scope, key: string, count: number): string[] {
    const brute = bruteForce(scope, []);
    const values = [...(brute.counts.get(key) ?? new Map())].sort((a, b) => b[1] - a[1]).slice(0, count).map(([value]) => value);
    if (key === "brand") return values.map((value) => brandSlugs.get(value)!);
    return values.map((value) => urlValue.get(`${key}\u0000${value}`) ?? value);
  }

  it("matches on every scope and filter combination", async () => {
    const id = (name: string) => all<{ id: string }>("SELECT id FROM product_attributes WHERE name = ?", name)[0]!.id;
    const [maker, ram, warranty, display] = ["attr_scale_brand", id("RAM"), id("Warranty"), id("Display Size")];
    const slug = (attributeId: string) => attributeMeta.get(attributeId)!.slug;
    for (const scope of scopes) {
      await run(scope, {});
      const makers = common(scope, maker, 2);
      const rams = common(scope, ram, 2);
      const warranties = common(scope, warranty, 1);
      const axes = [...bruteForce(scope, []).counts.keys()].filter((key) => key.startsWith("option."));
      if (makers.length) await run(scope, { [slug(maker)]: makers });
      if (rams.length && warranties.length) await run(scope, { [slug(ram)]: rams, [slug(warranty)]: warranties });
      await run(scope, { [`${slug(display)}.min`]: ["13"], [`${slug(display)}.max`]: ["16"] });
      if (rams.length) await run(scope, { [slug(ram)]: rams.slice(0, 1), [`${slug(display)}.min`]: ["14"] });
      if (axes.length >= 1) {
        const first = common(scope, axes[0]!, 2);
        await run(scope, { [axes[0]!]: first });
        if (axes.length >= 2) await run(scope, { [axes[0]!]: first.slice(0, 1), [axes[1]!]: common(scope, axes[1]!, 1) });
        if (rams.length) await run(scope, { [axes[0]!]: first.slice(0, 1), [slug(ram)]: rams });
      }
      if (!scope.brandId) {
        const brands = common(scope, "brand", 2);
        if (brands.length) {
          await run(scope, { brand: brands });
          if (axes.length) await run(scope, { brand: brands.slice(0, 1), [axes[0]!]: common(scope, axes[0]!, 1) });
        }
      }
      // The seeded Brand attribute keeps the reserved slug "brand" once brand entities exist: never a facet.
      await run(scope, { [slug(ram)]: ["no-such-value"], ...(attributeMeta.has(maker) ? { [slug(maker)]: ["No Such Maker"] } : {}) });
    }
    if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  }, 1_800_000);
});
