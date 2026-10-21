// The bounded listing plans of a large catalogue (docs/SCALE.md) give the
// same answers as reading every row: a category subtree pages from each of
// its categories' own index, a plain category or brand page counts its
// facets from the maintained per-scope counts, and shop-all narrowed by a
// facet value picks its driven or walking form per read. One store and one
// set of scenarios for D1 (listing-scale.d1.test.ts) and PostgreSQL
// (listing-scale.postgres-native.test.ts). Test-only.
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { compareSqliteValues } from "../../testing/keyset-walk";
import { publicCategorySubtreeCondition } from "../categories";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";
import { buildCatalogFacetCountQuery, groupCatalogFacets, groupCatalogRatingFacet, resolvePublicAttributeFilters } from "./facets";
import { getStorefrontBrandProducts, getStorefrontCategoryProducts, getStorefrontProducts } from "./listing";

const CATEGORIES = ["cat_root", "cat_a", "cat_b", "cat_c", "cat_draft"] as const;
const PRODUCTS = 180;

/** A subtree with a draft child, two brands, two attributes and some ratings, as one SQL text. */
export function listingScaleSeed(): string {
    const products: string[] = [];
    const skus: string[] = [];
    const attributes: string[] = [];
    // Ratings arrive as a store gets them: a published review of a fulfilled
    // line of a delivered order, which the review triggers count.
    const orders: string[] = [];
    const lines: string[] = [];
    const fulfillments: string[] = [];
    const fulfilled: string[] = [];
    const reviews: string[] = [];
    for (let index = 0; index < PRODUCTS; index += 1) {
        const id = `prd_${String(index).padStart(4, "0")}`;
        const price = 1000 + (index * 37 % 23) * 250;
        const brand = index % 3 === 0 ? "NULL" : index % 3 === 1 ? "'brd_scale0001'" : "'brd_scale0002'";
        products.push(`('${id}', 'Product ${index}', ${price}, 'product-${index}', '${CATEGORIES[index % CATEGORIES.length]}', ${brand}, 1, ${1_700_000_000 + (index * 13 % 29) * 60})`);
        skus.push(`('var_${id}', '${id}', 'SKU-${id}', ${price}, 5, 1, 1)`);
        // "red" on 1 in 15 products (few), "blue" on the rest.
        attributes.push(`('pav_color_${id}', '${id}', 'attr_color', '${index % 15 === 0 ? "Red" : "Blue"}')`);
        if (index % 2 === 0) attributes.push(`('pav_fit_${id}', '${id}', 'attr_fit', '${index % 4 === 0 ? "Slim" : "Loose"}')`);
        if (index % 5 === 0) {
            for (const rating of [3, 5]) {
                const key = `${id.slice(4)}_${rating}`;
                orders.push(`('ord_${key}', 'Buyer', '01700000000', 'House 1', 'c', 'z', ${price}, 'confirmed')`);
                lines.push(`('item_${key}', 'ord_${key}', '${id}', 'var_${id}', 1, ${price}, 'ship')`);
                fulfillments.push(`('ful_${key}', 'ord_${key}', 'ship', 'key_${key}', 'admin')`);
                fulfilled.push(`('fln_${key}', 'ful_${key}', 'ord_${key}', 'item_${key}', 1)`);
                reviews.push(`('rev_scale_${key}', '${id}', 'var_${id}', 'ord_${key}', 'item_${key}', 'cus_${key}', 'customer', 'Buyer B.', ${rating}, 'published', 1790000000)`);
            }
        }
    }
    return `
        INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_root', 'Root', 'root', 'published', NULL);
        INSERT INTO categories (id, name, slug, status, parent_id) VALUES
            ('cat_a', 'A', 'a', 'published', 'cat_root'), ('cat_b', 'B', 'b', 'published', 'cat_root'),
            ('cat_c', 'C', 'c', 'published', 'cat_a'), ('cat_draft', 'Draft', 'draft', 'draft', 'cat_root');
        INSERT INTO brands (id, name, slug, status) VALUES ('brd_scale0001', 'One', 'one', 'published'), ('brd_scale0002', 'Two', 'two', 'published');
        INSERT INTO product_attributes (id, name, slug, filterable) VALUES ('attr_color', 'Color', 'color', 1), ('attr_fit', 'Fit', 'fit', 1);
        INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active, created_at) VALUES ${products.join(", ")};
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES ${skus.join(", ")};
        INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ${attributes.join(", ")};
        INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, status) VALUES ${orders.join(", ")};
        INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor, fulfillment_type) VALUES ${lines.join(", ")};
        INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES ${fulfillments.join(", ")};
        INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES ${fulfilled.join(", ")};
        UPDATE orders SET status = 'delivered';
        INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, author_type,
            author_display_name, rating, status, published_at) VALUES ${reviews.join(", ")}
    `;
}

export type ListingScaleRow = { id: string; category: string; brand: string | null; createdAt: number; price: number; color: string };

/** In a PostgreSQL plan, a correlated subquery tested as a filter: it runs once per row walked. */
export const CORRELATED_SUBQUERY_FILTER = /Filter: .*SubPlan/;

/** Every public product with its order keys and colour, to compare listings with. */
export const LISTING_SCALE_ROWS = `SELECT p.id AS "id", p.category_id AS "category", p.brand_id AS "brand", p.created_at AS "createdAt",
    b.from_minor AS "price", v.value_key AS "color" FROM products p JOIN product_buyer_state b ON b.product_id = p.id AND b.is_public = 1
    JOIN product_facet_values v ON v.product_id = p.id AND v.facet_key = 'attr_color'`;

export interface ListingScaleStore {
    db: Database;
    rows: ListingScaleRow[];
    /** The subtree's public price bounds, from the buyer state. */
    subtreePrices: { min: number; max: number };
}

const ORDERS = {
    newest: (a: ListingScaleRow, b: ListingScaleRow) => compareSqliteValues(Number(b.createdAt), Number(a.createdAt)) || compareSqliteValues(a.id, b.id),
    "price-asc": (a: ListingScaleRow, b: ListingScaleRow) => compareSqliteValues(Number(a.price), Number(b.price)) || compareSqliteValues(a.id, b.id),
    "price-desc": (a: ListingScaleRow, b: ListingScaleRow) => compareSqliteValues(Number(b.price), Number(a.price)) || compareSqliteValues(a.id, b.id),
} as const;

const root = {
    id: "cat_root", name: "Root", slug: "root", description: null, imageUrl: null,
    metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false, createdAt: null,
};

/** The scenarios, inside the caller's `describe`. */
export function listingScaleScenarios(setup: () => Promise<ListingScaleStore>): void {
    it.each(Object.keys(ORDERS) as Array<keyof typeof ORDERS>)("pages a category subtree by %s from each category's index, by page and by cursor", async (sort) => {
        const { db, rows } = await setup();
        // The draft child's products are not in the subtree.
        const expected = rows.filter((row) => row.category !== "cat_draft").sort(ORDERS[sort]).map((row) => row.id);
        const pages: string[] = [];
        for (let page = 1; page <= Math.ceil(expected.length / 20) + 1; page += 1) {
            const result = await getStorefrontCategoryProducts(db, root, { page, limit: 20, sort }, { includeDescendants: true });
            pages.push(...result.products.map((product) => product.id));
        }
        expect(pages).toEqual(expected);
        const walked: string[] = [];
        let cursor: string | undefined;
        for (let step = 0; step < 20; step += 1) {
            const result = await getStorefrontCategoryProducts(db, root, { limit: 25, sort, ...(cursor ? { cursor } : {}) }, { includeDescendants: true });
            walked.push(...result.products.map((product) => product.id));
            if (!result.pageInfo.hasNextPage) break;
            cursor = result.pageInfo.endCursor!;
        }
        expect(walked).toEqual(expected);
    });

    it("counts a plain subtree's and brand's facets from the maintained counts exactly as from their products", async () => {
        const { db, subtreePrices } = await setup();
        const subtree = await getStorefrontCategoryProducts(db, root, { page: 1, limit: 20 }, { includeDescendants: true });
        const live = await buildCatalogFacetCountQuery(db, {
            baseConditions: [publicBuyerStateCondition(), publicCategorySubtreeCondition(buyerState.categoryId, "cat_root")],
            needsProducts: false,
            filters: [],
            categoryId: "cat_root",
            ratingFacet: true,
            categoryFacet: { parentId: "cat_root" },
        });
        expect(subtree.facets).toEqual(groupCatalogFacets(live));
        expect(subtree.ratingFacet).toEqual(groupCatalogRatingFacet(live));
        // The review triggers rated 1 in 5 products (a 3 and a 5, so 4 stars).
        expect(subtree.ratingFacet.find((value) => value.min === 4)?.count).toBeGreaterThan(0);
        expect(subtree.pagination.total).toBe(144);
        expect(subtree.facets.find((facet) => facet.kind === "category")?.values.map((value) => [value.value, value.count]))
            .toEqual([["a", 72], ["b", 36]]);
        expect(subtree.priceRange).toEqual({ min: subtreePrices.min / 100, max: subtreePrices.max / 100 });

        const brand = await getStorefrontBrandProducts(db, { id: "brd_scale0001" }, { page: 1, limit: 20 });
        const brandLive = await buildCatalogFacetCountQuery(db, {
            baseConditions: [publicBuyerStateCondition(), eq(buyerState.brandId, "brd_scale0001")],
            needsProducts: false,
            filters: [],
            brandFacet: false,
            ratingFacet: true,
            categoryFacet: "product-categories",
        });
        expect(brand.facets).toEqual(groupCatalogFacets(brandLive));
        expect(brand.ratingFacet).toEqual(groupCatalogRatingFacet(brandLive));
        expect(brand.pagination.total).toBe(60);
    });

    it.each([["red", "driven"], ["blue", "walking"]])("pages, counts and prices shop-all narrowed by a %s value (%s)", async (color) => {
        const { db, rows } = await setup();
        const filters = await resolvePublicAttributeFilters(db, { color }, []);
        const matching = rows.filter((row) => row.color === color);
        for (const sort of Object.keys(ORDERS) as Array<keyof typeof ORDERS>) {
            const expected = [...matching].sort(ORDERS[sort]).map((row) => row.id);
            const seen: string[] = [];
            for (let page = 1; page <= Math.ceil(expected.length / 20); page += 1) {
                const result = await getStorefrontProducts(db, { page, limit: 20, sort, attributeFilters: filters });
                seen.push(...result.products.map((product) => product.id));
                expect(result.pagination.total).toBe(expected.length);
                if (color === "red") {
                    expect(result.priceRange).toEqual({
                        min: Math.min(...matching.map((row) => Number(row.price))) / 100,
                        max: Math.max(...matching.map((row) => Number(row.price))) / 100,
                    });
                }
            }
            expect(seen).toEqual(expected);
        }
    });
}
