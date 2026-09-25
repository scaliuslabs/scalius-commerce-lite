// Product sitemap rows: public products (the stored buyer state's public
// set, buyer-state.ts) without noIndex or a sitemap exclusion, newest first.
import { products } from "@scalius/database/schema";
import { and, sql, desc, eq } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import type { StorefrontProductFilterInput } from "../products/types";
import type { Database } from "@scalius/database/client";
import { getPagination } from "./shared";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";

type StorefrontSitemapProductRow = {
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

    return {
        products: productsList.map((product) => ({
            slug: product.slug,
            canonicalPath: product.canonicalPath,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        })),
        pagination: getPagination(page, limit, totalCount?.count || 0),
    };
}
