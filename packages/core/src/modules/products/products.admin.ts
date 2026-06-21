// src/modules/products/products.admin.ts
// Admin product queries and CRUD mutations.
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
import { safeBatch, type Database } from "@scalius/database/client";
import { checkAndAlertLowStock } from "../inventory/alerts";
import { buildStockMovementClaim } from "../inventory/stock-movement-claims";

function createDefaultSku(productId: string): string {
    return `SIMPLE-${productId}`;
}

function createDefaultVariantId(productId: string): string {
    return `var_default_${productId}`;
}

function defaultVariantValues(productId: string, price: number) {
    return {
        id: createDefaultVariantId(productId),
        productId,
        size: null,
        color: null,
        weight: null,
        sku: createDefaultSku(productId),
        price,
        stock: 0,
        reservedStock: 0,
        preorderStock: 0,
        isDefault: true,
        trackInventory: false,
        version: 1,
        stockVersion: 1,
        allowPreorder: false,
        allowBackorder: false,
        backorderLimit: 0,
        discountPercentage: 0,
        discountType: "percentage" as const,
        discountAmount: 0,
        colorSortOrder: 0,
        sizeSortOrder: 0,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        deletedAt: null,
    };
}

function isSimpleDefaultSkuSet(variants: Array<{ isDefault: boolean; size: string | null; color: string | null }>): boolean {
    return variants.length === 1 && variants[0]?.isDefault === true && !hasVariantOption(variants[0]);
}

function hasInvalidSkuTopology(variants: Array<{ isDefault: boolean; size: string | null; color: string | null }>): boolean {
    return variants.some((variant) =>
        (variant.isDefault && hasVariantOption(variant)) ||
        (!variant.isDefault && !hasVariantOption(variant))
    );
}

function normalizeVariantOption(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

function hasVariantOption(value: { size?: string | null; color?: string | null }): boolean {
    return Boolean(normalizeVariantOption(value.size) || normalizeVariantOption(value.color));
}

// ─────────────────────────────────────────
// Admin read queries
// ─────────────────────────────────────────

/**
 * Returns a paginated, searchable list of products for the admin dashboard.
 * Includes variant counts, image counts, and primary image URLs.
 */
export async function listProducts(db: Database, options: {
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

export interface ProductPickerSummary {
    id: string;
    name: string;
    price: number;
    categoryId: string | null;
    primaryImage: string | null;
    discountPercentage: number | null;
}

function normalizeLookupIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, 100);
}

/** Returns lightweight product metadata for already-known product IDs. */
export async function getProductsByIds(
    db: Database,
    ids: string[],
): Promise<ProductPickerSummary[]> {
    const lookupIds = normalizeLookupIds(ids);
    if (lookupIds.length === 0) return [];

    const orderById = new Map(lookupIds.map((id, index) => [id, index]));
    const rows = await db
        .select({
            id: products.id,
            name: products.name,
            price: products.price,
            categoryId: products.categoryId,
            discountPercentage: products.discountPercentage,
            primaryImage: sql<string | null>`(
                SELECT ${productImages.url}
                FROM ${productImages}
                WHERE ${productImages.productId} = ${products.id}
                  AND ${productImages.isPrimary} = 1
                ORDER BY ${productImages.sortOrder} ASC
                LIMIT 1
            )`.as("primaryImage"),
        })
        .from(products)
        .where(and(inArray(products.id, lookupIds), isNull(products.deletedAt)));

    return rows.sort(
        (a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0),
    );
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
export async function getProductStats(db: Database) {
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
export async function getCategoryStats(db: Database) {
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
export async function createProduct(db: Database, data: CreateProductInput): Promise<{ id: string }> {
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
            discountPercentage: (data.discountType || "percentage") === "percentage" ? (data.discountPercentage || null) : 0,
            discountAmount: (data.discountType || "percentage") === "flat" ? (data.discountAmount || null) : 0,
            freeDelivery: data.freeDelivery,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
            deletedAt: null,
        }),
        db.insert(productVariants).values(defaultVariantValues(productId, data.price)),
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
export async function updateProduct(db: Database, id: string, data: UpdateProductInput): Promise<void> {
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

    const activeVariants = await db
        .select({
            id: productVariants.id,
            isDefault: productVariants.isDefault,
            size: productVariants.size,
            color: productVariants.color,
        })
        .from(productVariants)
        .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt)));

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
                discountPercentage: (data.discountType || "percentage") === "percentage" ? (data.discountPercentage ?? null) : 0,
                discountAmount: (data.discountType || "percentage") === "flat" ? (data.discountAmount ?? null) : 0,
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

    if (data.isActive && activeVariants.length === 0) {
        batchOps.push(db.insert(productVariants).values(defaultVariantValues(id, data.price)));
    } else if (hasInvalidSkuTopology(activeVariants)) {
        throw new ValidationError("Product SKU data is invalid: default SKUs must be optionless, and non-default SKUs must include at least one customer option.");
    } else if (isSimpleDefaultSkuSet(activeVariants)) {
        batchOps.push(
            db
                .update(productVariants)
                .set({
                    price: data.price,
                    discountType: "percentage",
                    discountPercentage: 0,
                    discountAmount: 0,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(productVariants.id, activeVariants[0]!.id)),
        );
    }

    // Drizzle D1 batch() requires specific tuple types — safe to cast
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(batchOps as any);
}

/**
 * Soft-deletes a product by setting deletedAt.
 */
export async function deleteProduct(db: Database, id: string): Promise<void> {
    await db
        .update(products)
        .set({ deletedAt: sql`unixepoch()` })
        .where(eq(products.id, id));
}

/**
 * Restores a soft-deleted product by setting deletedAt to null.
 */
export async function restoreProduct(db: Database, id: string): Promise<void> {
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
export async function permanentlyDeleteProduct(db: Database, id: string): Promise<void> {
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
export async function bulkDeleteProducts(db: Database, productIds: string[], permanent: boolean = false) {
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

        await safeBatch(db, [
            db.delete(productVariants).where(inArray(productVariants.productId, productIds)),
            db.delete(productImages).where(inArray(productImages.productId, productIds)),
            db.delete(productAttributeValues).where(inArray(productAttributeValues.productId, productIds)),
            db.delete(productRichContent).where(inArray(productRichContent.productId, productIds)),
            db.delete(products).where(inArray(products.id, productIds)),
        ]);
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
type BulkVariantUpdate = {
    id: string;
    size?: string | null;
    color?: string | null;
    weight?: number | null;
    sku?: string;
    price?: number;
    stock?: number;
    trackInventory?: boolean;
    barcode?: string | null;
    barcodeType?: "ean13" | "upc" | "isbn" | "gtin" | "custom" | null;
};

export async function bulkUpdateVariants(db: Database, productId: string, updates: BulkVariantUpdate[], adminUserId?: string) {
    const statements = [];
    const stockResultPairs: Array<{
        variantId: string;
        movementIndex: number;
        updateIndex: number;
        delta: number;
    }> = [];
    const ids = updates.map((update) => update.id).filter(Boolean);
    const currentVariants = ids.length > 0
        ? await db
            .select({
                id: productVariants.id,
                isDefault: productVariants.isDefault,
                size: productVariants.size,
                color: productVariants.color,
                stock: productVariants.stock,
                stockVersion: productVariants.stockVersion,
            })
            .from(productVariants)
            .where(and(
                eq(productVariants.productId, productId),
                inArray(productVariants.id, ids),
                isNull(productVariants.deletedAt),
            ))
        : [];
    const currentVariantById = new Map(currentVariants.map((variant) => [variant.id, variant]));

    for (const update of updates) {
        const { id, stock, ...fieldsToUpdate } = update;
        if (Object.keys(fieldsToUpdate).length === 0 && stock === undefined) continue;
        const currentVariant = currentVariantById.get(id);
        if (!currentVariant) {
            throw new NotFoundError("Variant not found");
        }

        const nextSize = "size" in fieldsToUpdate
            ? normalizeVariantOption(fieldsToUpdate.size)
            : normalizeVariantOption(currentVariant.size);
        const nextColor = "color" in fieldsToUpdate
            ? normalizeVariantOption(fieldsToUpdate.color)
            : normalizeVariantOption(currentVariant.color);
        if (currentVariant.isDefault || !hasVariantOption(currentVariant)) {
            throw new ValidationError("The simple product SKU cannot be bulk edited from the generic option editor.");
        }
        if (!hasVariantOption({ size: nextSize, color: nextColor })) {
            throw new ValidationError("Normal variants must include at least one customer option, such as size or color.");
        }

        const normalizedFieldsToUpdate = {
            ...fieldsToUpdate,
            ...("size" in fieldsToUpdate ? { size: nextSize } : {}),
            ...("color" in fieldsToUpdate ? { color: nextColor } : {}),
        };

        if (stock !== undefined && stock !== currentVariant.stock) {
            const delta = stock - currentVariant.stock;
            const movementIndex = statements.length;
            statements.push(buildStockMovementClaim(db, {
                movementId: crypto.randomUUID(),
                variantId: id,
                stockVersion: currentVariant.stockVersion,
                quantity: delta,
                previousStock: currentVariant.stock,
                newStock: stock,
                notes: "Stocktake: Product variant bulk edit",
                adminUserId,
            }));

            const updateIndex = statements.length;
            statements.push(
                db
                    .update(productVariants)
                    .set({
                        ...normalizedFieldsToUpdate,
                        stock,
                        stockVersion: sql`${productVariants.stockVersion} + 1`,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(
                        and(
                            eq(productVariants.id, id),
                            eq(productVariants.productId, productId),
                            eq(productVariants.stockVersion, currentVariant.stockVersion),
                            isNull(productVariants.deletedAt),
                        )
                    )
                    .returning({ id: productVariants.id })
            );
            stockResultPairs.push({ variantId: id, movementIndex, updateIndex, delta });
        } else if (Object.keys(normalizedFieldsToUpdate).length > 0) {
            statements.push(
                db
                    .update(productVariants)
                    .set({
                        ...normalizedFieldsToUpdate,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(
                        and(
                            eq(productVariants.id, id),
                            eq(productVariants.productId, productId),
                            isNull(productVariants.deletedAt)
                        )
                    )
                    .returning({ id: productVariants.id })
            );
        }
    }

    if (statements.length > 0) {
        const batchResults = await safeBatch(db, statements as never) as Array<Array<{ id: string }> | undefined>;
        for (const pair of stockResultPairs) {
            const movementRows = batchResults[pair.movementIndex];
            const updateRows = batchResults[pair.updateIndex];
            if ((movementRows?.length ?? 0) === 0 || (updateRows?.length ?? 0) === 0) {
                throw new ConflictError("Stock changed concurrently before variant bulk update could be saved");
            }
            if (pair.delta < 0) {
                await checkAndAlertLowStock(db, pair.variantId);
            }
        }
    }
}
