// Brand-wall catalog selection, planned into the homepage's second batch.
import { brands, media, productBuyerState } from "@scalius/database/schema";
import type { Database, safeBatch } from "@scalius/database/client";
import { and, asc, eq, sql } from "drizzle-orm";
import {
    brandLogoColumns,
    brandLogoJoinCondition,
    presentBrandLogo,
    publicBrandConditions,
    type BrandLogo,
    type BrandLogoRow,
} from "../brands/brands.storefront";
import { deps } from "../../cache-deps";

type BatchStatement = Parameters<typeof safeBatch>[1][number];

/** A brand on the brand wall: published, live, with a public product. */
export interface HomeBrand {
    id: string;
    name: string;
    slug: string;
    canonicalPath: string | null;
    logo: BrandLogo | null;
}

/**
 * One statement for the brand wall: public brands that have a public
 * product (the buyer-state brand index), in merchant order.
 */
export function planHomeBrands(db: Database, limit: number): {
    statements: BatchStatement[];
    resolve(results: readonly unknown[], offset: number): HomeBrand[];
} {
    if (limit <= 0) return { statements: [], resolve: () => [] };
    // Brand membership already advances lm:all; brand metadata uses b:*.
    deps.listMembership("all");
    deps.anyBrand();
    const statement = db
        .select({
            id: brands.id,
            name: brands.name,
            slug: brands.slug,
            canonicalPath: brands.canonicalPath,
            ...brandLogoColumns,
            logoSourceMediaId: sql<string | null>`${brands.logoMediaId}`.as("brand_logo_source_media_id"),
        })
        .from(brands)
        .leftJoin(media, brandLogoJoinCondition())
        .where(and(
            ...publicBrandConditions(),
            sql`EXISTS (SELECT 1 FROM ${productBuyerState} WHERE ${eq(productBuyerState.isPublic, true)} AND ${productBuyerState.brandId} = ${brands.id})`,
        ))
        .orderBy(asc(brands.sortOrder), asc(brands.name), asc(brands.id))
        .limit(limit);
    return {
        statements: [statement],
        resolve(results, offset) {
            const rows = results[offset] as Array<Omit<HomeBrand, "logo"> & BrandLogoRow & { logoSourceMediaId: string | null }>;
            // Depend on the saved reference even when the logo join excludes it.
            deps.mediaItems(rows.map((row) => row.logoSourceMediaId));
            return rows.map((row) => ({
                id: row.id,
                name: row.name,
                slug: row.slug,
                canonicalPath: row.canonicalPath,
                logo: presentBrandLogo(row, row.name),
            }));
        },
    };
}
