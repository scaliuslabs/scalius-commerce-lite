// src/modules/products/products.service.ts
// Product service: admin queries, storefront queries, and CRUD mutations.

import { db } from "@/db";
import {
    products,
    categories,
    productVariants,
    productImages,
    productRichContent,
    productAttributeValues,
    productAttributes,
} from "@/db/schema";
import { and, sql, desc, eq, asc, isNull, inArray, or } from "drizzle-orm";
import { sanitizeFtsQuery, ftsMatch } from "@/lib/search/fts5";
import type { Product, ProductVariant, ProductImage } from "@/db/schema";
import type { CreateProductInput, UpdateProductInput } from "./products.validation";
import { nanoid } from "nanoid";

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

// ─────────────────────────────────────────
// Write operations (Admin CRUD)
// ─────────────────────────────────────────

/**
 * Creates a new product along with its images, rich content, and attribute values.
 * Checks for slug uniqueness before inserting.
 * Returns the new product ID on success.
 */
export async function createProduct(data: CreateProductInput): Promise<{ id: string }> {
    const existingProduct = await db
        .select({ id: products.id })
        .from(products)
        .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
        .get();

    if (existingProduct) {
        throw new Error("A product with this slug already exists");
    }

    const productId = "prod_" + nanoid();

    const batchOps: any[] = [
        db.insert(products).values({
            id: productId,
            name: data.name,
            description: data.description || null,
            price: data.price,
            categoryId: data.categoryId,
            slug: data.slug,
            metaTitle: data.metaTitle || null,
            metaDescription: data.metaDescription || null,
            isActive: data.isActive,
            discountType: data.discountType || "percentage",
            discountPercentage: data.discountPercentage || null,
            discountAmount: data.discountAmount || null,
            freeDelivery: data.freeDelivery,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
            deletedAt: null,
        }),
    ];

    if (data.images.length > 0) {
        batchOps.push(
            db.insert(productImages).values(
                data.images.map((image, index) => ({
                    id: "img_" + nanoid(),
                    productId,
                    url: image.url,
                    alt: image.filename,
                    isPrimary: index === 0,
                    sortOrder: index,
                })),
            ),
        );
    }

    if (data.additionalInfo && data.additionalInfo.length > 0) {
        batchOps.push(
            db.insert(productRichContent).values(
                data.additionalInfo.map((item) => ({
                    id: `prc_${nanoid()}`,
                    productId,
                    title: item.title,
                    content: item.content,
                    sortOrder: item.sortOrder,
                })),
            ),
        );
    }

    if (data.attributes && data.attributes.length > 0) {
        const attributeValuesToInsert = data.attributes
            .filter((attr) => attr.attributeId && attr.value.trim())
            .map((attr) => ({
                id: `val_${nanoid()}`,
                productId,
                attributeId: attr.attributeId,
                value: attr.value,
            }));
        if (attributeValuesToInsert.length > 0) {
            batchOps.push(db.insert(productAttributeValues).values(attributeValuesToInsert));
        }
    }

    await db.batch(batchOps as any);
    return { id: productId };
}

/**
 * Updates an existing product, replacing images, rich content, and attributes.
 * Validates that the product exists and the slug is not taken by another product.
 */
export async function updateProduct(id: string, data: UpdateProductInput): Promise<void> {
    const existingProduct = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, id))
        .get();

    if (!existingProduct) {
        throw new Error("Product not found");
    }

    const existingSlug = await db
        .select({ id: products.id })
        .from(products)
        .where(
            and(
                eq(products.slug, data.slug),
                sql`${products.id} != ${id}`,
                sql`${products.deletedAt} IS NULL`,
            ),
        )
        .get();

    if (existingSlug) {
        throw new Error("A product with this slug already exists");
    }

    const attributeValuesToInsert = (data.attributes ?? [])
        .filter((attr) => attr.attributeId && attr.value.trim())
        .map((attr) => ({
            id: `val_${nanoid()}`,
            productId: id,
            attributeId: attr.attributeId,
            value: attr.value,
        }));

    const contentToInsert = (data.additionalInfo ?? [])
        .filter((item) => item.title.trim() && item.content.trim())
        .map((item) => ({
            id: item.id.startsWith("item-") ? `prc_${nanoid()}` : item.id,
            productId: id,
            title: item.title,
            content: item.content,
            sortOrder: item.sortOrder,
        }));

    const batchOps: any[] = [
        db.update(products)
            .set({
                name: data.name,
                description: data.description,
                price: data.price,
                categoryId: data.categoryId,
                slug: data.slug,
                metaTitle: data.metaTitle,
                metaDescription: data.metaDescription,
                isActive: data.isActive,
                discountType: data.discountType || "percentage",
                discountPercentage: data.discountPercentage,
                discountAmount: data.discountAmount,
                freeDelivery: data.freeDelivery,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(products.id, id)),
        db.delete(productImages).where(eq(productImages.productId, id)),
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.delete(productRichContent).where(eq(productRichContent.productId, id)),
    ];

    if (data.images.length > 0) {
        batchOps.push(
            db.insert(productImages).values(
                data.images.map((image, index) => ({
                    id: image.id.startsWith("temp_") ? `img_${nanoid()}` : image.id,
                    productId: id,
                    url: image.url,
                    alt: image.filename,
                    isPrimary: index === 0,
                    sortOrder: index,
                })),
            ),
        );
    }

    if (attributeValuesToInsert.length > 0) {
        batchOps.push(db.insert(productAttributeValues).values(attributeValuesToInsert));
    }

    if (contentToInsert.length > 0) {
        batchOps.push(db.insert(productRichContent).values(contentToInsert));
    }

    await db.batch(batchOps as any);
}

/**
 * Soft-deletes a product by setting deletedAt.
 */
export async function deleteProduct(id: string): Promise<void> {
    await db
        .update(products)
        .set({ deletedAt: sql`unixepoch()` })
        .where(eq(products.id, id));
}

// ─────────────────────────────────────────
// Storefront queries
// ─────────────────────────────────────────

const unixToDate = (timestamp: number | null): Date | null => {
    if (timestamp === null || timestamp === undefined) return null;
    return new Date(timestamp * 1000);
};

function extractFeatures(description: string | null): string[] {
    if (!description) return [];
    const features: string[] = [];
    const lines = description.split("\n");
    for (const line of lines) {
        if (line.trim().match(/^[-*•]|^\d+\./) && line.trim().length > 2) {
            features.push(line.trim().replace(/^[-*•]|^\d+\./, "").trim());
        }
    }
    return features;
}

function calculateDiscountedPrice(
    price: number,
    discountType: string | null,
    discountPercentage: number | null,
    discountAmount: number | null,
): number {
    if (discountType === "flat" && discountAmount) {
        return Math.max(0, Math.round(price - discountAmount));
    } else if (discountType === "percentage" && discountPercentage) {
        return Math.round(price * (1 - discountPercentage / 100));
    }
    return price;
}

export interface StorefrontProductFilterInput {
    category?: string;
    search?: string;
    page?: number;
    limit?: number;
    sort?: "newest" | "price-asc" | "price-desc" | "name-asc" | "name-desc" | "discount";
    minPrice?: number;
    maxPrice?: number;
    freeDelivery?: "true" | "false";
    hasDiscount?: "true" | "false";
    ids?: string;
    attributeFilters?: { slug: string; value: string }[];
}

/**
 * Returns a paginated list of active storefront products with images and categories.
 * This is the unified query backing the Hono GET /api/storefront/products route.
 */
export async function getStorefrontProducts(params: StorefrontProductFilterInput) {
    const {
        category,
        search,
        page = 1,
        limit = 20,
        sort = "newest",
        minPrice,
        maxPrice,
        freeDelivery,
        hasDiscount,
        ids,
        attributeFilters = [],
    } = params;

    const conditions: any[] = [
        eq(products.isActive, true),
        isNull(products.deletedAt),
    ];

    if (category) conditions.push(eq(products.categoryId, category));
    if (search) {
        const cond = ftsMatch("products_fts", "products", search);
        if (cond) conditions.push(cond);
    }
    if (minPrice !== undefined) conditions.push(sql`${products.price} >= ${minPrice}`);
    if (maxPrice !== undefined) conditions.push(sql`${products.price} <= ${maxPrice}`);
    if (freeDelivery === "true") conditions.push(eq(products.freeDelivery, true));
    else if (freeDelivery === "false") conditions.push(eq(products.freeDelivery, false));
    if (hasDiscount === "true") conditions.push(sql`${products.discountPercentage} > 0`);
    else if (hasDiscount === "false") conditions.push(sql`${products.discountPercentage} = 0 OR ${products.discountPercentage} IS NULL`);
    if (ids) {
        const productIds = ids.split(",");
        conditions.push(inArray(products.id, productIds));
    }

    let orderBy: any;
    if (sort === "price-asc") {
        orderBy = sql`CASE WHEN ${products.discountPercentage} > 0 THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100)) ELSE ${products.price} END`;
    } else if (sort === "price-desc") {
        orderBy = desc(sql`CASE WHEN ${products.discountPercentage} > 0 THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100)) ELSE ${products.price} END`);
    } else if (sort === "name-asc") {
        orderBy = products.name;
    } else if (sort === "name-desc") {
        orderBy = desc(products.name);
    } else if (sort === "discount") {
        orderBy = desc(products.discountPercentage);
    } else {
        orderBy = desc(products.createdAt);
    }

    const offset = (page - 1) * limit;

    let query = db
        .select({
            id: products.id,
            name: products.name,
            price: products.price,
            slug: products.slug,
            discountType: products.discountType,
            discountPercentage: products.discountPercentage,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("createdAt"),
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            variantCount: sql<number>`count(${productVariants.id})`.as("variantCount"),
        })
        .from(products)
        .where(and(...conditions))
        .leftJoin(
            productVariants,
            and(eq(products.id, productVariants.productId), isNull(productVariants.deletedAt)),
        )
        .groupBy(
            products.id, products.name, products.price, products.slug,
            products.discountType, products.discountPercentage, products.discountAmount,
            products.freeDelivery, products.categoryId, products.createdAt, products.updatedAt,
        );

    if (attributeFilters.length > 0) {
        const subquery = db
            .select({ productId: productAttributeValues.productId })
            .from(productAttributeValues)
            .leftJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))
            .where(
                or(
                    ...attributeFilters.map((filter) =>
                        and(
                            eq(productAttributes.slug, filter.slug),
                            eq(productAttributeValues.value, filter.value),
                        ),
                    ),
                )!,
            )
            .groupBy(productAttributeValues.productId)
            .having(sql`count(*) = ${attributeFilters.length}`)
            .as("filtered_products");

        query = query.innerJoin(subquery, eq(products.id, subquery.productId));
    }

    const productsList = await query.orderBy(orderBy).limit(limit).offset(offset).all();
    const productIds = productsList.map((p) => p.id);

    let imageMap = new Map<string, string>();
    if (productIds.length > 0) {
        const images = await db
            .select({ productId: productImages.productId, url: productImages.url })
            .from(productImages)
            .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds)))
            .all();
        imageMap = new Map(images.map((img) => [img.productId, img.url]));
    }

    let categoryMap = new Map<string, any>();
    const categoryIds = [...new Set(productsList.map((p) => p.categoryId).filter(Boolean))] as string[];
    if (categoryIds.length > 0) {
        const categoriesData = await db
            .select({ id: categories.id, name: categories.name, slug: categories.slug })
            .from(categories)
            .where(inArray(categories.id, categoryIds))
            .all();
        categoryMap = new Map(categoriesData.map((cat) => [cat.id, cat]));
    }

    const productsWithImages = productsList.map(({ variantCount, ...product }) => ({
        ...product,
        hasVariants: variantCount > 0,
        imageUrl: imageMap.get(product.id) || null,
        category: product.categoryId ? categoryMap.get(product.categoryId) || null : null,
        createdAt: unixToDate(product.createdAt)?.toISOString() || null,
        updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        discountedPrice: calculateDiscountedPrice(
            product.price, product.discountType,
            product.discountPercentage, product.discountAmount,
        ),
    }));

    // Count query
    let countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(and(...conditions));

    if (attributeFilters.length > 0) {
        const countSubquery = db
            .select({ productId: productAttributeValues.productId })
            .from(productAttributeValues)
            .leftJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))
            .where(
                or(
                    ...attributeFilters.map((filter) =>
                        and(
                            eq(productAttributes.slug, filter.slug),
                            eq(productAttributeValues.value, filter.value),
                        ),
                    ),
                )!,
            )
            .groupBy(productAttributeValues.productId)
            .having(sql`count(*) = ${attributeFilters.length}`)
            .as("count_filtered_products");
        countQuery = countQuery.innerJoin(countSubquery, eq(products.id, countSubquery.productId));
    }

    const totalCount = await countQuery.get();

    return {
        products: productsWithImages,
        pagination: {
            page,
            limit,
            total: totalCount?.count || 0,
            totalPages: Math.ceil((totalCount?.count || 0) / limit),
        },
    };
}

/**
 * Returns full storefront product details (variants, images, attributes, related products)
 * for a single product identified by slug.
 */
export async function getStorefrontProductBySlug(slug: string) {
    const product = await db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            categoryId: products.categoryId,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            discountType: products.discountType,
            discountPercentage: products.discountPercentage,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            isActive: products.isActive,
            deletedAt: sql<number | null>`CAST(${products.deletedAt} AS INTEGER)`,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
        })
        .from(products)
        .where(and(eq(products.slug, slug), eq(products.isActive, true), isNull(products.deletedAt)))
        .get();

    if (!product) return null;

    const promises: Promise<any>[] = [
        db.select({
            id: productImages.id,
            productId: productImages.productId,
            url: productImages.url,
            alt: productImages.alt,
            isPrimary: productImages.isPrimary,
            sortOrder: productImages.sortOrder,
            createdAt: sql<number>`CAST(${productImages.createdAt} AS INTEGER)`,
        }).from(productImages).where(eq(productImages.productId, product.id)).orderBy(productImages.sortOrder).all()
            .then((res) => ({ type: "images", data: res })),

        db.select({
            id: productVariants.id,
            productId: productVariants.productId,
            size: productVariants.size,
            color: productVariants.color,
            weight: productVariants.weight,
            sku: productVariants.sku,
            price: productVariants.price,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            discountType: productVariants.discountType,
            discountPercentage: productVariants.discountPercentage,
            discountAmount: productVariants.discountAmount,
            colorSortOrder: productVariants.colorSortOrder,
            sizeSortOrder: productVariants.sizeSortOrder,
            createdAt: sql<number>`CAST(${productVariants.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${productVariants.updatedAt} AS INTEGER)`,
            deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`,
        }).from(productVariants)
            .where(and(eq(productVariants.productId, product.id), isNull(productVariants.deletedAt)))
            .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder, productVariants.createdAt)
            .all().then((res) => ({ type: "variants", data: res })),

        db.select({
            id: productRichContent.id,
            title: productRichContent.title,
            content: productRichContent.content,
        }).from(productRichContent).where(eq(productRichContent.productId, product.id))
            .orderBy(productRichContent.sortOrder).then((res) => ({ type: "additionalInfo", data: res })),

        db.select({
            name: productAttributes.name,
            value: productAttributeValues.value,
            slug: productAttributes.slug,
        }).from(productAttributeValues)
            .innerJoin(productAttributes, and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                isNull(productAttributes.deletedAt),
                eq(productAttributes.filterable, true),
            ))
            .where(eq(productAttributeValues.productId, product.id))
            .then((res) => ({ type: "attributes", data: res })),
    ];

    if (product.categoryId) {
        promises.push(
            db.select({
                id: categories.id, name: categories.name, slug: categories.slug,
                description: categories.description, imageUrl: categories.imageUrl,
                metaTitle: categories.metaTitle, metaDescription: categories.metaDescription,
            }).from(categories).where(eq(categories.id, product.categoryId!)).get()
                .then((res) => ({ type: "category", data: res })),
        );

        promises.push(
            (async () => {
                const relatedProds = await db.select({
                    id: products.id, name: products.name, price: products.price,
                    slug: products.slug, discountType: products.discountType,
                    discountPercentage: products.discountPercentage, discountAmount: products.discountAmount,
                    freeDelivery: products.freeDelivery,
                }).from(products)
                    .where(and(
                        eq(products.categoryId, product.categoryId!),
                        eq(products.isActive, true),
                        isNull(products.deletedAt),
                        sql`${products.id} != ${product.id}`,
                    )).limit(6).all();

                if (relatedProds.length === 0) return { type: "relatedProducts", data: [] };

                const relatedIds = relatedProds.map((p) => p.id);
                const relatedImages = await db
                    .select({ productId: productImages.productId, url: productImages.url })
                    .from(productImages)
                    .where(and(inArray(productImages.productId, relatedIds), eq(productImages.isPrimary, true)))
                    .all();

                const relatedImageMap = new Map(relatedImages.map((img) => [img.productId, img.url]));

                return {
                    type: "relatedProducts",
                    data: relatedProds.map((rp) => ({
                        ...rp,
                        imageUrl: relatedImageMap.get(rp.id) || null,
                        discountedPrice: calculateDiscountedPrice(rp.price, rp.discountType, rp.discountPercentage, rp.discountAmount),
                    })),
                };
            })(),
        );
    }

    const results = await Promise.all(promises);

    const images = (results.find((r) => r.type === "images")?.data as any[]) || [];
    const variants = (results.find((r) => r.type === "variants")?.data as any[]) || [];
    const category = (results.find((r) => r.type === "category")?.data as any) || null;
    const additionalInfo = (results.find((r) => r.type === "additionalInfo")?.data as any[]) || [];
    const relatedProducts = (results.find((r) => r.type === "relatedProducts")?.data as any[]) || [];
    const attributes = (results.find((r) => r.type === "attributes")?.data as any[]) || [];

    const hasVariants = variants.length > 0;

    const formattedVariants = hasVariants
        ? variants.map((v) => ({
            ...v,
            createdAt: unixToDate(v.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(v.updatedAt)?.toISOString() || null,
            deletedAt: v.deletedAt ? unixToDate(v.deletedAt)?.toISOString() : null,
        }))
        : [{
            id: "default",
            productId: product.id,
            size: null, color: null, weight: null,
            sku: `SKU-${product.id}`,
            price: product.price,
            stock: 100,
            discountType: "percentage",
            discountPercentage: 0,
            discountAmount: 0,
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
            deletedAt: null,
        }];

    return {
        product: {
            ...product,
            hasVariants,
            createdAt: unixToDate(product.createdAt)?.toISOString() || null,
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
            deletedAt: product.deletedAt ? unixToDate(product.deletedAt)?.toISOString() : null,
            discountType: product.discountType || "percentage",
            discountPercentage: product.discountPercentage || 0,
            discountAmount: product.discountAmount || 0,
            freeDelivery: product.freeDelivery || false,
            features: extractFeatures(product.description),
            discountedPrice: calculateDiscountedPrice(
                product.price, product.discountType,
                product.discountPercentage, product.discountAmount,
            ),
            attributes,
            additionalInfo,
        },
        category,
        images: images.map((img) => ({
            ...img,
            createdAt: unixToDate(img.createdAt)?.toISOString() || null,
            alt: img.alt || product.name,
        })),
        variants: formattedVariants,
        relatedProducts,
    };
}
