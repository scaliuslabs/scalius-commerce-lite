// src/modules/collections/collections.service.ts
// All DB queries and business logic for the collections domain.

import { collections, products, categories } from "@scalius/database/schema";
import { sql, and, isNull, isNotNull, eq, inArray, like, asc, desc, max, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { CreateCollectionInput, UpdateCollectionInput } from "./collections.validation";
import { safeBatch, type Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";
import { calculateDiscountedPrice } from "@scalius/shared/price-utils";
import {
    publicCollectionProductConditions,
    publicProductHasCustomerOptions,
} from "../products/products.public-eligibility";
import { normalizeCollectionConfig, stringifyCollectionConfig } from "./collection-config";

// ─────────────────────────────────────────
// Admin queries
// ─────────────────────────────────────────

const ALLOWED_COLLECTION_SORT_FIELDS = ["name", "type", "isActive", "updatedAt", "sortOrder"] as const;
type CollectionSortField = typeof ALLOWED_COLLECTION_SORT_FIELDS[number];

export async function listCollections(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        showTrashed?: boolean;
        sort?: CollectionSortField;
        order?: "asc" | "desc";
    } = {},
) {
    const {
        page = 1,
        limit: rawLimit = 20,
        search = "",
        showTrashed = false,
        order = "asc",
    } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 100);
    const sort: CollectionSortField = ALLOWED_COLLECTION_SORT_FIELDS.includes(options.sort as CollectionSortField)
        ? (options.sort as CollectionSortField)
        : "sortOrder";

    const whereConditions: (SQL | undefined)[] = [];
    if (showTrashed) {
        whereConditions.push(isNotNull(collections.deletedAt));
    } else {
        whereConditions.push(isNull(collections.deletedAt));
    }
    if (search) {
        whereConditions.push(like(collections.name, `%${search}%`));
    }

    const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;
    const offset = (page - 1) * limit;

    const total = await db
        .select({ count: sql`count(*)` })
        .from(collections)
        .where(whereClause)
        .then((rows: { count: unknown }[]) => Number(rows[0]?.count || 0));

    const sortColumn = (() => {
        switch (sort) {
            case "name": return collections.name;
            case "type": return collections.type;
            case "isActive": return collections.isActive;
            case "updatedAt": return collections.updatedAt;
            default: return collections.sortOrder;
        }
    })();

    const items = await db
        .select()
        .from(collections)
        .where(whereClause)
        .orderBy(order === "desc" ? desc(sortColumn) : asc(sortColumn))
        .limit(limit)
        .offset(offset);

    return {
        collections: items,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getCollectionById(db: Database, id: string) {
    return db
        .select()
        .from(collections)
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
        .limit(1)
        .then((rows: (typeof collections.$inferSelect)[]) => rows[0] ?? null);
}

function normalizeLookupIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, 100);
}

export async function getCollectionsByIds(db: Database, ids: string[]) {
    const lookupIds = normalizeLookupIds(ids);
    if (lookupIds.length === 0) return [];

    const orderById = new Map(lookupIds.map((id, index) => [id, index]));
    const rows = await db
        .select({
            id: collections.id,
            name: collections.name,
            type: collections.type,
        })
        .from(collections)
        .where(and(inArray(collections.id, lookupIds), isNull(collections.deletedAt)));

    return rows.sort(
        (a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0),
    );
}

export async function getCollectionCategoryOptions(db: Database) {
    return db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(isNull(categories.deletedAt))
        .limit(500);
}

// ─────────────────────────────────────────
// Admin mutations
// ─────────────────────────────────────────

export async function createCollection(
    db: Database,
    data: CreateCollectionInput,
) {
    const maxSortOrder = await db
        .select({ max: max(collections.sortOrder) })
        .from(collections)
        .where(isNull(collections.deletedAt))
        .then((result: { max: number | null }[]) => (result[0]?.max ?? -1) + 1);

    return db
        .insert(collections)
        .values({
            id: nanoid(),
            name: data.name,
            type: data.type,
            isActive: data.isActive,
            noIndex: data.noIndex ?? false,
            excludeFromSitemap: data.excludeFromSitemap ?? false,
            sortOrder: maxSortOrder,
            config: stringifyCollectionConfig(data.config),
        })
        .returning()
        .get();
}

export async function updateCollection(
    db: Database,
    id: string,
    data: UpdateCollectionInput,
) {
    const existing = await db.select({ id: collections.id }).from(collections).where(eq(collections.id, id)).get();
    if (!existing) throw new NotFoundError("Collection not found");

    const updateData: Record<string, unknown> = { updatedAt: sql`(unixepoch())` };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.noIndex !== undefined) updateData.noIndex = data.noIndex;
    if (data.excludeFromSitemap !== undefined) updateData.excludeFromSitemap = data.excludeFromSitemap;
    if (data.config !== undefined) updateData.config = stringifyCollectionConfig(data.config);

    return db
        .update(collections)
        .set(updateData)
        .where(eq(collections.id, id))
        .returning()
        .get();
}

export async function deleteCollection(db: Database, id: string): Promise<void> {
    const existing = await getCollectionById(db, id);
    if (!existing) throw new NotFoundError("Collection not found");

    await db
        .update(collections)
        .set({ deletedAt: sql`(unixepoch())`, updatedAt: sql`(unixepoch())` })
        .where(eq(collections.id, id));
}

export async function bulkDeleteCollections(
    db: Database,
    ids: string[],
    permanent = false,
): Promise<void> {
    if (ids.length === 0) return;

    if (permanent) {
        await db.delete(collections).where(inArray(collections.id, ids));
    } else {
        await db
            .update(collections)
            .set({ deletedAt: sql`(unixepoch())`, updatedAt: sql`(unixepoch())` })
            .where(inArray(collections.id, ids));
    }
}

export async function bulkActivateCollections(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await db
        .update(collections)
        .set({ isActive: true, updatedAt: sql`(unixepoch())` })
        .where(inArray(collections.id, ids));
}

export async function bulkDeactivateCollections(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await db
        .update(collections)
        .set({ isActive: false, updatedAt: sql`(unixepoch())` })
        .where(inArray(collections.id, ids));
}

export async function restoreCollections(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await db
        .update(collections)
        .set({ deletedAt: null, updatedAt: sql`(unixepoch())` })
        .where(inArray(collections.id, ids));
}

export async function reorderCollections(
    db: Database,
    items: { id: string; sortOrder: number }[],
): Promise<void> {
    if (items.length === 0) return;

    await safeBatch(
        db,
        items.map((item) =>
            db.update(collections)
                .set({ sortOrder: item.sortOrder, updatedAt: sql`(unixepoch())` })
                .where(eq(collections.id, item.id))
        )
    );
}

// ─────────────────────────────────────────
// Storefront: product resolution
// ─────────────────────────────────────────

/** Product select shape used for collection product resolution. */
const buildCollectionProductSelect = () => ({
    id: products.id,
    name: products.name,
    slug: products.slug,
    price: products.price,
    discountType: products.discountType,
    discountPercentage: products.discountPercentage,
    discountAmount: products.discountAmount,
    freeDelivery: products.freeDelivery,
    categoryId: products.categoryId,
    imageUrl: sql<string | null>`(
        SELECT "product_images"."url"
        FROM "product_images"
        WHERE "product_images"."product_id" = "products"."id"
          AND "product_images"."is_primary" = 1
        ORDER BY "product_images"."sort_order" ASC
        LIMIT 1
    )`.as("imageUrl"),
    imageAlt: sql<string | null>`(
        SELECT "product_images"."alt"
        FROM "product_images"
        WHERE "product_images"."product_id" = "products"."id"
          AND "product_images"."is_primary" = 1
        ORDER BY "product_images"."sort_order" ASC
        LIMIT 1
    )`.as("imageAlt"),
    hasVariants: publicProductHasCustomerOptions(sql`${products.id}`).as("hasVariants"),
});

type RawProduct = {
    id: string;
    name: string;
    slug: string;
    price: number;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
    freeDelivery: boolean;
    categoryId: string | null;
    imageUrl: string | null;
    imageAlt: string | null;
    hasVariants: boolean;
};

export type ResolvedProduct = RawProduct & { discountedPrice: number };

function enrichProduct(p: RawProduct): ResolvedProduct {
    return {
        ...p,
        discountedPrice: calculateDiscountedPrice(
            p.price,
            p.discountType,
            p.discountPercentage,
            p.discountAmount,
        ),
    };
}

export interface CollectionProductResult {
    products: ResolvedProduct[];
    categories: { id: string; name: string; slug: string }[];
    featuredProduct: ResolvedProduct | null;
}

function uniqueNonEmptyIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

/**
 * Resolve products for a single collection config.
 * Used by the public collection detail endpoint.
 *
 * Priority: productIds > categoryIds. Featured product resolved independently.
 */
export async function resolveCollectionProducts(
    db: Database,
    rawConfig: unknown,
): Promise<CollectionProductResult> {
    const config = normalizeCollectionConfig(rawConfig);
    const productIds = Array.isArray(config.productIds) ? config.productIds : [];
    const categoryIds = Array.isArray(config.categoryIds) ? config.categoryIds : [];
    const maxProducts = Math.min(Math.max(config.maxProducts || 8, 1), 24);
    const hasFeaturedProduct = !!config.featuredProductId;

    const noopQuery = db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`);

    if (productIds.length > 0) {
        // CASE 1: Specific products — ignore categoryIds
        const specificProductIds = uniqueNonEmptyIds(productIds).slice(0, 100);
        const batchResults = await db.batch([
            specificProductIds.length > 0
                ? db.select(buildCollectionProductSelect())
                    .from(products)
                    .where(and(...publicCollectionProductConditions(inArray(products.id, specificProductIds))))
                    .limit(specificProductIds.length)
                : noopQuery,
            hasFeaturedProduct
                ? db.select(buildCollectionProductSelect())
                    .from(products)
                    .where(and(...publicCollectionProductConditions(eq(products.id, config.featuredProductId!))))
                : noopQuery,
        ]);

        const productsData = batchResults[0] as RawProduct[];
        const featuredData = hasFeaturedProduct ? (batchResults[1] as RawProduct[])[0] ?? null : null;
        const productsById = new Map(
            productsData.map((product) => [product.id, enrichProduct(product)]),
        );

        return {
            products: specificProductIds
                .map((id) => productsById.get(id))
                .filter((product): product is ResolvedProduct => product != null)
                .slice(0, maxProducts),
            categories: [],
            featuredProduct: featuredData ? enrichProduct(featuredData) : null,
        };
    }

    if (categoryIds.length > 0) {
        // CASE 2: Category-based collection
        const specificCategoryIds = uniqueNonEmptyIds(categoryIds);
        const batchResults = await db.batch([
            db.select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(inArray(categories.id, specificCategoryIds), isNull(categories.deletedAt))),
            db.select(buildCollectionProductSelect())
                .from(products)
                .where(and(...publicCollectionProductConditions(inArray(products.categoryId, specificCategoryIds))))
                .orderBy(desc(products.createdAt))
                .limit(maxProducts),
            hasFeaturedProduct
                ? db.select(buildCollectionProductSelect())
                    .from(products)
                    .where(and(...publicCollectionProductConditions(eq(products.id, config.featuredProductId!))))
                : noopQuery,
        ]);

        const categoriesData = batchResults[0] as { id: string; name: string; slug: string }[];
        const productsData = batchResults[1] as RawProduct[];
        const featuredData = hasFeaturedProduct ? (batchResults[2] as RawProduct[])[0] ?? null : null;
        const categoriesById = new Map(categoriesData.map((category) => [category.id, category]));

        return {
            products: productsData.map(enrichProduct),
            categories: specificCategoryIds
                .map((id) => categoriesById.get(id))
                .filter((category): category is { id: string; name: string; slug: string } => category != null),
            featuredProduct: featuredData ? enrichProduct(featuredData) : null,
        };
    }

    if (hasFeaturedProduct) {
        // CASE 3: Only featured product
        const featuredData = await db.select(buildCollectionProductSelect())
            .from(products)
            .where(and(...publicCollectionProductConditions(eq(products.id, config.featuredProductId!))))
            .get() as RawProduct | undefined;

        return {
            products: [],
            categories: [],
            featuredProduct: featuredData ? enrichProduct(featuredData) : null,
        };
    }

    // CASE 4: Empty config
    return { products: [], categories: [], featuredProduct: null };
}

/**
 * Batch-resolve products for multiple collections.
 * Used by the homepage endpoint to avoid unbounded category product reads.
 *
 * Returns a Map from collection ID to resolved products/categories/featured.
 */
export async function resolveCollectionProductsBatch(
    db: Database,
    parsedCollections: {
        id: string;
        config: unknown;
    }[],
): Promise<Map<string, CollectionProductResult>> {
    // Gather all IDs across collections
    const allProductIds = new Set<string>();
    const categoryProductLimitsById = new Map<string, number>();
    const allFeaturedIds = new Set<string>();

    for (const col of parsedCollections) {
        const cfg = normalizeCollectionConfig(col.config);
        cfg.productIds.forEach((id) => allProductIds.add(id));
        if (cfg.productIds.length === 0) {
            cfg.categoryIds.forEach((id) => {
                categoryProductLimitsById.set(
                    id,
                    Math.max(categoryProductLimitsById.get(id) ?? 0, cfg.maxProducts),
                );
            });
        }
        if (cfg.featuredProductId) allFeaturedIds.add(cfg.featuredProductId);
    }

    const productIdsArr = Array.from(allProductIds);
    const categoryProductLimits = Array.from(
        categoryProductLimitsById.entries(),
        ([categoryId, maxProducts]) => ({ categoryId, maxProducts }),
    );
    const categoryIdsArr = categoryProductLimits.map(({ categoryId }) => categoryId);
    const featuredIdsArr = Array.from(allFeaturedIds);

    const noopQuery = db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`);

    const batchResults = await safeBatch(db, [
        productIdsArr.length > 0
            ? db.select(buildCollectionProductSelect()).from(products).where(and(...publicCollectionProductConditions(inArray(products.id, productIdsArr))))
            : noopQuery,
        ...categoryProductLimits.map(({ categoryId, maxProducts }) =>
            db.select(buildCollectionProductSelect())
                .from(products)
                .where(and(...publicCollectionProductConditions(eq(products.categoryId, categoryId))))
                .orderBy(desc(products.createdAt), asc(products.id))
                .limit(maxProducts),
        ),
        categoryIdsArr.length > 0
            ? db.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(and(inArray(categories.id, categoryIdsArr), isNull(categories.deletedAt)))
            : noopQuery,
        featuredIdsArr.length > 0
            ? db.select(buildCollectionProductSelect()).from(products).where(and(...publicCollectionProductConditions(inArray(products.id, featuredIdsArr))))
            : noopQuery,
    ]);
    const categoryProductsStartIndex = 1;
    const categoryMetadataIndex = categoryProductsStartIndex + categoryProductLimits.length;
    const featuredProductsIndex = categoryMetadataIndex + 1;

    // Build lookup maps
    const specificProductsById = new Map<string, ResolvedProduct>();
    for (const prod of batchResults[0] as RawProduct[]) {
        if (prod.id) specificProductsById.set(prod.id, enrichProduct(prod));
    }

    const categoryProductsByCategoryId = new Map<string, ResolvedProduct[]>();
    categoryProductLimits.forEach(({ categoryId }, index) => {
        const productsData = batchResults[categoryProductsStartIndex + index] as RawProduct[];
        const resolvedProducts = productsData
            .filter((prod) => prod.id && prod.categoryId === categoryId)
            .map(enrichProduct);
        if (resolvedProducts.length > 0) {
            categoryProductsByCategoryId.set(categoryId, resolvedProducts);
        }
    });

    const categoryMetadataById = new Map<string, { id: string; name: string; slug: string }>();
    for (const cat of batchResults[categoryMetadataIndex] as { id: string; name: string; slug: string }[]) {
        if (cat.id) categoryMetadataById.set(cat.id, cat);
    }

    const featuredProductsById = new Map<string, ResolvedProduct>();
    for (const prod of batchResults[featuredProductsIndex] as RawProduct[]) {
        if (prod.id) featuredProductsById.set(prod.id, enrichProduct(prod));
    }

    // Resolve per-collection
    const results = new Map<string, CollectionProductResult>();

    for (const col of parsedCollections) {
        const cfg = normalizeCollectionConfig(col.config);
        const productIds = cfg.productIds;
        const categoryIds = cfg.categoryIds;
        const maxProducts = Math.min(Math.max(cfg.maxProducts || 8, 1), 24);

        let collectionProducts: ResolvedProduct[] = [];
        let collectionCategories: { id: string; name: string; slug: string }[] = [];

        if (productIds.length > 0) {
            collectionProducts = productIds
                .map((id) => specificProductsById.get(id))
                .filter((p): p is ResolvedProduct => p != null)
                .slice(0, maxProducts);
        } else if (categoryIds.length > 0) {
            const all: ResolvedProduct[] = [];
            for (const catId of categoryIds) {
                all.push(...(categoryProductsByCategoryId.get(catId) || []));
            }
            const seen = new Set<string>();
            collectionProducts = all.filter((p) => {
                if (seen.has(p.id)) return false;
                seen.add(p.id);
                return true;
            }).slice(0, maxProducts);
            collectionCategories = categoryIds
                .map((id) => categoryMetadataById.get(id))
                .filter((c): c is { id: string; name: string; slug: string } => c != null);
        }

        const featuredProduct = cfg.featuredProductId
            ? featuredProductsById.get(cfg.featuredProductId) ?? null
            : null;

        results.set(col.id, { products: collectionProducts, categories: collectionCategories, featuredProduct });
    }

    return results;
}
