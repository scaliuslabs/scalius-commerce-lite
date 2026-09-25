// Buyer-facing brand reads: the brand page, the brand list (brand wall,
// agents) and the brand sitemap. Only published, live brands are public;
// a draft or trashed brand shows nowhere, and products that point at it
// simply show no brand (never a placeholder).

import { brands, media } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, asc, eq, isNull, notInArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { getCurrentMediaUrl } from "../../integrations/storage";

export const PUBLIC_BRAND_PAGE_LIMIT = 100;
/** Brand URLs one sitemap document lists at most (the sitemap protocol allows 50k). */
export const BRAND_SITEMAP_LIMIT = 5000;

/** A brand buyers may see: published and not in trash. */
export function publicBrandConditions(): SQL[] {
    return [eq(brands.status, "published"), isNull(brands.deletedAt)];
}

/** The join condition for a product's public brand (`products.brand_id`). */
export function publicBrandJoinCondition(productBrandColumn: SQLWrapper): SQL {
    return and(sql`${brands.id} = ${productBrandColumn}`, ...publicBrandConditions())!;
}

/** Logo columns for a query that left-joins `media` on `brands.logo_media_id`. */
export function brandLogoJoinCondition(): SQL {
    return and(
        eq(media.id, brands.logoMediaId),
        eq(media.kind, "image"),
        notInArray(media.status, ["deleting", "deleted"]),
    )!;
}

/**
 * Aliased, so a batched read (whose rows D1 returns keyed by column name)
 * never lets `media.id` shadow `brands.id`.
 */
export const brandLogoColumns = {
    logoMediaId: sql<string | null>`${media.id}`.as("brand_logo_media_id"),
    logoObjectKey: sql<string | null>`${media.objectKey}`.as("brand_logo_object_key"),
    logoVariantWidth: sql<number | null>`${media.variantWidth}`.as("brand_logo_variant_width"),
    logoAltText: sql<string | null>`${media.altText}`.as("brand_logo_alt_text"),
    logoWidth: sql<number | null>`${media.width}`.as("brand_logo_width"),
    logoHeight: sql<number | null>`${media.height}`.as("brand_logo_height"),
};

export type BrandLogoRow = {
    logoMediaId: string | null;
    logoObjectKey: string | null;
    logoVariantWidth: number | null;
    logoAltText: string | null;
    logoWidth: number | null;
    logoHeight: number | null;
};

export type BrandLogo = {
    mediaId: string;
    url: string;
    alt: string;
    width: number | null;
    height: number | null;
};

export function presentBrandLogo(row: BrandLogoRow, brandName: string): BrandLogo | null {
    if (!row.logoMediaId || !row.logoObjectKey) return null;
    return {
        mediaId: row.logoMediaId,
        url: getCurrentMediaUrl(row.logoObjectKey, row.logoVariantWidth),
        alt: row.logoAltText?.trim() || brandName,
        width: row.logoWidth,
        height: row.logoHeight,
    };
}

function toIso(value: number | null | undefined): string | null {
    return value ? new Date(Number(value) * 1000).toISOString() : null;
}

/** The brand page's record: published, live, with its logo. */
export async function getPublicBrandBySlug(db: Database, slug: string) {
    const row = await db
        .select({
            id: brands.id,
            name: brands.name,
            slug: brands.slug,
            description: brands.description,
            metaTitle: brands.metaTitle,
            metaDescription: brands.metaDescription,
            canonicalPath: brands.canonicalPath,
            noIndex: brands.noIndex,
            excludeFromSitemap: brands.excludeFromSitemap,
            listingTemplate: brands.listingTemplate,
            createdAt: sql<number>`CAST(${brands.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${brands.updatedAt} AS INTEGER)`,
            ...brandLogoColumns,
        })
        .from(brands)
        .leftJoin(media, brandLogoJoinCondition())
        .where(and(eq(brands.slug, slug), ...publicBrandConditions()))
        .get();
    if (!row) return null;
    const {
        logoMediaId, logoObjectKey, logoVariantWidth, logoAltText, logoWidth, logoHeight,
        createdAt, updatedAt, ...brand
    } = row;
    return {
        ...brand,
        logo: presentBrandLogo({ logoMediaId, logoObjectKey, logoVariantWidth, logoAltText, logoWidth, logoHeight }, brand.name),
        createdAt: toIso(createdAt),
        updatedAt: toIso(updatedAt),
    };
}

export type PublicStorefrontBrand = NonNullable<Awaited<ReturnType<typeof getPublicBrandBySlug>>>;

/** One page of public brands in merchant order (sort order, then name): the brand wall and agents. */
export async function listPublicBrands(
    db: Database,
    options: { page?: number; limit?: number } = {},
) {
    const page = Number.isSafeInteger(options.page) && Number(options.page) > 0 ? Number(options.page) : 1;
    const limit = Number.isSafeInteger(options.limit)
        ? Math.min(Math.max(Number(options.limit), 1), PUBLIC_BRAND_PAGE_LIMIT)
        : 24;
    const where = and(...publicBrandConditions());
    const [counts, rows] = await db.batch([
        db.select({ count: sql<number>`count(*)` }).from(brands).where(where),
        db
            .select({
                id: brands.id,
                name: brands.name,
                slug: brands.slug,
                canonicalPath: brands.canonicalPath,
                ...brandLogoColumns,
            })
            .from(brands)
            .leftJoin(media, brandLogoJoinCondition())
            .where(where)
            .orderBy(asc(brands.sortOrder), asc(brands.name), asc(brands.id))
            .limit(limit)
            .offset((page - 1) * limit),
    ]);
    const total = Number(counts[0]?.count ?? 0);
    return {
        brands: rows.map(({ logoMediaId, logoObjectKey, logoVariantWidth, logoAltText, logoWidth, logoHeight, ...brand }) => ({
            ...brand,
            logo: presentBrandLogo({ logoMediaId, logoObjectKey, logoVariantWidth, logoAltText, logoWidth, logoHeight }, brand.name),
        })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
}

/**
 * Brand pages for XML discovery: published, live, not `noIndex` and not
 * `excludeFromSitemap`, filtered before the limit (never after a page read).
 */
export async function getPublicBrandSitemapEntries(db: Database) {
    const rows = await db
        .select({
            slug: brands.slug,
            canonicalPath: brands.canonicalPath,
            updatedAt: sql<number>`CAST(${brands.updatedAt} AS INTEGER)`,
        })
        .from(brands)
        .where(and(
            ...publicBrandConditions(),
            eq(brands.noIndex, false),
            eq(brands.excludeFromSitemap, false),
        ))
        .orderBy(asc(brands.sortOrder), asc(brands.name), asc(brands.id))
        .limit(BRAND_SITEMAP_LIMIT)
        .all();
    return rows.map((row) => ({ ...row, updatedAt: toIso(row.updatedAt) }));
}
