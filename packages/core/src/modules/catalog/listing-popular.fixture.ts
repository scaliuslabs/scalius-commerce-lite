// Test-only: the `popular` order on a randomised catalogue (facets-live.fixture),
// read through every listing (shop-all, a search, `?category=`, a category, a
// subtree, a brand, manual, dynamic and mixed collections) under random
// filters, markets and page sizes 1 to 7, once per plan (read whole, walk).
// Each listing's popular order must be its newest membership sorted by
// (tier, value, id), page by page and cursor by cursor, and both plans must
// give the same pages, so the size threshold never changes what a buyer sees. One body for D1
// (listing-popular.d1.test.ts) and PostgreSQL (listing-popular.postgres-native.test.ts).
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { MIN_POPULAR_UNITS } from "@scalius/shared/listing-sorts";
import { resolvePublicAttributeFilters } from "./facets";
import { randomRequest, rng } from "./facets-live.fixture";
import { getStorefrontBrandProducts, getStorefrontCategoryProducts, getStorefrontCollectionProducts, getStorefrontProducts } from "./listing";

/** Units sold on 2 in 5 products, 0 to 6 (0 and 1 are below the popular threshold), every sixth exactly at it. */
export function seedPopularStats(sqlite: DatabaseSync, seed: number): void {
    const random = rng(seed * 7 + 1);
    const stats = (sqlite.prepare("SELECT id FROM products ORDER BY id").all() as Array<{ id: string }>)
        .filter(() => random(5) < 2)
        .map((row, index) => `('${row.id}', ${index % 6 === 0 ? MIN_POPULAR_UNITS : random(7)})`);
    if (stats.length > 0) sqlite.exec(`INSERT INTO product_sales_stats (product_id, sold_30d) VALUES ${stats.join(", ")}`);
}

type Page = { products: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

/** The plan a read takes (popular-plan.ts `force`); undefined lets the sizes choose. */
export type PopularPlanForce = "driven" | "walking" | undefined;
export const POPULAR_PLANS = ["driven", "walking"] as const;

export interface PopularOrderResult {
    /** Listings compared, per plan. */
    compared: Record<(typeof POPULAR_PLANS)[number], number>;
    nonEmpty: number;
    /** Cursor pages that cross from the popular tier into the rest. */
    crossings: number;
    /** Listed products at exactly MIN_POPULAR_UNITS units. */
    atThreshold: number;
    problems: string[];
}

/**
 * `requests` random requests through every listing, each read once per plan
 * (`setForce`): popular by page and by cursor equals the newest membership
 * sorted by tier, value and id, and both plans give the same pages.
 */
export async function comparePopularOrder(db: Database, sqlite: DatabaseSync, input: {
    seed: number;
    requests: number;
    setForce: (force: PopularPlanForce) => void;
}): Promise<PopularOrderResult> {
    const sold = new Map((sqlite.prepare("SELECT product_id, sold_30d FROM product_sales_stats").all() as Array<{ product_id: string; sold_30d: number }>)
        .map((row) => [row.product_id, Number(row.sold_30d)]));
    const created = new Map((sqlite.prepare("SELECT product_id, product_created_at FROM product_buyer_state").all() as Array<{ product_id: string; product_created_at: number }>)
        .map((row) => [row.product_id, Number(row.product_created_at)]));
    const popular = (id: string) => (sold.get(id) ?? 0) >= MIN_POPULAR_UNITS;
    const key = (id: string): [number, number] => popular(id) ? [1, sold.get(id)!] : [0, created.get(id)!];
    const order = (a: string, b: string) => {
        const [tierA, valueA] = key(a);
        const [tierB, valueB] = key(b);
        return tierB - tierA || valueB - valueA || (a < b ? -1 : a > b ? 1 : 0);
    };
    const random = rng(input.seed * 11 + 3);
    const result: PopularOrderResult = { compared: { driven: 0, walking: 0 }, nonEmpty: 0, crossings: 0, atThreshold: 0, problems: [] };
    for (let request = 0; request < input.requests; request += 1) {
        const { query, params, market } = randomRequest(random);
        const filters = await resolvePublicAttributeFilters(db, query, []);
        const brandFilters = await resolvePublicAttributeFilters(db, query, [], { brand: false });
        const { sort: _sort, ...base } = { ...params, attributeFilters: filters };
        const reads: Array<[string, (paging: object) => Promise<Page>]> = [
            ["shop-all", (paging) => getStorefrontProducts(db, { ...base, ...paging }, market)],
            ["search", (paging) => getStorefrontProducts(db, { ...base, search: "linen", ...paging }, market)],
            ["?category=", (paging) => getStorefrontProducts(db, { ...base, category: "a", ...paging }, market)],
            ["subtree", (paging) => getStorefrontCategoryProducts(db, { id: "cat_root", name: "Root", slug: "root" } as never,
                { ...base, ...paging }, { includeDescendants: true, pricing: market })],
            ["category", (paging) => getStorefrontCategoryProducts(db, { id: "cat_a", name: "A", slug: "a" } as never, { ...base, ...paging }, { pricing: market })],
            ["brand", (paging) => getStorefrontBrandProducts(db, { id: "brd_one00001" }, { ...base, attributeFilters: brandFilters, ...paging }, market)],
            ["manual collection", (paging) => getStorefrontCollectionProducts(db,
                { productIds: ["p_0000", "p_0003", "p_0007", "p_0011", "p_0042", "p_missing"] }, { ...base, ...paging }, market)],
            ["dynamic collection", (paging) => getStorefrontCollectionProducts(db, { categoryIds: ["cat_root", "cat_loose"] }, { ...base, ...paging }, market)],
            ["picked and dynamic collection", (paging) => getStorefrontCollectionProducts(db,
                { productIds: ["p_0001", "p_0005", "p_0042"], categoryIds: ["cat_b", "cat_loose"] }, { ...base, ...paging }, market)],
        ];
        for (const [name, read] of reads) {
            const label = `${name} ${JSON.stringify({ query, params: base, market: market?.presence ?? null })}`;
            try {
                input.setForce(undefined);
                const members: string[] = [];
                for (let page = 1; page <= 20; page += 1) {
                    const answer = await read({ sort: "newest", page, limit: 100 });
                    members.push(...answer.products.map((product) => product.id));
                    if (!answer.pageInfo.hasNextPage) break;
                }
                const expected = [...members].sort(order);
                if (expected.length > 0) result.nonEmpty += 1;
                result.atThreshold += expected.filter((id) => sold.get(id) === MIN_POPULAR_UNITS).length;
                const limit = 1 + random(7);
                const seen: Partial<Record<(typeof POPULAR_PLANS)[number], string>> = {};
                for (const plan of POPULAR_PLANS) {
                    input.setForce(plan);
                    const pages: string[][] = [];
                    for (let page = 1; page <= Math.ceil(expected.length / limit) + 1; page += 1) {
                        pages.push((await read({ sort: "popular", page, limit })).products.map((product) => product.id));
                    }
                    const walks: string[][] = [];
                    let cursor: string | undefined;
                    for (let step = 0; step < 400; step += 1) {
                        const answer = await read({ sort: "popular", limit, ...(cursor ? { cursor } : {}) });
                        const ids = answer.products.map((product) => product.id);
                        const before = walks.at(-1)?.at(-1);
                        if (plan === "walking" && before && popular(before) && ids.some((id) => !popular(id))) result.crossings += 1;
                        walks.push(ids);
                        if (!answer.pageInfo.hasNextPage) break;
                        cursor = answer.pageInfo.endCursor!;
                    }
                    result.compared[plan] += 1;
                    const paged = pages.flat();
                    const walked = walks.flat();
                    if (paged.join() !== expected.join()) result.problems.push(`${plan} paged ${label} limit ${limit}\n  want ${expected.join()}\n  got  ${paged.join()}`);
                    if (walked.join() !== expected.join()) result.problems.push(`${plan} walked ${label} limit ${limit}\n  want ${expected.join()}\n  got  ${walked.join()}`);
                    seen[plan] = JSON.stringify({ pages, walks });
                }
                if (seen.driven !== seen.walking) result.problems.push(`plans differ ${label} limit ${limit}`);
            } catch (error) {
                result.problems.push(`error ${label}: ${String((error as { cause?: unknown })?.cause ?? error).slice(0, 400)}`);
            } finally {
                input.setForce(undefined);
            }
        }
    }
    return result;
}
