// Test-only: the differential of a listing's page and narrowed plan against
// the frozen CTE statements (testing/listing-plan-oracle.ts), shared by
// listing-plan.oracle.d1.test.ts and its PostgreSQL twin. Each test file
// mocks ./listing-plan with switchedListingPlan (the oracle's module).
import { appendFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { withDependencyScope } from "../../cache-deps";
import type { ListingPlanSwitch } from "../../testing/listing-plan-oracle";
import type { MarketPricing } from "../price-lists";
import type { StorefrontProductFilterInput } from "../products";
import { resolvePublicAttributeFilters } from "./facets";
import { KWD, LISTED, LISTED_LIVE, randomRequest, rng } from "./facets-live.fixture";
import { getStorefrontBrandProducts, getStorefrontCategoryProducts, getStorefrontCollectionProducts, getStorefrontProducts } from "./listing";

/** A picked collection and one of whole categories, for the collection listing. */
export function seedListingCollections(sqlite: DatabaseSync): void {
    sqlite.exec(`INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
        ('col_listing_manual', 'Picked', 'grid', '{"source":"manual","productIds":["p_0000","p_0003","p_0007","p_0011","p_0042","p_missing"]}', 0),
        ('col_listing_dynamic', 'Root', 'grid', '{"source":"dynamic","categoryIds":["cat_root","cat_loose"]}', 1)`);
}

export interface ListingDifferential {
    compared: number;
    /** Requests whose response or declared dependencies differ, and requests that failed on the live statements. */
    diffs: string[];
    failures: string[];
    /** Responses that list at least one product. */
    nonEmpty: number;
    /** Narrowed shop-all responses (a facet value drives the plan). */
    narrowed: number;
}

const MARKETS: Array<MarketPricing | null> = [KWD, LISTED, LISTED_LIVE, LISTED_LIVE, null, null, null];

/**
 * `requests` random requests, each read through every listing (shop-all, a
 * search in both orders, a category parameter, an id list, a category with
 * or without its subtree, a brand, both collections), on the live statements
 * and on the frozen ones, and the next page by its cursor where the order
 * has one. `around` runs a read (the D1 test lifts its limits for the frozen
 * statements).
 */
export async function compareListingStacks(db: Database, input: {
    seed: number;
    requests: number;
    state: ListingPlanSwitch;
    around?: (oracle: boolean, read: () => Promise<unknown>) => Promise<unknown>;
}): Promise<ListingDifferential> {
    const { state } = input;
    const around = input.around ?? ((_oracle, read) => read());
    const random = rng(input.seed * 13 + 1);
    const result: ListingDifferential = { compared: 0, diffs: [], failures: [], nonEmpty: 0, narrowed: 0 };
    const categories = [{ id: "cat_a", slug: "a" }, { id: "cat_root", slug: "root" }, { id: "cat_loose", slug: "loose" }];
    const outcome = async (oracle: boolean, read: () => Promise<unknown>) => {
        state.oracle = oracle;
        try {
            return JSON.stringify(await around(oracle, () => withDependencyScope(read, { log: () => undefined })));
        } catch (error) {
            return `error: ${String(error instanceof Error && error.cause ? error.cause : error).slice(0, 300)}`;
        } finally {
            state.oracle = false;
        }
    };
    for (let request = 0; request < input.requests; request += 1) {
        const generated = randomRequest(random);
        let query: Record<string, string | string[]> = generated.query;
        let params: StorefrontProductFilterInput = generated.params;
        // Every other request keeps one filter (the narrowed plan's own case:
        // a value alone, or with a price range).
        if (request % 2 === 1) {
            const [key] = Object.keys(query);
            query = key && random(3) !== 0 ? { [key]: query[key]! } : {};
            params = {
                page: 1, limit: 20, sort: params.sort,
                ...(random(2) === 0 ? { minPrice: params.minPrice } : {}),
                ...(random(2) === 0 ? { maxPrice: params.maxPrice } : {}),
            };
        }
        const paging = random(3) === 0 ? { page: 1 + random(3), limit: 1 + random(6) } : {};
        const listing = { ...params, ...paging };
        const market = MARKETS[random(MARKETS.length)]!;
        const category = categories[random(categories.length)]!;
        const descend = random(2) === 0;
        const brandId = ["brd_one00001", "brd_two00001"][random(2)]!;
        const search = ["linen", "linnen", "silk bag", "nothing-matches", "shirt"][random(5)]!;
        state.tight = random(3) === 0;
        const filters = await resolvePublicAttributeFilters(db, query, []);
        const brandFilters = await resolvePublicAttributeFilters(db, query, [], { brand: false });
        const reads: Array<[string, (extra?: Partial<StorefrontProductFilterInput>) => Promise<unknown>]> = [
            ["shop-all", (extra) => getStorefrontProducts(db, { ...listing, attributeFilters: filters, ...extra }, market)],
            ["search", (extra) => getStorefrontProducts(db, { ...listing, search, attributeFilters: filters, ...extra }, market)],
            ["search by relevance", (extra) => getStorefrontProducts(db, { ...listing, sort: "relevance", search, attributeFilters: filters, ...extra }, market)],
            ["category parameter", (extra) => getStorefrontProducts(db, { ...listing, category: category.slug, attributeFilters: filters, ...extra }, market)],
            ["ids", (extra) => getStorefrontProducts(db, { ...listing, ids: "p_0000,p_0003,p_0007,p_0011,p_missing", attributeFilters: filters, ...extra }, market)],
            ["category", (extra) => getStorefrontCategoryProducts(db, { ...category, name: category.slug } as never,
                { ...listing, attributeFilters: filters, ...extra }, { includeDescendants: descend, pricing: market })],
            ["brand", (extra) => getStorefrontBrandProducts(db, { id: brandId }, { ...listing, attributeFilters: brandFilters, ...extra }, market)],
            ["collection", (extra) => getStorefrontCollectionProducts(db, { productIds: ["p_0000", "p_0003", "p_0007", "p_0011", "p_0042"] },
                { ...listing, attributeFilters: filters, ...extra }, market)],
            ["dynamic collection", (extra) => getStorefrontCollectionProducts(db, { categoryIds: ["cat_root", "cat_loose"] },
                { ...listing, attributeFilters: filters, ...extra }, market)],
        ];
        for (const [name, read] of reads) {
            const label = `seed ${input.seed} request ${request} ${name}${state.tight ? " (tight)" : ""}: ${JSON.stringify({
                query, listing, search, category: category.id, descend, brandId,
                market: market === null ? null : market === KWD ? "KWD" : market === LISTED ? "LISTED" : "LISTED_LIVE",
            })}`;
            const fresh = await outcome(false, () => read());
            const frozen = await outcome(true, () => read());
            result.compared += 1;
            if (fresh.startsWith("error:")) result.failures.push(`${label}: ${fresh}`);
            if (fresh !== frozen) result.diffs.push(label);
            if (fresh.includes("\"id\":\"p_0")) result.nonEmpty += 1;
            if (name === "shop-all" && filters.length > 0) result.narrowed += 1;
            // The next page by its cursor (newest and price orders).
            const cursor = /"endCursor":"([^"]+)"/.exec(fresh)?.[1];
            if (cursor && !fresh.startsWith("error:")) {
                const next = { page: 1, cursor } as Partial<StorefrontProductFilterInput>;
                const freshNext = await outcome(false, () => read(next));
                const frozenNext = await outcome(true, () => read(next));
                result.compared += 1;
                if (freshNext.startsWith("error:")) result.failures.push(`${label} next page: ${freshNext}`);
                if (freshNext !== frozenNext) result.diffs.push(`${label} next page`);
            }
        }
    }
    state.tight = false;
    // LISTING_PLAN_REPORT=<file> appends each catalogue's tally.
    if (process.env.LISTING_PLAN_REPORT) {
        appendFileSync(process.env.LISTING_PLAN_REPORT, `seed ${input.seed}: ${result.compared} compared, ${result.nonEmpty} listing products, ${result.narrowed} narrowed shop-all, ${result.diffs.length} differ, ${result.failures.length} failed\n`);
    }
    return result;
}
