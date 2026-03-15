// src/modules/products/products.service.ts
// Product service: admin queries, storefront queries, and CRUD mutations.
import type { DrizzleD1Database } from "drizzle-orm/d1";
type Database = DrizzleD1Database<typeof schema>;
import * as schema from "@scalius/database/schema";
import {
    products,
    categories,
    productVariants,
    productImages,
    productRichContent,
    productAttributeValues,
    productAttributes,
    orderItems,
    discountProducts,
} from "@scalius/database/schema";
import { and, sql, desc, eq, asc, isNull, inArray, or, type SQL } from "drizzle-orm";
import { sanitizeFtsQuery, ftsMatch } from "../../search/fts5";
import type { Product, ProductVariant, ProductImage } from "@scalius/database/schema";
import type { CreateProductInput, UpdateProductInput } from "./products.validation";
import { nanoid } from "nanoid";
import { z } from "zod";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";

// ─────────────────────────────────────────
// Variant Validation Schemas
// ─────────────────────────────────────────

export const createVariantSchema = z.object({
    size: z.string().nullable(),
    color: z.string().nullable(),
    weight: z.number().min(0).nullable(),
    sku: z.string().min(3, "SKU must be at least 3 characters"),
    price: z.number().min(0, "Price must be greater than or equal to 0"),
    stock: z.number().min(0, "Stock must be greater than or equal to 0"),
    barcode: z.string().max(50).optional().nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).optional().nullable(),
    discountType: z.enum(["percentage", "flat"]).optional(),
    discountPercentage: z.number().min(0).max(100).nullable().optional(),
    discountAmount: z.number().min(0).nullable().optional(),
});

export const updateVariantSchema = createVariantSchema;

const sortItemSchema = z.object({
    value: z.string(),
    sortOrder: z.number(),
});

export const updateSortOrderSchema = z.object({
    colors: z.array(sortItemSchema),
    sizes: z.array(sortItemSchema),
});

export const bulkVariantSchema = z.object({
    size: z.string().nullable(),
    color: z.string().nullable(),
    weight: z.number().min(0).nullable(),
    sku: z.string().min(3, "SKU must be at least 3 characters"),
    price: z.number().min(0, "Price must be greater than or equal to 0"),
    stock: z.number().min(0, "Stock must be greater than or equal to 0"),
    barcode: z.string().max(50).optional().nullable(),
    barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).optional().nullable(),
    discountType: z.enum(["percentage", "flat"]),
    discountPercentage: z.number().min(0).max(100).nullable(),
    discountAmount: z.number().min(0).nullable(),
});

export const bulkCreateVariantsSchema = z.object({
    variants: z.array(bulkVariantSchema).min(1, "At least one variant is required"),
});

export const bulkDeleteVariantsSchema = z.object({
    variantIds: z.array(z.string()),
});

export const bulkUpdateVariantsSchema = z.object({
    updates: z.array(
        z.object({
            id: z.string(),
            size: z.string().nullable().optional(),
            color: z.string().nullable().optional(),
            weight: z.number().nullable().optional(),
            sku: z.string().optional(),
            price: z.number().min(0).optional(),
            stock: z.number().min(0).optional(),
            barcode: z.string().max(50).nullable().optional(),
            barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "custom"]).nullable().optional(),
        })
    ),
});

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
export async function getProducts(db: DrizzleD1Database<typeof schema>, options: {
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
        // Check if search looks like a barcode (all digits, 8-13 chars)
        const isBarcodeSearch = /^\d{8,13}$/.test(search.trim());

        const sanitized = sanitizeFtsQuery(search);
        if (sanitized) {
            const ftsCondition = sql`(${sql.raw("products")}.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ${sanitized}) OR EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${sql.raw("product_variants")}.rowid IN (SELECT rowid FROM product_variants_fts WHERE product_variants_fts MATCH ${sanitized})))`;

            if (isBarcodeSearch) {
                // Also match by exact barcode value
                const barcodeCondition = sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariants.barcode} = ${search.trim()} AND ${productVariants.deletedAt} IS NULL)`;
                whereConditions.push(sql`(${ftsCondition} OR ${barcodeCondition})`);
            } else {
                whereConditions.push(ftsCondition);
            }
            rankExpression = sql`COALESCE((SELECT rank FROM products_fts WHERE rowid = products.rowid AND products_fts MATCH ${sanitized}), 0) ASC`;
        } else if (isBarcodeSearch) {
            // FTS sanitized to nothing but it's a barcode — search by barcode only
            const barcodeCondition = sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariants.barcode} = ${search.trim()} AND ${productVariants.deletedAt} IS NULL)`;
            whereConditions.push(barcodeCondition);
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

    const productIds: string[] = productResults.map((p) => p.id);

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

    const variantCountMap = new Map<string, number>(
        variantCounts.map((vc: { productId: string; count: number }) => [vc.productId, vc.count]),
    );

    const imageCountMap = new Map<string, number>(
        imageCounts.map((ic: { productId: string; count: number }) => [ic.productId, ic.count]),
    );

    const primaryImageMap = new Map<string, string>(
        primaryImages.map((pi: { productId: string; url: string }) => [pi.productId, pi.url]),
    );

    const skuMap = new Map<string, string>();
    productSkus.forEach((item: { productId: string; sku: string }) => {
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
    db: Database,
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
            createdAt: img.createdAt instanceof Date ? img.createdAt : new Date(Number(img.createdAt) * 1000),
        })),
    } as ProductWithDetails;
}

/** Returns aggregate product and category counts for the products dashboard. */
export async function getProductStats(db: DrizzleD1Database<typeof schema>) {
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
export async function getCategoryStats(db: DrizzleD1Database<typeof schema>) {
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
export async function createProduct(db: DrizzleD1Database<typeof schema>, data: CreateProductInput): Promise<{ id: string }> {
    const existingProduct = await db
        .select({ id: products.id })
        .from(products)
        .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
        .get();

    if (existingProduct) {
        throw new ConflictError("A product with this slug already exists");
    }

    const productId = "prod_" + nanoid();

    // Drizzle D1 batch() requires specific tuple types
    const batchOps: unknown[] = [
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

    // Drizzle D1 batch() requires specific tuple types — safe to cast
    await db.batch(batchOps as any);
    return { id: productId };
}

/**
 * Updates an existing product, replacing images, rich content, and attributes.
 * Validates that the product exists and the slug is not taken by another product.
 */
export async function updateProduct(db: DrizzleD1Database<typeof schema>, id: string, data: UpdateProductInput): Promise<void> {
    const existingProduct = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, id))
        .get();

    if (!existingProduct) {
        throw new NotFoundError("Product not found");
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
        throw new ConflictError("A product with this slug already exists");
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

    // Drizzle D1 batch() requires specific tuple types
    const batchOps: unknown[] = [
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

    // Drizzle D1 batch() requires specific tuple types — safe to cast
    await db.batch(batchOps as any);
}

/**
 * Soft-deletes a product by setting deletedAt.
 */
export async function deleteProduct(db: DrizzleD1Database<typeof schema>, id: string): Promise<void> {
    await db
        .update(products)
        .set({ deletedAt: sql`unixepoch()` })
        .where(eq(products.id, id));
}

/**
 * Restores a soft-deleted product by setting deletedAt to null.
 */
export async function restoreProduct(db: DrizzleD1Database<typeof schema>, id: string): Promise<void> {
    await db
        .update(products)
        .set({
            deletedAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(products.id, id));
}

/**
 * Permanently deletes a product and all of its related data (variants, images, attributes, rich content).
 * Throws an error if the product is linked to any existing orders or discounts.
 */
export async function permanentDeleteProduct(db: DrizzleD1Database<typeof schema>, id: string): Promise<void> {
    const [orderCheck] = await db
        .select({ count: sql<number>`count(*)` })
        .from(orderItems)
        .where(eq(orderItems.productId, id));

    if (orderCheck.count > 0) {
        throw new ConflictError("Cannot delete product. It is part of one or more existing orders.");
    }

    const [discountCheck] = await db
        .select({ count: sql<number>`count(*)` })
        .from(discountProducts)
        .where(eq(discountProducts.productId, id));

    if (discountCheck.count > 0) {
        throw new ConflictError("Cannot delete product. It is linked to one or more discounts.");
    }

    await db.batch([
        db.delete(productVariants).where(eq(productVariants.productId, id)),
        db.delete(productImages).where(eq(productImages.productId, id)),
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.delete(productRichContent).where(eq(productRichContent.productId, id)),
        db.delete(products).where(eq(products.id, id)),
    // Drizzle D1 batch() requires specific tuple types — safe to cast
    ] as any);
}

/**
 * Bulk updates given product variants using an array of updates.
 */
export async function bulkUpdateVariants(db: DrizzleD1Database<typeof schema>, productId: string, updates: Array<{ id: string; size?: string | null; color?: string | null; weight?: number | null; sku?: string; price?: number; stock?: number }>) {
    const statements = [];
    for (const update of updates) {
        const { id, ...fieldsToUpdate } = update;
        if (Object.keys(fieldsToUpdate).length === 0) continue;

        statements.push(
            db
                .update(productVariants)
                .set({
                    ...fieldsToUpdate,
                    updatedAt: sql`unixepoch()`,
                })
                .where(
                    and(
                        eq(productVariants.id, id),
                        eq(productVariants.productId, productId)
                    )
                )
        );
    }

    if (statements.length > 0) {
        // Drizzle D1 batch() requires specific tuple types — safe to cast
        await db.batch(statements as any);
    }
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
export async function getStorefrontProducts(db: DrizzleD1Database<typeof schema>, params: StorefrontProductFilterInput) {
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

    const conditions: (SQL | undefined)[] = [
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

    let orderBy: SQL | ReturnType<typeof desc> | typeof products.name;
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
        imageMap = new Map(images.map((img: { productId: string; url: string }) => [img.productId, img.url]));
    }

    let categoryMap = new Map<string, { id: string; name: string; slug: string }>();
    const categoryIds = [...new Set(productsList.map((p) => p.categoryId).filter(Boolean))] as string[];
    if (categoryIds.length > 0) {
        const categoriesData: Array<{ id: string; name: string; slug: string }> = await db
            .select({ id: categories.id, name: categories.name, slug: categories.slug })
            .from(categories)
            .where(inArray(categories.id, categoryIds))
            .all();
        categoryMap = new Map(categoriesData.map((cat) => [cat.id, cat]));
    }

    const productsWithImages = productsList.map(({ variantCount, ...product }: { variantCount: number; id: string; name: string; price: number; slug: string; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; freeDelivery: boolean; categoryId: string | null; createdAt: number; updatedAt: number }) => ({
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
export async function getStorefrontProductBySlug(db: DrizzleD1Database<typeof schema>, slug: string) {
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

    const promises: Promise<{ type: string; data: unknown }>[] = [
        db.select({
            id: productImages.id,
            productId: productImages.productId,
            url: productImages.url,
            alt: productImages.alt,
            isPrimary: productImages.isPrimary,
            sortOrder: productImages.sortOrder,
            createdAt: sql<number>`CAST(${productImages.createdAt} AS INTEGER)`,
        }).from(productImages).where(eq(productImages.productId, product.id)).orderBy(productImages.sortOrder).all()
            .then((res: Array<{ id: string; productId: string; url: string; alt: string | null; isPrimary: boolean; sortOrder: number; createdAt: number }>) => ({ type: "images", data: res })),

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
            barcode: productVariants.barcode,
            barcodeType: productVariants.barcodeType,
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
            .all().then((res: Array<{ id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null; createdAt: number; updatedAt: number; deletedAt: number | null }>) => ({ type: "variants", data: res })),

        db.select({
            id: productRichContent.id,
            title: productRichContent.title,
            content: productRichContent.content,
        }).from(productRichContent).where(eq(productRichContent.productId, product.id))
            .orderBy(productRichContent.sortOrder).then((res: Array<{ id: string; title: string; content: string }>) => ({ type: "additionalInfo", data: res })),

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
            .then((res: Array<{ name: string; value: string; slug: string }>) => ({ type: "attributes", data: res })),
    ];

    if (product.categoryId) {
        promises.push(
            db.select({
                id: categories.id, name: categories.name, slug: categories.slug,
                description: categories.description, imageUrl: categories.imageUrl,
                metaTitle: categories.metaTitle, metaDescription: categories.metaDescription,
            }).from(categories).where(eq(categories.id, product.categoryId!)).get()
                .then((res: { id: string; name: string; slug: string; description: string | null; imageUrl: string | null; metaTitle: string | null; metaDescription: string | null } | undefined) => ({ type: "category", data: res })),
        );

        promises.push(
            (async () => {
                const relatedProds: Array<{ id: string; name: string; price: number; slug: string; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; freeDelivery: boolean }> = await db.select({
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
                const relatedImages: Array<{ productId: string; url: string }> = await db
                    .select({ productId: productImages.productId, url: productImages.url })
                    .from(productImages)
                    .where(and(inArray(productImages.productId, relatedIds), eq(productImages.isPrimary, true)))
                    .all();

                const relatedImageMap = new Map(relatedImages.map((img: { productId: string; url: string }) => [img.productId, img.url]));

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

    const images = (results.find((r) => r.type === "images")?.data as unknown[]) || [];
    const variants = (results.find((r) => r.type === "variants")?.data as unknown[]) || [];
    const category = (results.find((r) => r.type === "category")?.data as unknown) || null;
    const additionalInfo = (results.find((r) => r.type === "additionalInfo")?.data as unknown[]) || [];
    const relatedProducts = (results.find((r) => r.type === "relatedProducts")?.data as unknown[]) || [];
    const attributes = (results.find((r) => r.type === "attributes")?.data as unknown[]) || [];

    const hasVariants = variants.length > 0;

    interface VariantResult { id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null; createdAt: number; updatedAt: number; deletedAt: number | null; }
    interface ImageResult { id: string; productId: string; url: string; alt: string | null; isPrimary: boolean; sortOrder: number; createdAt: number; }
    const typedVariants = variants as VariantResult[];
    const typedImages = images as ImageResult[];

    const formattedVariants = hasVariants
        ? typedVariants.map((v) => ({
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
        images: typedImages.map((img) => ({
            ...img,
            createdAt: unixToDate(img.createdAt)?.toISOString() || null,
            alt: img.alt || product.name,
        })),
        variants: formattedVariants,
        relatedProducts,
    };
}

export async function bulkDeleteProducts(db: DrizzleD1Database<typeof schema>, productIds: string[], permanent: boolean = false) {
    if (productIds.length === 0) throw new ValidationError("No product IDs provided");

    if (permanent) {
        const [orderCheck] = await db
            .select({ count: sql<number>`count(*)` })
            .from(orderItems)
            .where(inArray(orderItems.productId, productIds));

        if (orderCheck.count > 0) {
            throw new ConflictError("Cannot delete products. One or more products are part of existing orders.");
        }

        const [discountCheck] = await db
            .select({ count: sql<number>`count(*)` })
            .from(discountProducts)
            .where(inArray(discountProducts.productId, productIds));

        if (discountCheck.count > 0) {
            throw new ConflictError("Cannot delete products. One or more products are linked to discounts.");
        }

        await db.batch([
            db.delete(productVariants).where(inArray(productVariants.productId, productIds)),
            db.delete(productImages).where(inArray(productImages.productId, productIds)),
            db.delete(products).where(inArray(products.id, productIds)),
        ]);
    } else {
        await db
            .update(products)
            .set({ deletedAt: sql`unixepoch()` })
            .where(inArray(products.id, productIds));
    }
}

// ─────────────────────────────────────────
// Barcode lookup
// ─────────────────────────────────────────

/**
 * Looks up a product variant by barcode value.
 * Returns the variant with its parent product details, or null if not found.
 * Used by barcode scanners in the admin interface.
 */
export async function lookupByBarcode(db: DrizzleD1Database<typeof schema>, barcode: string) {
    const variant = await db
        .select({
            variantId: productVariants.id,
            variantSku: productVariants.sku,
            variantSize: productVariants.size,
            variantColor: productVariants.color,
            variantWeight: productVariants.weight,
            variantPrice: productVariants.price,
            variantStock: productVariants.stock,
            variantReservedStock: productVariants.reservedStock,
            variantBarcode: productVariants.barcode,
            variantBarcodeType: productVariants.barcodeType,
            productId: products.id,
            productName: products.name,
            productSlug: products.slug,
            productPrice: products.price,
            productIsActive: products.isActive,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(
            and(
                eq(productVariants.barcode, barcode),
                isNull(productVariants.deletedAt),
                isNull(products.deletedAt),
            ),
        )
        .get();

    if (!variant) return null;

    return {
        variant: {
            id: variant.variantId,
            sku: variant.variantSku,
            size: variant.variantSize,
            color: variant.variantColor,
            weight: variant.variantWeight,
            price: variant.variantPrice,
            stock: variant.variantStock,
            reservedStock: variant.variantReservedStock,
            barcode: variant.variantBarcode,
            barcodeType: variant.variantBarcodeType,
        },
        product: {
            id: variant.productId,
            name: variant.productName,
            slug: variant.productSlug,
            price: variant.productPrice,
            isActive: variant.productIsActive,
        },
    };
}

// ─────────────────────────────────────────
// Variant specific mutations
// ─────────────────────────────────────────

export async function getProductVariants(db: DrizzleD1Database<typeof schema>, productId: string) {
    const variants = await db
        .select({
            id: productVariants.id,
            size: productVariants.size,
            color: productVariants.color,
            weight: productVariants.weight,
            sku: productVariants.sku,
            price: productVariants.price,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            barcode: productVariants.barcode,
            barcodeType: productVariants.barcodeType,
            discountType: productVariants.discountType,
            discountPercentage: productVariants.discountPercentage,
            discountAmount: productVariants.discountAmount,
            colorSortOrder: productVariants.colorSortOrder,
            sizeSortOrder: productVariants.sizeSortOrder,
            createdAt: sql<string>`datetime(${productVariants.createdAt}, 'unixepoch', 'localtime')`,
            updatedAt: sql<string>`datetime(${productVariants.updatedAt}, 'unixepoch', 'localtime')`,
        })
        .from(productVariants)
        .where(
            sql`${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`,
        )
        .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder, productVariants.createdAt);

    return variants.map((variant: { id: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; reservedStock: number; barcode: string | null; barcodeType: string | null; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null; createdAt: string; updatedAt: string }) => ({
        ...variant,
        createdAt: new Date(variant.createdAt),
        updatedAt: new Date(variant.updatedAt),
    }));
}

export async function createVariant(db: DrizzleD1Database<typeof schema>, productId: string, data: z.infer<typeof createVariantSchema>) {
    const existingVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`${productVariants.sku} = ${data.sku} AND ${productVariants.deletedAt} IS NULL`)
        .get();

    if (existingVariant) {
        throw new ConflictError("A variant with this SKU already exists");
    }

    const [variant] = await db
        .insert(productVariants)
        .values({
            id: "var_" + nanoid(),
            productId,
            size: data.size,
            color: data.color,
            weight: data.weight,
            sku: data.sku,
            price: data.price,
            stock: data.stock,
            barcode: data.barcode || null,
            barcodeType: data.barcodeType || null,
            discountType: data.discountType || "percentage",
            discountPercentage: data.discountPercentage || null,
            discountAmount: data.discountAmount || null,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .returning();

    return variant;
}

export async function updateVariant(db: DrizzleD1Database<typeof schema>, productId: string, variantId: string, data: z.infer<typeof updateVariantSchema>) {
    const existingVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`)
        .get();

    if (!existingVariant) {
        throw new NotFoundError("Variant not found");
    }

    const existingSkuVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`${productVariants.sku} = ${data.sku} AND ${productVariants.id} != ${variantId} AND ${productVariants.deletedAt} IS NULL`)
        .get();

    if (existingSkuVariant) {
        throw new ConflictError("A variant with this SKU already exists");
    }

    const [variant] = await db
        .update(productVariants)
        .set({
            size: data.size,
            color: data.color,
            weight: data.weight,
            sku: data.sku,
            price: data.price,
            stock: data.stock,
            barcode: data.barcode || null,
            barcodeType: data.barcodeType || null,
            discountType: data.discountType || "percentage",
            discountPercentage: data.discountPercentage || null,
            discountAmount: data.discountAmount || null,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(productVariants.id, variantId))
        .returning();

    return variant;
}

export async function deleteVariant(db: DrizzleD1Database<typeof schema>, productId: string, variantId: string) {
    const existingVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`)
        .get();

    if (!existingVariant) {
        throw new NotFoundError("Variant not found");
    }

    await db.delete(productVariants).where(eq(productVariants.id, variantId));
}

export async function duplicateVariant(db: DrizzleD1Database<typeof schema>, productId: string, variantId: string) {
    const [existingVariant] = await db
        .select()
        .from(productVariants)
        .where(sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`)
        .limit(1);

    if (!existingVariant) {
        throw new NotFoundError("Variant not found");
    }

    let newSku = `${existingVariant.sku}-COPY`;
    let counter = 1;

    while (true) {
        const existing = await db
            .select({ id: productVariants.id })
            .from(productVariants)
            .where(sql`${productVariants.sku} = ${newSku} AND ${productVariants.deletedAt} IS NULL`)
            .get();

        if (!existing) break;

        counter++;
        newSku = `${existingVariant.sku}-COPY${counter}`;
    }

    const [newVariant] = await db
        .insert(productVariants)
        .values({
            id: "var_" + nanoid(),
            productId,
            size: existingVariant.size,
            color: existingVariant.color,
            weight: existingVariant.weight,
            sku: newSku,
            price: existingVariant.price,
            stock: existingVariant.stock,
            barcode: existingVariant.barcode,
            barcodeType: existingVariant.barcodeType,
            discountType: existingVariant.discountType,
            discountPercentage: existingVariant.discountPercentage,
            discountAmount: existingVariant.discountAmount,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .returning();

    return newVariant;
}

export async function bulkCreateVariants(db: DrizzleD1Database<typeof schema>, productId: string, variants: z.infer<typeof bulkVariantSchema>[]) {
    const skus = variants.map((v) => v.sku);
    const duplicateSkus = skus.filter((sku, index) => skus.indexOf(sku) !== index);

    if (duplicateSkus.length > 0) {
        throw new ValidationError(`Duplicate SKUs found in request: ${duplicateSkus.join(", ")}`);
    }

    const existingVariants: Array<{ sku: string }> = await db
        .select({ sku: productVariants.sku })
        .from(productVariants)
        .where(sql`${productVariants.sku} IN ${skus} AND ${productVariants.deletedAt} IS NULL`)
        .all();

    if (existingVariants.length > 0) {
        throw new ConflictError(`One or more SKUs already exist: ${existingVariants.map((v) => v.sku).join(", ")}`);
    }

    const variantsToCreate = variants.map((variant) => ({
        id: "var_" + nanoid(),
        productId,
        size: variant.size,
        color: variant.color,
        weight: variant.weight,
        sku: variant.sku,
        price: variant.price,
        stock: variant.stock,
        barcode: variant.barcode || null,
        barcodeType: variant.barcodeType || null,
        discountType: variant.discountType,
        discountPercentage: variant.discountPercentage,
        discountAmount: variant.discountAmount,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    }));

    const createdVariants = [];
    const chunkSize = 50;
    for (let i = 0; i < variantsToCreate.length; i += chunkSize) {
        const chunk = variantsToCreate.slice(i, i + chunkSize);
        const result = await db
            .insert(productVariants)
            .values(chunk)
            .returning();
        createdVariants.push(...result);
    }

    return createdVariants;
}

export async function bulkDeleteVariants(db: DrizzleD1Database<typeof schema>, productId: string, variantIds: string[]) {
    if (variantIds.length === 0) throw new ValidationError("No variant IDs provided");

    await db
        .delete(productVariants)
        .where(sql`${productVariants.id} IN ${variantIds} AND ${productVariants.productId} = ${productId}`);
}

export async function getVariantSortOrder(db: DrizzleD1Database<typeof schema>, productId: string) {
    const variants = await db
        .select({
            color: productVariants.color,
            size: productVariants.size,
            colorSortOrder: productVariants.colorSortOrder,
            sizeSortOrder: productVariants.sizeSortOrder,
        })
        .from(productVariants)
        .where(
            and(
                eq(productVariants.productId, productId),
                isNull(productVariants.deletedAt)
            )
        );

    const colorMap = new Map<string, number>();
    const sizeMap = new Map<string, number>();

    variants.forEach((variant: { color: string | null; size: string | null; colorSortOrder: number | null; sizeSortOrder: number | null }) => {
        if (variant.color && !colorMap.has(variant.color)) {
            colorMap.set(variant.color, variant.colorSortOrder || 0);
        }
        if (variant.size && !sizeMap.has(variant.size)) {
            sizeMap.set(variant.size, variant.sizeSortOrder || 0);
        }
    });

    const colors = Array.from(colorMap.entries())
        .map(([value, sortOrder]) => ({ value, sortOrder }))
        .sort((a, b) => a.sortOrder - b.sortOrder);

    const sizes = Array.from(sizeMap.entries())
        .map(([value, sortOrder]) => ({ value, sortOrder }))
        .sort((a, b) => a.sortOrder - b.sortOrder);

    return { colors, sizes };
}

export async function updateVariantSortOrder(db: DrizzleD1Database<typeof schema>, productId: string, data: z.infer<typeof updateSortOrderSchema>) {
    // Update color sort orders
    for (const color of data.colors) {
        await db
            .update(productVariants)
            .set({
                colorSortOrder: color.sortOrder,
                updatedAt: sql`unixepoch()`,
            })
            .where(
                and(
                    eq(productVariants.productId, productId),
                    eq(productVariants.color, color.value),
                    isNull(productVariants.deletedAt)
                )
            );
    }

    // Update size sort orders
    for (const size of data.sizes) {
        await db
            .update(productVariants)
            .set({
                sizeSortOrder: size.sortOrder,
                updatedAt: sql`unixepoch()`,
            })
            .where(
                and(
                    eq(productVariants.productId, productId),
                    eq(productVariants.size, size.value),
                    isNull(productVariants.deletedAt)
                )
            );
    }
}

// ─────────────────────────────────────────
// Storefront search (variant-aware)
// ─────────────────────────────────────────

/**
 * Lightweight variant-aware product search for cart/checkout use.
 * Returns products with their variants and primary image URL.
 */
export async function searchStorefrontProducts(
    db: DrizzleD1Database<typeof schema>,
    params: { search: string; page: number; limit: number },
) {
    const { search, page, limit } = params;
    const offset = (page - 1) * limit;
    const { ftsMatch } = await import("../../search/fts5");
    const { eq, and, isNull, desc, inArray, sql } = await import("drizzle-orm");

    const conditions: Array<ReturnType<typeof eq>> = [
        eq(products.isActive, true),
        isNull(products.deletedAt) as ReturnType<typeof eq>,
    ];
    const searchCondition = search ? ftsMatch("products_fts", "products", search) : null;
    if (searchCondition) conditions.push(searchCondition as ReturnType<typeof eq>);

    const [results, countResults] = await Promise.all([
        db
            .select({
                id: products.id,
                name: products.name,
                price: products.price,
                slug: products.slug,
                discountType: products.discountType,
                discountPercentage: products.discountPercentage,
                discountAmount: products.discountAmount,
                freeDelivery: products.freeDelivery,
            })
            .from(products)
            .where(and(...conditions))
            .orderBy(desc(products.updatedAt))
            .limit(limit)
            .offset(offset)
            .all() as Promise<Array<{ id: string; name: string; price: number; slug: string; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; freeDelivery: boolean }>>,
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(and(...conditions)),
    ]);

    const productIds = results.map((p) => p.id);
    const count = Number((countResults[0] as { count: number } | undefined)?.count ?? 0);
    const totalPages = Math.ceil(count / limit);

    const [images, variants] =
        productIds.length > 0
            ? await Promise.all([
                db
                    .select({ productId: productImages.productId, url: productImages.url })
                    .from(productImages)
                    .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds)))
                    .all() as Promise<Array<{ productId: string; url: string }>>,
                db
                    .select({
                        id: productVariants.id,
                        productId: productVariants.productId,
                        size: productVariants.size,
                        color: productVariants.color,
                        weight: productVariants.weight,
                        sku: productVariants.sku,
                        price: productVariants.price,
                        stock: productVariants.stock,
                        discountType: productVariants.discountType,
                        discountPercentage: productVariants.discountPercentage,
                        discountAmount: productVariants.discountAmount,
                        colorSortOrder: productVariants.colorSortOrder,
                        sizeSortOrder: productVariants.sizeSortOrder,
                    })
                    .from(productVariants)
                    .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
                    .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder)
                    .all() as Promise<Array<{ id: string; productId: string; size: string | null; color: string | null; weight: number | null; sku: string; price: number; stock: number; discountType: string | null; discountPercentage: number | null; discountAmount: number | null; colorSortOrder: number | null; sizeSortOrder: number | null }>>,
            ])
            : [[], []];

    const imageMap = new Map(
        (images as Array<{ productId: string; url: string }>).map((img) => [img.productId, img.url]),
    );

    return {
        data: results.map((product) => ({
            ...product,
            imageUrl: imageMap.get(product.id) || null,
            variants: (variants as Array<{ productId: string } & Record<string, unknown>>).filter(
                (v) => v.productId === product.id,
            ),
        })),
        pagination: {
            page,
            limit,
            total: count,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
    };
}
