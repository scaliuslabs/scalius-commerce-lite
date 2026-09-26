/**
 * Catalogue cache dependencies at catalogue scale (opt-in, local only).
 *
 * Seeds a fresh migrated database with `scripts/catalog-scale-seed.mjs`
 * (30k products, ~83k SKUs, 50 collections, orders), types it the way a
 * merchant would (brand entities, a category subtree, an attribute set),
 * then runs the largest public catalogue reads in STRICT dependency scopes:
 * every table they touch must be covered by a declared key, and each entry
 * must fit the entry key budget. The key counts are printed.
 *
 *   CACHE_DEPS_SCALE_DIR=<empty scratch dir> \
 *   pnpm --dir packages/core exec vitest run src/modules/catalog/cache-deps-scale.local.test.ts --maxWorkers=1
 *
 * The directory is written to: never point it at a shared state.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { safeBatch, type Database } from "@scalius/database/client";
import { createMigratedSqlite, createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { CACHE_DEP_ENTRY_KEY_BUDGET } from "@scalius/shared/cache-deps";
import { withDependencyScope, type CacheDependencies } from "../../cache-deps";
import { rebuildCatalogProjections } from "../products";
import { getPublicCollectionCatalog, planCollectionProducts } from "../collections";
import {
    getPublicCategoryFacets,
    getStorefrontBrandProducts,
    getStorefrontCategoryProducts,
    getStorefrontFeedProducts,
    getStorefrontProductBySlug,
    getStorefrontProductComparison,
    getStorefrontProductRecommendations,
    getStorefrontProducts,
    getStorefrontSitemapProducts,
    planHomeProductLists,
    refreshProductRecommendations,
    refreshProductSalesStats,
    resolvePublicAttributeFilters,
} from ".";

const DIR = process.env.CACHE_DEPS_SCALE_DIR;
const ROOT = resolve(__dirname, "../../../../..");

let sqlite: DatabaseSync;
let db: Database;
const report: Array<{ read: string; declared: number; keys: number; tables: number; soft: number | null; collapsed: string }> = [];

function all<T>(query: string, ...params: Array<string | number>): T[] {
    return sqlite.prepare(query).all(...params) as T[];
}

async function strict<T>(
    read: string,
    render: () => Promise<T>,
    options: { collapses?: string[] } = {},
): Promise<{ value: T; dependencies: CacheDependencies }> {
    const unbounded = await withDependencyScope(render, { strict: true, label: read, log: () => undefined, budget: 1_000_000 });
    const result = await withDependencyScope(render, { strict: true, label: read, log: () => undefined });
    report.push({
        read,
        declared: unbounded.dependencies.keys.length,
        keys: result.dependencies.keys.length,
        tables: result.dependencies.tables.length,
        soft: result.dependencies.softMaxAgeSeconds,
        collapsed: result.dependencies.collapsedKinds.join(","),
    });
    expect(result.dependencies.coarseTables, read).toEqual([]);
    expect(result.dependencies.collapsedKinds, read).toEqual(options.collapses ?? []);
    expect(result.dependencies.uncacheable, read).toEqual([]);
    expect(result.dependencies.keys.length, read).toBeLessThanOrEqual(CACHE_DEP_ENTRY_KEY_BUDGET);
    return result;
}

const category = (id: string) => ({
    id, name: "x", slug: "x", description: null, imageUrl: null, metaTitle: null,
    metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false, createdAt: null,
});

describe.skipIf(!DIR)("catalogue cache dependencies at 30k products", () => {
    let biggestCategory = "";
    let bigBrand = "";

    beforeAll(async () => {
        // A migrated database laid out as a local D1 state directory, then the seed.
        const d1Dir = join(DIR!, "v3", "d1", "miniflare-D1DatabaseObject");
        mkdirSync(d1Dir, { recursive: true });
        const file = join(d1Dir, "scale.sqlite");
        if (!existsSync(file)) {
            createMigratedSqlite().exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
            execFileSync(process.execPath, [join(ROOT, "scripts/catalog-scale-seed.mjs"), "--state", DIR!], { stdio: "inherit" });
        }
        expect(readdirSync(d1Dir).filter((name) => name.endsWith(".sqlite"))).toEqual(["scale.sqlite"]);
        sqlite = new DatabaseSync(file);
        sqlite.exec("PRAGMA foreign_keys = ON");
        db = createSqliteD1Database({ sqlite }).db;

        // Merchant typing: brand entities from the seeded Brand attribute, a
        // subtree under the largest category, an attribute set on it.
        if (all<{ n: number }>("SELECT count(*) AS n FROM brands")[0]!.n === 0) {
            const values = all<{ value: string }>("SELECT DISTINCT value FROM product_attribute_values WHERE attribute_id = 'attr_scale_brand' ORDER BY value");
            const insert = sqlite.prepare("INSERT INTO brands (id, name, slug, status) VALUES (?, ?, ?, 'published')");
            values.forEach(({ value }, index) => insert.run(`brd_scale_${String(index).padStart(4, "0")}`, value, `brand-${index}`));
            sqlite.exec(`
                UPDATE products SET brand_id = (
                    SELECT b.id FROM product_attribute_values v JOIN brands b ON b.name = v.value
                    WHERE v.product_id = products.id AND v.attribute_id = 'attr_scale_brand'
                );
                UPDATE product_attributes SET slug = 'maker', name = 'Maker' WHERE id = 'attr_scale_brand';
            `);
            const [largest] = all<{ id: string }>(`SELECT category_id AS id FROM products WHERE category_id IS NOT NULL
                GROUP BY category_id ORDER BY count(*) DESC LIMIT 1`);
            const children = all<{ id: string }>(`SELECT c.id FROM categories c WHERE c.status = 'published' AND c.deleted_at IS NULL
                AND c.id <> ? AND c.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id)
                ORDER BY c.id LIMIT 3`, largest!.id);
            for (const child of children) sqlite.prepare("UPDATE categories SET parent_id = ? WHERE id = ?").run(largest!.id, child.id);
            const attributes = all<{ id: string }>("SELECT id FROM product_attributes WHERE filterable = 1 AND id <> 'attr_scale_brand' ORDER BY id LIMIT 3");
            attributes.forEach(({ id }, index) => sqlite.prepare("INSERT OR IGNORE INTO category_attribute_sets (category_id, attribute_id, sort_order) VALUES (?, ?, ?)").run(largest!.id, id, index));
            await rebuildCatalogProjections(db);
            await refreshProductSalesStats(db);
        }
        biggestCategory = all<{ id: string }>(`SELECT category_id AS id FROM products WHERE category_id IS NOT NULL
            GROUP BY category_id ORDER BY count(*) DESC LIMIT 1`)[0]!.id;
        bigBrand = all<{ id: string }>(`SELECT brand_id AS id FROM products WHERE brand_id IS NOT NULL
            GROUP BY brand_id ORDER BY count(*) DESC LIMIT 1`)[0]!.id;
    }, 1_800_000);

    it("covers the largest listings, product pages, feeds and home lists within the key budget", async () => {
        // The storefront's largest page is 60 cards (PRODUCT_LIST_PAGE_SIZES).
        await strict("shop all, 60 newest", () => getStorefrontProducts(db, { page: 1, limit: 60 }));
        // The API allows 100 (agents): 100 cards and their images pass the
        // budget, so the image keys collapse to the media table's own key.
        await strict("shop all, 100 newest (API maximum)", () => getStorefrontProducts(db, { page: 1, limit: 100 }), { collapses: ["m"] });
        await strict("shop all, 60 by price with a facet filter", async () => getStorefrontProducts(db, {
            page: 1, limit: 60, sort: "price-asc",
            attributeFilters: await resolvePublicAttributeFilters(db, { "option.color": ["black"] }, []),
        }));
        await strict("search, 60", () => getStorefrontProducts(db, { page: 1, limit: 60, search: "phone" }));
        await strict("largest category subtree, 60 by name", () => getStorefrontCategoryProducts(
            db, category(biggestCategory), { page: 1, limit: 60, sort: "name-asc" }, { includeDescendants: true },
        ));
        await strict("largest category facets", () => getPublicCategoryFacets(db, biggestCategory));
        await strict("largest brand, 60", () => getStorefrontBrandProducts(db, { id: bigBrand }, { page: 1, limit: 60 }));

        const [manual] = all<{ id: string }>(`SELECT id FROM collections WHERE json_extract(config, '$.source') = 'manual'
            ORDER BY json_array_length(json_extract(config, '$.productIds')) DESC LIMIT 1`);
        const [dynamic] = all<{ id: string }>(`SELECT id FROM collections WHERE json_extract(config, '$.source') = 'dynamic'
            ORDER BY json_array_length(json_extract(config, '$.categoryIds')) DESC LIMIT 1`);
        await strict("largest manual collection, 60", () => getPublicCollectionCatalog(db, manual!.id, { page: 1, limit: 60 }));
        await strict("largest dynamic collection, 60 by discount", () => getPublicCollectionCatalog(db, dynamic!.id, { page: 1, limit: 60, sort: "discount" }));

        const [richest] = all<{ slug: string; id: string }>(`SELECT p.slug, p.id FROM products p JOIN product_buyer_state s ON s.product_id = p.id AND s.is_public = 1
            ORDER BY (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id) DESC,
                     (SELECT count(*) FROM product_media m WHERE m.product_id = p.id) DESC LIMIT 1`);
        await refreshProductRecommendations(db, [richest!.id]);
        await strict("product page, most SKUs", () => getStorefrontProductBySlug(db, richest!.slug));
        await strict("recommendations, 12 for 20 cart products", () => getStorefrontProductRecommendations(db, {
            productIds: all<{ id: string }>("SELECT product_id AS id FROM product_buyer_state WHERE is_public = 1 LIMIT 20").map((row) => row.id),
            limit: 12,
        }));
        await strict("compare 4", () => getStorefrontProductComparison(db,
            all<{ id: string }>("SELECT product_id AS id FROM product_buyer_state WHERE is_public = 1 LIMIT 4").map((row) => row.id)));
        await strict("feed, 100", () => getStorefrontFeedProducts(db, { limit: 100 }));
        await strict("sitemap, 5,000", () => getStorefrontSitemapProducts(db, { page: 1, limit: 5000 }));

        // The homepage's catalogue part: every homepage collection plus the
        // newest, on-sale, popular and category lists, in one batch.
        const collections = all<{ id: string; config: string }>(
            "SELECT id, config FROM collections WHERE is_active = 1 AND deleted_at IS NULL AND json_extract(config, '$.showOnHomepage') = 1 ORDER BY sort_order");
        // Ten homepage collections and four lists: over 150 cards. Their image
        // keys pass the budget and collapse to the media table's own key.
        await strict(`home lists (${collections.length} collections, 4 lists)`, async () => {
            const collectionPlan = planCollectionProducts(db, collections.map((row) => ({ key: row.id, config: row.config })));
            const listPlan = planHomeProductLists(db, [
                { key: "newest", source: { kind: "newest" }, limit: 12 },
                { key: "on-sale", source: { kind: "on-sale" }, limit: 12 },
                { key: "popular", source: { kind: "popular" }, limit: 12 },
                { key: `category:${biggestCategory}`, source: { kind: "category", categoryId: biggestCategory }, limit: 12 },
            ]);
            const results = await safeBatch(db, [...collectionPlan.statements, ...listPlan.statements]);
            return {
                collections: collectionPlan.resolve(results),
                lists: listPlan.resolve(results, collectionPlan.statements.length),
            };
        }, { collapses: ["m"] });
        await strict("home lists (3 collections, 2 lists)", async () => {
            const collectionPlan = planCollectionProducts(db, collections.slice(0, 3).map((row) => ({ key: row.id, config: row.config })));
            const listPlan = planHomeProductLists(db, [
                { key: "newest", source: { kind: "newest" }, limit: 12 },
                { key: "on-sale", source: { kind: "on-sale" }, limit: 12 },
            ]);
            const results = await safeBatch(db, [...collectionPlan.statements, ...listPlan.statements]);
            return { collections: collectionPlan.resolve(results), lists: listPlan.resolve(results, collectionPlan.statements.length) };
        });
        console.log(`[cache-deps scale]\n${report.map((row) => `${row.read}: ${row.declared} declared, ${row.keys} stored keys, ${row.tables} tables${row.soft ? `, soft ${row.soft}s` : ""}${row.collapsed ? `, collapsed ${row.collapsed}` : ""}`).join("\n")}`);
    }, 600_000);
});
