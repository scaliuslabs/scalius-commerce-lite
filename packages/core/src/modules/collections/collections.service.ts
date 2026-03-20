// src/modules/collections/collections.service.ts
// All DB queries and business logic for the collections domain.

import { collections, products, categories } from "@scalius/database/schema";
import { sql, and, isNull, isNotNull, eq, inArray, like, asc, desc, max, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { CreateCollectionInput, UpdateCollectionInput } from "./collections.validation";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";
import { calculateDiscountedPrice } from "@scalius/shared/price-utils";

// ─────────────────────────────────────────
// Admin queries
// ─────────────────────────────────────────

export async function listCollections(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        search?: string;
        showTrashed?: boolean;
        sort?: "name" | "type" | "isActive" | "updatedAt" | "sortOrder";
        order?: "asc" | "desc";
    } = {},
) {
    const {
        page = 1,
        limit = 20,
        search = "",
        showTrashed = false,
        sort = "sortOrder",
        order = "asc",
    } = options;

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
            sortOrder: maxSortOrder,
            config: JSON.stringify(data.config),
        })
        .returning()
        .get();
}

export async function updateCollection(
    db: Database,
    id: string,
    data: UpdateCollectionInput,
) {
    const updateData: Partial<typeof collections.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.config !== undefined) updateData.config = JSON.stringify(data.config);

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
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(collections.id, id));
}

export async function bulkDeleteCollections(
    db: Database,
    ids: string[],
    permanent = false,
): Promise<void> {
    if (permanent) {
        await db.delete(collections).where(inArray(collections.id, ids));
    } else {
        await db
            .update(collections)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(inArray(collections.id, ids));
    }
}

export async function bulkActivateCollections(db: Database, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ isActive: true, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function bulkDeactivateCollections(db: Database, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ isActive: false, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function restoreCollections(db: Database, ids: string[]): Promise<void> {
    await db
        .update(collections)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(inArray(collections.id, ids));
}

export async function reorderCollections(
    db: Database,
    items: { id: string; sortOrder: number }[],
): Promise<void> {
    for (const item of items) {
        await db
            .update(collections)
            .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
            .where(eq(collections.id, item.id));
    }
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
    hasVariants: sql<boolean>`(
        SELECT COUNT(*) > 0
        FROM "product_variants"
        WHERE "product_variants"."product_id" = "products"."id"
          AND "product_variants"."deleted_at" IS NULL
    )`.as("hasVariants"),
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

/**
 * Resolve products for a single collection config.
 * Used by the public collection detail endpoint.
 *
 * Priority: productIds > categoryIds. Featured product resolved independently.
 */
export async function resolveCollectionProducts(
    db: Database,
    config: {
        productIds?: string[];
        categoryIds?: string[];
        featuredProductId?: string;
        maxProducts?: number;
    },
): Promise<CollectionProductResult> {
    const productIds = Array.isArray(config.productIds) ? config.productIds : [];
    const categoryIds = Array.isArray(config.categoryIds) ? config.categoryIds : [];
    const maxProducts = Math.min(Math.max(config.maxProducts || 8, 1), 24);
    const hasFeaturedProduct = !!config.featuredProductId;

    const noopQuery = db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`);

    if (productIds.length > 0) {
        // CASE 1: Specific products — ignore categoryIds
        const batchResults = await db.batch([
            db.select(buildCollectionProductSelect())
                .from(products)
                .where(and(inArray(products.id, productIds), eq(products.isActive, true), isNull(products.deletedAt)))
                .limit(maxProducts),
            hasFeaturedProduct
                ? db.select(buildCollectionProductSelect())
                    .from(products)
                    .where(and(eq(products.id, config.featuredProductId!), eq(products.isActive, true), isNull(products.deletedAt)))
                : noopQuery,
        ]);

        const productsData = batchResults[0] as RawProduct[];
        const featuredData = hasFeaturedProduct ? (batchResults[1] as RawProduct[])[0] ?? null : null;

        return {
            products: productsData.map(enrichProduct),
            categories: [],
            featuredProduct: featuredData ? enrichProduct(featuredData) : null,
        };
    }

    if (categoryIds.length > 0) {
        // CASE 2: Category-based collection
        const batchResults = await db.batch([
            db.select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(inArray(categories.id, categoryIds), isNull(categories.deletedAt))),
            db.select(buildCollectionProductSelect())
                .from(products)
                .where(and(inArray(products.categoryId, categoryIds), eq(products.isActive, true), isNull(products.deletedAt)))
                .orderBy(desc(products.createdAt))
                .limit(maxProducts),
            hasFeaturedProduct
                ? db.select(buildCollectionProductSelect())
                    .from(products)
                    .where(and(eq(products.id, config.featuredProductId!), eq(products.isActive, true), isNull(products.deletedAt)))
                : noopQuery,
        ]);

        const categoriesData = batchResults[0] as { id: string; name: string; slug: string }[];
        const productsData = batchResults[1] as RawProduct[];
        const featuredData = hasFeaturedProduct ? (batchResults[2] as RawProduct[])[0] ?? null : null;

        return {
            products: productsData.map(enrichProduct),
            categories: categoriesData,
            featuredProduct: featuredData ? enrichProduct(featuredData) : null,
        };
    }

    if (hasFeaturedProduct) {
        // CASE 3: Only featured product
        const featuredData = await db.select(buildCollectionProductSelect())
            .from(products)
            .where(and(eq(products.id, config.featuredProductId!), eq(products.isActive, true), isNull(products.deletedAt)))
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
 * Batch-resolve products for multiple collections in two D1 round-trips.
 * Used by the homepage endpoint to avoid N+1 queries.
 *
 * Returns a Map from collection ID to resolved products/categories/featured.
 */
export async function resolveCollectionProductsBatch(
    db: Database,
    parsedCollections: {
        id: string;
        config: {
            productIds?: string[];
            categoryIds?: string[];
            featuredProductId?: string;
            maxProducts?: number;
        };
    }[],
): Promise<Map<string, CollectionProductResult>> {
    // Gather all IDs across collections
    const allProductIds = new Set<string>();
    const allCategoryIds = new Set<string>();
    const allFeaturedIds = new Set<string>();

    for (const col of parsedCollections) {
        const cfg = col.config;
        if (Array.isArray(cfg.productIds)) cfg.productIds.forEach((id) => allProductIds.add(id));
        if (Array.isArray(cfg.categoryIds)) cfg.categoryIds.forEach((id) => allCategoryIds.add(id));
        if (cfg.featuredProductId) allFeaturedIds.add(cfg.featuredProductId);
    }

    const productIdsArr = Array.from(allProductIds);
    const categoryIdsArr = Array.from(allCategoryIds);
    const featuredIdsArr = Array.from(allFeaturedIds);

    const noopQuery = db.select({ id: sql`NULL` }).from(products).where(sql`1 = 0`);

    const batchResults = await db.batch([
        productIdsArr.length > 0
            ? db.select(buildCollectionProductSelect()).from(products).where(and(inArray(products.id, productIdsArr), eq(products.isActive, true), isNull(products.deletedAt)))
            : noopQuery,
        categoryIdsArr.length > 0
            ? db.select(buildCollectionProductSelect()).from(products).where(and(inArray(products.categoryId, categoryIdsArr), eq(products.isActive, true), isNull(products.deletedAt)))
            : noopQuery,
        categoryIdsArr.length > 0
            ? db.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(and(inArray(categories.id, categoryIdsArr), isNull(categories.deletedAt)))
            : noopQuery,
        featuredIdsArr.length > 0
            ? db.select(buildCollectionProductSelect()).from(products).where(and(inArray(products.id, featuredIdsArr), eq(products.isActive, true), isNull(products.deletedAt)))
            : noopQuery,
    ]);

    // Build lookup maps
    const specificProductsById = new Map<string, ResolvedProduct>();
    for (const prod of batchResults[0] as RawProduct[]) {
        if (prod.id) specificProductsById.set(prod.id, enrichProduct(prod));
    }

    const categoryProductsByCategoryId = new Map<string, ResolvedProduct[]>();
    for (const prod of batchResults[1] as RawProduct[]) {
        if (prod.categoryId) {
            if (!categoryProductsByCategoryId.has(prod.categoryId)) categoryProductsByCategoryId.set(prod.categoryId, []);
            categoryProductsByCategoryId.get(prod.categoryId)!.push(enrichProduct(prod));
        }
    }

    const categoryMetadataById = new Map<string, { id: string; name: string; slug: string }>();
    for (const cat of batchResults[2] as { id: string; name: string; slug: string }[]) {
        if (cat.id) categoryMetadataById.set(cat.id, cat);
    }

    const featuredProductsById = new Map<string, ResolvedProduct>();
    for (const prod of batchResults[3] as RawProduct[]) {
        if (prod.id) featuredProductsById.set(prod.id, enrichProduct(prod));
    }

    // Resolve per-collection
    const results = new Map<string, CollectionProductResult>();

    for (const col of parsedCollections) {
        const cfg = col.config;
        const productIds = Array.isArray(cfg.productIds) ? cfg.productIds : [];
        const categoryIds = Array.isArray(cfg.categoryIds) ? cfg.categoryIds : [];
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
