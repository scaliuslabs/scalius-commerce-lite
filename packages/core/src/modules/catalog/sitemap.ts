// Product sitemap rows: public products (the stored buyer state's public
// set, buyer-state.ts) without noIndex or a sitemap exclusion, newest first.
//
// Only the sitemap index counts: one statement walks the eligible set once and
// returns the total with the boundary of every later page. A page is then a
// keyset seek from its boundary (`after`), never an OFFSET walk and never a
// count, so page N costs what page 1 costs.
import { products } from "@scalius/database/schema";
import { and, sql, desc, eq, type SQL } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import type { Database } from "@scalius/database/client";
import { SITEMAP_PAGE_SIZE } from "@scalius/shared/sitemap-pagination";
import { ValidationError } from "@scalius/core/errors";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";
import { deps } from "./declare-deps";
import { localizedSlugSql, type TranslationScope } from "../translations";

/** Sitemap rows declared one `p:` key each; above it the page declares `t:products`. */
const SITEMAP_ROW_KEYS_MAX = 200;

/** The last row of a page in sitemap order: the next page starts after it. */
export interface SitemapPosition {
    createdAt: number;
    id: string;
}

type StorefrontSitemapProductRow = {
    id: string;
    slug: string;
    trSlug?: string | null;
    canonicalPath: string | null;
    createdAt: number;
    updatedAt: number;
};

function sitemapLimit(limit: number | undefined): number {
    const value = limit ?? 100;
    if (!Number.isSafeInteger(value) || value < 1 || value > SITEMAP_PAGE_SIZE) {
        throw new ValidationError("Invalid sitemap pagination");
    }
    return value;
}

/** `<created_at base36>.<product id base64url>`: the text a page boundary is signed as. */
export function encodeSitemapPosition(position: SitemapPosition): string {
    const bytes = new TextEncoder().encode(position.id);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encodedId = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return `${position.createdAt.toString(36)}.${encodedId}`;
}

/** The boundary `encodeSitemapPosition` wrote, or null for any other text. */
export function decodeSitemapPosition(value: string): SitemapPosition | null {
    const match = /^([0-9a-z]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match?.[1] || !match[2]) return null;
    const createdAt = Number.parseInt(match[1], 36);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
    try {
        const padded = match[2].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(match[2].length / 4) * 4, "=");
        const id = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
        return id && id.length <= 180 ? { createdAt, id } : null;
    } catch {
        return null;
    }
}

function sitemapEligibility(): SQL[] {
    return [
        publicBuyerStateCondition(),
        eq(products.noIndex, false),
        eq(products.excludeFromSitemap, false),
    ];
}

/** Which public products are listed and in what order, and the noIndex and exclusion flags of any of them. */
function declareSitemapMembership(): void {
    deps.listMembership("all");
    deps.discoveryMembership();
}

/**
 * One page of the product sitemap: the first page, or the page after a
 * boundary the sitemap index handed out. The read seeks the buyer state's
 * newest index from the boundary and reads `limit + 1` rows; it never counts.
 */
export async function getStorefrontSitemapProducts(
    db: Database,
    params: { limit?: number; after?: SitemapPosition | null },
    /** A presence's sitemap names each product at its handle in the presence's language. */
    translation: TranslationScope | null = null,
) {
    const limit = sitemapLimit(params.limit);
    const conditions = sitemapEligibility();
    const after = params.after ?? null;
    if (after) {
        // Newest first, then id: `<=` is the index range, the OR breaks ties.
        conditions.push(
            sql`${buyerState.productCreatedAt} <= ${after.createdAt}`,
            sql`(${buyerState.productCreatedAt} < ${after.createdAt} OR ${buyerState.productId} > ${after.id})`,
        );
    }
    const rows = await db
        .select({
            id: products.id,
            slug: products.slug,
            canonicalPath: products.canonicalPath,
            createdAt: sql<number>`${buyerState.productCreatedAt}`.as("sitemap_created_at"),
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            ...(translation ? { trSlug: localizedSlugSql(translation, "product", products.id) } : {}),
        })
        .from(buyerState)
        .innerJoin(products, eq(products.id, buyerState.productId))
        .where(and(...conditions))
        .orderBy(desc(buyerState.productCreatedAt), buyerState.productId)
        .limit(limit + 1)
        .all() as StorefrontSitemapProductRow[];
    const productsList = rows.slice(0, limit);
    declareSitemapMembership();
    // A row shows only products columns (slug, canonical path, date). The
    // storefront asks for 5,000 rows a page, far over the entry key budget:
    // there the products table's own key is the exact, smaller choice.
    if (productsList.length <= SITEMAP_ROW_KEYS_MAX) deps.products(productsList.map((product) => product.id));
    else deps.table("products");
    // A presence's rows: any product handle in its language (one key for the page).
    if (translation) deps.localizedSlugs("product", translation.locale);

    return {
        products: productsList.map((product) => ({
            slug: product.trSlug || product.slug,
            canonicalPath: product.canonicalPath,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        })),
        pagination: { limit, hasNextPage: rows.length > limit },
    };
}

/**
 * What the sitemap index needs, in one statement: the number of listed
 * products and, for every page after the first, the boundary it starts
 * after (the last row of the page before it). It walks the eligible set once,
 * as a count would; no page read repeats that walk.
 */
export async function getStorefrontSitemapOutline(
    db: Database,
    params: { limit?: number },
): Promise<{ total: number; limit: number; totalPages: number; boundaries: SitemapPosition[] }> {
    const limit = sitemapLimit(params.limit);
    const ranked = db
        .select({
            // Both windows share the index's order (and the frame spans every
            // row), so the walk is one ordered seek of the newest index with no sort.
            n: sql<number>`row_number() OVER (ORDER BY ${buyerState.productCreatedAt} DESC, ${buyerState.productId})`.as("sitemap_n"),
            total: sql<number>`count(*) OVER (ORDER BY ${buyerState.productCreatedAt} DESC, ${buyerState.productId} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)`.as("sitemap_total"),
            createdAt: sql<number>`${buyerState.productCreatedAt}`.as("sitemap_created_at"),
            id: sql<string>`${buyerState.productId}`.as("sitemap_product_id"),
        })
        .from(buyerState)
        .innerJoin(products, eq(products.id, buyerState.productId))
        .where(and(...sitemapEligibility()))
        .as("sitemap_ranked");
    // Each page's last row, and one row for the total even when the last page is short.
    const rows = await db
        .select({ n: ranked.n, total: ranked.total, createdAt: ranked.createdAt, id: ranked.id })
        .from(ranked)
        .where(sql`${ranked.n} % ${limit} = 0 OR ${ranked.n} = ${ranked.total}`)
        .all();
    rows.sort((left, right) => Number(left.n) - Number(right.n));
    declareSitemapMembership();
    const total = Number(rows[0]?.total ?? 0);
    const boundaries = rows
        .filter((row) => Number(row.n) % limit === 0 && Number(row.n) < total)
        .map((row) => ({ createdAt: Number(row.createdAt), id: String(row.id) }));
    return { total, limit, totalPages: Math.ceil(total / limit), boundaries };
}
