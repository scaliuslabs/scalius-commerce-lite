// src/modules/products/products.admin.ts
// Admin product queries and CRUD mutations.
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import {
    products,
    categories,
    productVariants,
    productImages,
    productRichContent,
    productAttributeValues,
    orderItems,
    discountProducts,
} from "@scalius/database/schema";
import { and, sql, desc, eq, asc, inArray, isNull } from "drizzle-orm";
import { sanitizeFtsQuery } from "../../search/fts5";
import type { CreateProductInput, UpdateProductInput } from "./products.validation";
import { nanoid } from "nanoid";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import type { ProductWithDetails } from "./products.types";

type Database = DrizzleD1Database<typeof schema>;

// ─────────────────────────────────────────
// Admin read queries
// ─────────────────────────────────────────

/**
 * Returns a paginated, searchable list of products for the admin dashboard.
 * Includes variant counts, image counts, and primary image URLs.
 */
export async function listProducts(db: DrizzleD1Database<typeof schema>, options: {
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
            discountType: products.discountType,
            discountAmount: products.discountAmount,
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

    const [countArr, productResults] = await db.batch([
        countQuery,
        productResultsQuery,
    ]);
    const count = countArr[0]?.count ?? 0;

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
        discountType: product.discountType || "percentage",
        discountAmount: product.discountAmount || 0,
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
            discountType: products.discountType,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            category: {
                name: categories.name,
            },
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(eq(products.id, id));

    if (!result) return null;

    const [variants, images, richContent, attributeValues] = await Promise.all([
        db
            .select()
            .from(productVariants)
            .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt))),
        db
            .select()
            .from(productImages)
            .where(eq(productImages.productId, id))
            .orderBy(productImages.sortOrder),
        db
            .select()
            .from(productRichContent)
            .where(eq(productRichContent.productId, id))
            .orderBy(asc(productRichContent.sortOrder)),
        db
            .select({
                id: productAttributeValues.id,
                attributeId: productAttributeValues.attributeId,
                value: productAttributeValues.value,
            })
            .from(productAttributeValues)
            .where(eq(productAttributeValues.productId, id)),
    ]);

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
        additionalInfo: richContent.map((item) => ({
            id: item.id,
            title: item.title,
            content: item.content,
            sortOrder: item.sortOrder,
        })),
        attributes: attributeValues.map((attr) => ({
            attributeId: attr.attributeId,
            value: attr.value,
        })),
    } as ProductWithDetails;
}

/** Returns aggregate product and category counts for the products dashboard. */
export async function getProductStats(db: DrizzleD1Database<typeof schema>) {
    const [totalProductsArr, activeProductsArr, productsWithImagesArr, categoriesCountArr] = await db.batch([
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(sql`${products.deletedAt} IS NULL`),
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(sql`${products.deletedAt} IS NULL AND ${products.isActive} = 1`),
        db
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
            .where(sql`${products.deletedAt} IS NULL`),
        db
            .select({ count: sql<number>`count(*)` })
            .from(categories)
            .where(sql`${categories.deletedAt} IS NULL`),
    ]);

    return {
        totalProducts: totalProductsArr[0]?.count ?? 0,
        activeProducts: activeProductsArr[0]?.count ?? 0,
        productsWithImages: productsWithImagesArr[0]?.count ?? 0,
        categoriesCount: categoriesCountArr[0]?.count ?? 0,
    };
}

/** Returns category-level stats for the categories admin page. */
export async function getCategoryStats(db: DrizzleD1Database<typeof schema>) {
    const [totalCategoriesArr, categoriesWithImagesArr, totalProductsArr] = await db.batch([
        db
            .select({ count: sql<number>`count(*)` })
            .from(categories)
            .where(sql`${categories.deletedAt} IS NULL`),
        db
            .select({ count: sql<number>`count(*)` })
            .from(categories)
            .where(
                sql`${categories.deletedAt} IS NULL AND ${categories.imageUrl} IS NOT NULL`,
            ),
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(sql`${products.deletedAt} IS NULL`),
    ]);

    return {
        totalCategories: totalCategoriesArr[0]?.count ?? 0,
        categoriesWithImages: categoriesWithImagesArr[0]?.count ?? 0,
        totalProducts: totalProductsArr[0]?.count ?? 0,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
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
export async function permanentlyDeleteProduct(db: DrizzleD1Database<typeof schema>, id: string): Promise<void> {
    const orderCheckArr = await db
        .select({ count: sql<number>`count(*)` })
        .from(orderItems)
        .where(eq(orderItems.productId, id));

    if ((orderCheckArr[0]?.count ?? 0) > 0) {
        throw new ConflictError("Cannot delete product. It is part of one or more existing orders.");
    }

    const discountCheckArr = await db
        .select({ count: sql<number>`count(*)` })
        .from(discountProducts)
        .where(eq(discountProducts.productId, id));

    if ((discountCheckArr[0]?.count ?? 0) > 0) {
        throw new ConflictError("Cannot delete product. It is linked to one or more discounts.");
    }

    await db.batch([
        db.delete(productVariants).where(eq(productVariants.productId, id)),
        db.delete(productImages).where(eq(productImages.productId, id)),
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.delete(productRichContent).where(eq(productRichContent.productId, id)),
        db.delete(products).where(eq(products.id, id)),
    // Drizzle D1 batch() requires specific tuple types — safe to cast
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ] as any);
}

/**
 * Bulk soft-deletes or permanently deletes multiple products.
 */
export async function bulkDeleteProducts(db: DrizzleD1Database<typeof schema>, productIds: string[], permanent: boolean = false) {
    if (productIds.length === 0) throw new ValidationError("No product IDs provided");

    if (permanent) {
        const orderCheckArr = await db
            .select({ count: sql<number>`count(*)` })
            .from(orderItems)
            .where(inArray(orderItems.productId, productIds));

        if ((orderCheckArr[0]?.count ?? 0) > 0) {
            throw new ConflictError("Cannot delete products. One or more products are part of existing orders.");
        }

        const discountCheckArr = await db
            .select({ count: sql<number>`count(*)` })
            .from(discountProducts)
            .where(inArray(discountProducts.productId, productIds));

        if ((discountCheckArr[0]?.count ?? 0) > 0) {
            throw new ConflictError("Cannot delete products. One or more products are linked to discounts.");
        }

        await db.batch([
            db.delete(productVariants).where(inArray(productVariants.productId, productIds)),
            db.delete(productImages).where(inArray(productImages.productId, productIds)),
            db.delete(productAttributeValues).where(inArray(productAttributeValues.productId, productIds)),
            db.delete(productRichContent).where(inArray(productRichContent.productId, productIds)),
            db.delete(products).where(inArray(products.id, productIds)),
        ] as any);
    } else {
        await db
            .update(products)
            .set({ deletedAt: sql`unixepoch()` })
            .where(inArray(products.id, productIds));
    }
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        await db.batch(statements as any);
    }
}
