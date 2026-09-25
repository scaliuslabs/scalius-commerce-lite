// Product sitemap rows: public products (the stored buyer state's public
// set, buyer-state.ts) without noIndex or a sitemap exclusion, newest first.
import { products } from "@scalius/database/schema";
import { and, sql, desc, eq } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import type { StorefrontProductFilterInput } from "../products/types";
import type { Database } from "@scalius/database/client";
import { getPagination } from "./shared";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";
import { deps } from "./declare-deps";

/** Sitemap rows declared one `p:` key each; above it the page declares `t:products`. */
const SITEMAP_ROW_KEYS_MAX = 200;

type StorefrontSitemapProductRow = {
    id: string;
    slug: string;
    canonicalPath: string | null;
    updatedAt: number;
};

export async function getStorefrontSitemapProducts(
    db: Database,
    params: Pick<StorefrontProductFilterInput, "page" | "limit">,
) {
    const {
        page = 1,
        limit = 100,
    } = params;
    const conditions = [
        publicBuyerStateCondition(),
        eq(products.noIndex, false),
        eq(products.excludeFromSitemap, false),
    ];
    const offset = (page - 1) * limit;

    const [productsList, totalCount] = await Promise.all([
        db
            .select({
                id: products.id,
                slug: products.slug,
                canonicalPath: products.canonicalPath,
                updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            })
            .from(buyerState)
            .innerJoin(products, eq(products.id, buyerState.productId))
            .where(and(...conditions))
            .orderBy(desc(buyerState.productCreatedAt), buyerState.productId)
            .limit(limit)
            .offset(offset)
            .all() as Promise<StorefrontSitemapProductRow[]>,
        db
            .select({ count: sql<number>`count(*)` })
            .from(buyerState)
            .innerJoin(products, eq(products.id, buyerState.productId))
            .where(and(...conditions))
            .get(),
    ]);
    // Which public products are listed and in what order, the noIndex and
    // exclusion flags of any of them, and each row's own slug, path and date.
    deps.listMembership("all");
    deps.discoveryMembership();
    // A row shows only products columns (slug, canonical path, date). The
    // storefront asks for 5,000 rows a page, far over the entry key budget:
    // there the products table's own key is the exact, smaller choice.
    if (productsList.length <= SITEMAP_ROW_KEYS_MAX) deps.products(productsList.map((product) => product.id));
    else deps.table("products");

    return {
        products: productsList.map((product) => ({
            slug: product.slug,
            canonicalPath: product.canonicalPath,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        })),
        pagination: getPagination(page, limit, totalCount?.count || 0),
    };
}
