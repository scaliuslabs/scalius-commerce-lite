// src/modules/products/products.service.ts
// Admin product query service.
// Extracted from src/lib/admin.ts.

import { db } from "@/db";
import {
    products,
    categories,
    productVariants,
    productImages,
} from "@/db/schema";
import { and, sql, desc, eq, asc } from "drizzle-orm";
import { sanitizeFtsQuery } from "@/lib/search/fts5";
import type { Product, ProductVariant, ProductImage } from "@/db/schema";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface ProductWithDetails extends Product {
    category: { name: string };
    variants: ProductVariant[];
    images: ProductImage[];
}

export interface ProductListItem {
    id: string;
    name: string;
    slug: string;
    price: number;
    description: string | null;
    isActive: boolean;
    discountPercentage: number | null;
    freeDelivery: boolean;
    createdAt: Date;
    updatedAt: Date;
    category: {
        name: string;
    };
    variantCount: number;
    imageCount: number;
    primaryImage: string | null;
    sku?: string;
}

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

/**
 * Returns a paginated, searchable list of products for the admin dashboard.
 * Includes variant counts, image counts, and primary image URLs.
 */
export async function getProducts(options: {
    search?: string;
    categoryId?: string;
    page?: number;
    limit?: number;
    showTrashed?: boolean;
    sort?: "name" | "price" | "category" | "createdAt" | "updatedAt";
    order?: "asc" | "desc";
}) {
    const {
        search,
        categoryId,
        page = 1,
        limit = 10,
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;
    const offset = (page - 1) * limit;

    const whereConditions = [];

    if (showTrashed) {
        whereConditions.push(sql`${products.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${products.deletedAt} IS NULL`);
    }

    let rankExpression = undefined;
    if (search) {
        const sanitized = sanitizeFtsQuery(search);
        if (sanitized) {
            whereConditions.push(
                sql`(${sql.raw("products")}.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ${sanitized}) OR EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${sql.raw("product_variants")}.rowid IN (SELECT rowid FROM product_variants_fts WHERE product_variants_fts MATCH ${sanitized})))`,
            );
            rankExpression = sql`COALESCE((SELECT rank FROM products_fts WHERE rowid = products.rowid AND products_fts MATCH ${sanitized}), 0) ASC`;
        }
    }

    if (categoryId) {
        whereConditions.push(eq(products.categoryId, categoryId));
    }

    const whereClause =
        whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const countQuery = db
        .select({ count: sql<number>`count(distinct ${products.id})` })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(whereClause);

    const productResultsQuery = db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            price: products.price,
            description: products.description,
            isActive: products.isActive,
            discountPercentage: products.discountPercentage,
            freeDelivery: products.freeDelivery,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${products.deletedAt} AS INTEGER)`,
            categoryName: sql<string>`${categories.name}`.as("categoryName"),
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(
            (() => {
                if (rankExpression) {
                    return rankExpression;
                }
                const sortField = (() => {
                    switch (sort) {
                        case "name":
                            return products.name;
                        case "price":
                            return products.price;
                        case "category":
                            return categories.name;
                        case "createdAt":
                            return products.createdAt;
                        case "updatedAt":
                        default:
                            return products.updatedAt;
                    }
                })();
                return order === "asc" ? asc(sortField) : desc(sortField);
            })(),
        );

    const [[{ count }], productResults] = await db.batch([
        countQuery,
        productResultsQuery,
    ]);

    if (productResults.length === 0) {
        return {
            products: [],
            pagination: {
                total: count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
            },
        };
    }

    const productIds = productResults.map((p) => p.id);

    const [variantCounts, imageCounts, primaryImages, productSkus] = await db.batch([
        db
            .select({
                productId: productVariants.productId,
                count: sql<number>`count(${productVariants.id})`,
            })
            .from(productVariants)
            .where(
                sql`${productVariants.productId} IN ${productIds} AND ${productVariants.deletedAt} IS NULL`,
            )
            .groupBy(productVariants.productId),
        db
            .select({
                productId: productImages.productId,
                count: sql<number>`count(${productImages.id})`,
            })
            .from(productImages)
            .where(sql`${productImages.productId} IN ${productIds}`)
            .groupBy(productImages.productId),
        db
            .select({
                productId: productImages.productId,
                url: productImages.url,
            })
            .from(productImages)
            .where(
                and(
                    sql`${productImages.productId} IN ${productIds}`,
                    eq(productImages.isPrimary, true),
                ),
            ),
        db
            .select({
                productId: productVariants.productId,
                sku: productVariants.sku,
            })
            .from(productVariants)
            .where(
                sql`${productVariants.productId} IN ${productIds} AND ${productVariants.deletedAt} IS NULL`,
            )
            .orderBy(productVariants.productId, asc(productVariants.createdAt)),
    ]);

    const variantCountMap = new Map(
        variantCounts.map((vc) => [vc.productId, vc.count]),
    );

    const imageCountMap = new Map(
        imageCounts.map((ic) => [ic.productId, ic.count]),
    );

    const primaryImageMap = new Map(
        primaryImages.map((pi) => [pi.productId, pi.url]),
    );

    const skuMap = new Map<string, string>();
    productSkus.forEach((item) => {
        if (!skuMap.has(item.productId)) {
            skuMap.set(item.productId, item.sku);
        }
    });

    const combinedProducts = productResults.map((product) => ({
        id: product.id,
        name: product.name,
        slug: product.slug,
        price: product.price,
        description: product.description,
        isActive: product.isActive,
        discountPercentage: product.discountPercentage || 0,
        freeDelivery: product.freeDelivery,
        createdAt: new Date(product.createdAt * 1000),
        updatedAt: new Date(product.updatedAt * 1000),
        category: {
            name: product.categoryName || "Uncategorized",
        },
        variantCount: variantCountMap.get(product.id) || 0,
        imageCount: imageCountMap.get(product.id) || 0,
        primaryImage: primaryImageMap.get(product.id) || null,
        sku: skuMap.get(product.id) || undefined,
    }));

    return {
        products: combinedProducts,
        pagination: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit),
        },
    };
}

/**
 * Returns full product details including variants and images.
 * Returns null if the product does not exist.
 */
export async function getProductDetails(
    id: string,
): Promise<ProductWithDetails | null> {
    const [result] = await db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            categoryId: products.categoryId,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            createdAt: products.createdAt,
            updatedAt: products.updatedAt,
            deletedAt: products.deletedAt,
            isActive: products.isActive,
            discountPercentage: products.discountPercentage,
            freeDelivery: products.freeDelivery,
            category: {
                name: categories.name,
            },
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(eq(products.id, id));

    if (!result) return null;

    const variants = await db
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, id));

    const images = await db
        .select()
        .from(productImages)
        .where(eq(productImages.productId, id))
        .orderBy(productImages.sortOrder);

    return {
        ...result,
        createdAt: new Date(Number(result.createdAt) * 1000),
        updatedAt: new Date(Number(result.updatedAt) * 1000),
        deletedAt: result.deletedAt
            ? new Date(Number(result.deletedAt) * 1000)
            : null,
        variants,
        images: images.map((img) => ({
            ...img,
            createdAt: new Date(Number(img.createdAt) * 1000),
        })),
    } as ProductWithDetails;
}

/** Returns aggregate product and category counts for the products dashboard. */
export async function getProductStats() {
    const [{ count: totalProducts }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(sql`${products.deletedAt} IS NULL`);

    const [{ count: activeProducts }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(sql`${products.deletedAt} IS NULL AND ${products.isActive} = 1`);

    const [{ count: productsWithImages }] = await db
        .select({
            count: sql<number>`count(DISTINCT ${products.id})`,
        })
        .from(products)
        .innerJoin(
            productImages,
            and(
                eq(productImages.productId, products.id),
                eq(productImages.isPrimary, true),
            ),
        )
        .where(sql`${products.deletedAt} IS NULL`);

    const [{ count: categoriesCount }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(categories)
        .where(sql`${categories.deletedAt} IS NULL`);

    return {
        totalProducts,
        activeProducts,
        productsWithImages,
        categoriesCount,
    };
}

/** Returns category-level stats for the categories admin page. */
export async function getCategoryStats() {
    const [{ count: totalCategories }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(categories)
        .where(sql`${categories.deletedAt} IS NULL`);

    const [{ count: categoriesWithImages }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(categories)
        .where(
            sql`${categories.deletedAt} IS NULL AND ${categories.imageUrl} IS NOT NULL`,
        );

    const [{ count: totalProducts }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(sql`${products.deletedAt} IS NULL`);

    return {
        totalCategories,
        categoriesWithImages,
        totalProducts,
    };
}
