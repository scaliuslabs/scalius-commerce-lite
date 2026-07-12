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
    inventoryMovements,
    productLowStockAlerts,
    productOptionDefinitions,
    productOptionValues,
    productVariantOptionValues,
} from "@scalius/database/schema";
import { and, sql, desc, eq, asc, inArray, isNull, or, notInArray } from "drizzle-orm";
import { sanitizeFtsQuery } from "../../search/fts5";
import type { CreateProductInput, UpdateProductInput } from "./products.validation";
import { nanoid } from "nanoid";
import { NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import type { ProductWithDetails } from "./products.types";
import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { defaultProductSkuValues } from "./products.public-eligibility";
import { unixToDate } from "@scalius/shared/timestamps";
import { getBarcodeIdentityKey } from "@scalius/shared/barcode-identity";
import { loadProductOptions, loadVariantSelectedOptions } from "./products.option-model";
import {
    buildProductAggregateRevisionGuard,
    isProductAggregateRevisionConflict,
    readProductAggregateRevisionResult,
    rethrowProductAggregateRevisionConflictIfStale,
    type ProductAggregateRevisionResult,
} from "./products.aggregate-revision";
import { productVariantBarcodeIdentityEquals } from "./products.variant-identity";
import { normalizeOptionIdentity } from "./products.option-model";
import {
    normalizeVariantBarcode,
    rethrowProductVariantIdentityConstraint,
} from "./products.variants";
import { buildStockMovementClaim } from "../inventory/stock-movement-claims";

type SQLiteBatchItem = BatchItem<"sqlite">;

function requireProductTimestamp(
    value: Date | number | string | null | undefined,
    field: string,
): Date {
    const date = unixToDate(value);
    if (!date) {
        throw new ValidationError(`Product ${field} is invalid.`);
    }
    return date;
}

function defaultVariantValues(productId: string, price: number) {
    return defaultProductSkuValues(productId, price);
}

function prepareProductImageRows(
    productId: string,
    images: CreateProductInput["images"],
    alwaysGenerateIds = false,
    existingImageIdByUrl: ReadonlyMap<string, string> = new Map(),
) {
    const imageIdMap = new Map<string, string>();
    const submittedImageIds = new Set<string>();
    const rows = images.map((image, index) => {
        if (submittedImageIds.has(image.id)) {
            throw new ValidationError("Each product image may appear only once.");
        }
        submittedImageIds.add(image.id);
        const persistedId = alwaysGenerateIds
            ? `img_${nanoid()}`
            : image.id.startsWith("temp_")
                ? existingImageIdByUrl.get(image.url) ?? `img_${nanoid()}`
                : image.id;
        imageIdMap.set(image.id, persistedId);
        return {
            id: persistedId,
            productId,
            url: image.url,
            alt: image.filename,
            isPrimary: index === 0,
            sortOrder: index,
        };
    });
    return { rows, imageIdMap };
}

function isSimpleDefaultSkuSet(variants: Array<{ isDefault: boolean; optionCombinationKey: string | null }>): boolean {
    return variants.length === 1 && variants[0]?.isDefault === true && variants[0].optionCombinationKey === null;
}

function hasInvalidSkuTopology(variants: Array<{ isDefault: boolean; optionCombinationKey: string | null }>): boolean {
    const defaultSkuCount = variants.filter((variant) => variant.isDefault).length;
    if (isSimpleDefaultSkuSet(variants)) return false;
    return defaultSkuCount > 0 || variants.some((variant) => !variant.optionCombinationKey?.trim());
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
        const barcodeKey = getBarcodeIdentityKey(search);

        const sanitized = sanitizeFtsQuery(search);
        if (sanitized) {
            const ftsCondition = sql`(${sql.raw("products")}.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ${sanitized}) OR EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${sql.raw("product_variants")}.rowid IN (SELECT rowid FROM product_variants_fts WHERE product_variants_fts MATCH ${sanitized})))`;

            if (barcodeKey) {
                // Also match by exact barcode value
                const barcodeCondition = sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariantBarcodeIdentityEquals(barcodeKey)} AND ${productVariants.deletedAt} IS NULL)`;
                whereConditions.push(sql`(${ftsCondition} OR ${barcodeCondition})`);
            } else {
                whereConditions.push(ftsCondition);
            }
            rankExpression = sql`COALESCE((SELECT rank FROM products_fts WHERE rowid = products.rowid AND products_fts MATCH ${sanitized}), 0) ASC`;
        } else if (barcodeKey) {
            // FTS sanitized to nothing but it's a barcode — search by barcode only
            const barcodeCondition = sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariantBarcodeIdentityEquals(barcodeKey)} AND ${productVariants.deletedAt} IS NULL)`;
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
            aggregateRevision: products.aggregateRevision,
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
        aggregateRevision: product.aggregateRevision,
        createdAt: requireProductTimestamp(product.createdAt, "created timestamp"),
        updatedAt: requireProductTimestamp(product.updatedAt, "updated timestamp"),
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
            canonicalPath: products.canonicalPath,
            noIndex: products.noIndex,
            excludeFromSitemap: products.excludeFromSitemap,
            excludeFromProductFeed: products.excludeFromProductFeed,
            productCondition: products.productCondition,
            aggregateRevision: products.aggregateRevision,
            createdAt: products.createdAt,
            updatedAt: products.updatedAt,
            deletedAt: products.deletedAt,
            isActive: products.isActive,
            discountPercentage: products.discountPercentage,
            discountType: products.discountType,
            discountAmount: products.discountAmount,
            freeDelivery: products.freeDelivery,
            taxClassId: products.taxClassId,
            taxClassificationVersion: products.taxClassificationVersion,
            category: {
                name: categories.name,
            },
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(eq(products.id, id));

    if (!result) return null;

    const [variants, imageRows, richContent, attributeValues] = await Promise.all([
        db
            .select()
            .from(productVariants)
            .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt))),
        db
            .select({
                id: productImages.id,
                productId: productImages.productId,
                url: productImages.url,
                alt: productImages.alt,
                isPrimary: productImages.isPrimary,
                sortOrder: productImages.sortOrder,
                createdAt: productImages.createdAt,
            })
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
    const images = imageRows.map((image) => ({
        id: image.id,
        productId: image.productId,
        url: image.url,
        alt: image.alt,
        isPrimary: image.isPrimary,
        sortOrder: image.sortOrder,
        createdAt: image.createdAt,
    }));
    const [optionsByProduct, selectedOptionsByVariant] = await Promise.all([
        loadProductOptions(db, [id]),
        loadVariantSelectedOptions(db, variants.map((variant) => variant.id)),
    ]);
    return {
        ...result,
        createdAt: requireProductTimestamp(result.createdAt, "created timestamp"),
        updatedAt: requireProductTimestamp(result.updatedAt, "updated timestamp"),
        deletedAt: result.deletedAt
            ? requireProductTimestamp(result.deletedAt, "deleted timestamp")
            : null,
        variants: variants.map((variant) => ({
            ...variant,
            selectedOptions: selectedOptionsByVariant.get(variant.id) ?? [],
        })),
        options: optionsByProduct.get(id) ?? [],
        images: images.map((img) => ({
            ...img,
            createdAt: requireProductTimestamp(img.createdAt, "image created timestamp"),
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
export async function createProduct(
    db: Database,
    data: CreateProductInput,
): Promise<{ id: string; aggregateRevision: number }> {
    const existingProduct = await db
        .select({ id: products.id })
        .from(products)
        .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
        .get();

    if (existingProduct) {
        throw new ConflictError("A product with this slug already exists");
    }

    const productId = "prod_" + nanoid();
    const defaultVariant = defaultVariantValues(productId, data.price);
    const preparedImages = prepareProductImageRows(productId, data.images, true);

    // Drizzle D1 batch() requires specific tuple types
    const batchOps: [SQLiteBatchItem, ...SQLiteBatchItem[]] = [
        db.insert(products).values({
            id: productId,
            name: data.name,
            description: data.description || null,
            price: data.price,
            categoryId: data.categoryId,
            slug: data.slug,
            metaTitle: data.metaTitle || null,
            metaDescription: data.metaDescription,
            canonicalPath: data.canonicalPath ?? null,
            noIndex: data.noIndex ?? false,
            excludeFromSitemap: data.excludeFromSitemap ?? false,
            excludeFromProductFeed: data.excludeFromProductFeed ?? false,
            productCondition: data.productCondition,
            isActive: data.isActive,
            discountType: data.discountType || "percentage",
            discountPercentage: (data.discountType || "percentage") === "percentage" ? (data.discountPercentage || null) : 0,
            discountAmount: (data.discountType || "percentage") === "flat" ? (data.discountAmount || null) : 0,
            freeDelivery: data.freeDelivery,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
            deletedAt: null,
        }),
    ];

    if (!data.optionMatrix) {
        batchOps.push(db.insert(productVariants).values(defaultVariant));
    }

    if (preparedImages.rows.length > 0) {
        batchOps.push(...preparedImages.rows.map((image) =>
            db.insert(productImages).values(image)
        ));
    }

    if (data.optionMatrix) {
        const definitionIdMap = new Map<string, string>();
        const valueIdMap = new Map<string, string>();
        for (const [position, option] of data.optionMatrix.options.entries()) {
            const optionId = `popt_${nanoid()}`;
            definitionIdMap.set(option.id, optionId);
            batchOps.push(db.insert(productOptionDefinitions).values({
                id: optionId,
                productId,
                name: option.name,
                normalizedName: normalizeOptionIdentity(option.name),
                position,
                standardMapping: option.standardMapping,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
                deletedAt: null,
            }));
            for (const [valuePosition, value] of option.values.entries()) {
                const valueId = `pval_${nanoid()}`;
                valueIdMap.set(value.id, valueId);
                batchOps.push(db.insert(productOptionValues).values({
                    id: valueId,
                    optionDefinitionId: optionId,
                    value: value.value,
                    normalizedValue: normalizeOptionIdentity(value.value),
                    position: valuePosition,
                    createdAt: sql`unixepoch()`,
                    updatedAt: sql`unixepoch()`,
                    deletedAt: null,
                }));
            }
        }

        const assignmentRows: Array<{
            variantId: string;
            optionDefinitionId: string;
            optionValueId: string;
        }> = [];
        for (const matrixVariant of data.optionMatrix.variants) {
            const variantId = `var_${nanoid()}`;
            const selectedOptionValueIds = matrixVariant.selectedOptionValueIds.map((id) => {
                const valueId = valueIdMap.get(id);
                if (!valueId) throw new ValidationError("A selected option value is not in this product matrix.");
                return valueId;
            });
            const imageId = matrixVariant.imageId
                ? preparedImages.imageIdMap.get(matrixVariant.imageId)
                : null;
            if (matrixVariant.imageId && !imageId) {
                throw new ValidationError("A selected SKU image is not in this product media set.");
            }
            const barcode = normalizeVariantBarcode(matrixVariant.barcode, matrixVariant.barcodeType);
            const variantFields = {
                id: variantId,
                productId,
                optionCombinationKey: selectedOptionValueIds.join("|"),
                imageId,
                weight: matrixVariant.weight,
                sku: matrixVariant.sku.trim(),
                price: matrixVariant.price,
                stock: 0,
                reservedStock: 0,
                preorderStock: 0,
                isDefault: false,
                trackInventory: matrixVariant.trackInventory,
                barcode: barcode.barcode,
                barcodeType: barcode.barcodeType,
                discountType: matrixVariant.discountType,
                discountPercentage: matrixVariant.discountType === "percentage"
                    ? matrixVariant.discountPercentage ?? 0
                    : 0,
                discountAmount: matrixVariant.discountType === "flat"
                    ? matrixVariant.discountAmount ?? 0
                    : 0,
                version: 1,
                stockVersion: 1,
                allowPreorder: false,
                allowBackorder: false,
                backorderLimit: 0,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
                deletedAt: null,
            };
            batchOps.push(db.insert(productVariants).values(variantFields));
            for (const [optionIndex, option] of data.optionMatrix.options.entries()) {
                assignmentRows.push({
                    variantId,
                    optionDefinitionId: definitionIdMap.get(option.id)!,
                    optionValueId: selectedOptionValueIds[optionIndex]!,
                });
            }
            if (matrixVariant.stock > 0) {
                batchOps.push(buildStockMovementClaim(db, {
                    movementId: crypto.randomUUID(),
                    variantId,
                    pool: "regular",
                    quantity: matrixVariant.stock,
                    before: { stock: 0, reservedStock: 0, preorderStock: 0, stockVersion: 1 },
                    after: { stock: matrixVariant.stock, reservedStock: 0, preorderStock: 0, stockVersion: 2 },
                    notes: "Stocktake: Initial product option stock",
                }));
                batchOps.push(db.update(productVariants)
                    .set({ stock: matrixVariant.stock, stockVersion: 2, updatedAt: sql`unixepoch()` })
                    .where(and(eq(productVariants.id, variantId), eq(productVariants.stockVersion, 1))));
            }
        }
        for (let index = 0; index < assignmentRows.length; index += 25) {
            batchOps.push(db.insert(productVariantOptionValues).values(
                assignmentRows.slice(index, index + 25),
            ));
        }
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

    try {
        await db.batch(batchOps);
    } catch (error) {
        rethrowProductVariantIdentityConstraint(error);
    }
    return { id: productId, aggregateRevision: 1 };
}

/**
 * Updates an existing product, replacing images, rich content, and attributes.
 * Validates that the product exists and the slug is not taken by another product.
 */
export async function updateProduct(
    db: Database,
    id: string,
    data: UpdateProductInput,
): Promise<ProductAggregateRevisionResult> {
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

    const [activeVariants, existingImages] = await Promise.all([
        db
            .select({
                id: productVariants.id,
                isDefault: productVariants.isDefault,
                optionCombinationKey: productVariants.optionCombinationKey,
            })
            .from(productVariants)
            .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt))),
        db
            .select({ id: productImages.id, url: productImages.url })
            .from(productImages)
            .where(eq(productImages.productId, id)),
    ]);
    const preparedImages = prepareProductImageRows(
        id,
        data.images,
        false,
        new Map(existingImages.map((image) => [image.url, image.id])),
    );
    const existingImageIds = new Set(existingImages.map((image) => image.id));
    for (const image of data.images) {
        if (!image.id.startsWith("temp_") && !existingImageIds.has(image.id)) {
            throw new ValidationError("A submitted product image does not belong to this product.");
        }
    }
    const submittedImageIds = preparedImages.rows.map((image) => image.id);

    // Drizzle D1 batch() requires specific tuple types
    const batchOps: unknown[] = [
        buildProductAggregateRevisionGuard(db, id, data.expectedAggregateRevision),
        db.update(products)
            .set({
                name: data.name,
                description: data.description,
                price: data.price,
                categoryId: data.categoryId,
                slug: data.slug,
                metaTitle: data.metaTitle,
                metaDescription: data.metaDescription,
                canonicalPath: data.canonicalPath ?? null,
                noIndex: data.noIndex ?? false,
                excludeFromSitemap: data.excludeFromSitemap ?? false,
                excludeFromProductFeed: data.excludeFromProductFeed ?? false,
                productCondition: data.productCondition,
                isActive: data.isActive,
                discountType: data.discountType || "percentage",
                discountPercentage: (data.discountType || "percentage") === "percentage" ? (data.discountPercentage ?? null) : 0,
                discountAmount: (data.discountType || "percentage") === "flat" ? (data.discountAmount ?? null) : 0,
                freeDelivery: data.freeDelivery,
                aggregateRevision: sql`${products.aggregateRevision} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(products.id, id))
            .returning({ aggregateRevision: products.aggregateRevision }),
        submittedImageIds.length > 0
            ? db.delete(productImages).where(and(
                eq(productImages.productId, id),
                notInArray(productImages.id, submittedImageIds),
            ))
            : db.delete(productImages).where(eq(productImages.productId, id)),
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.delete(productRichContent).where(eq(productRichContent.productId, id)),
    ];

    if (preparedImages.rows.length > 0) {
        batchOps.push(...preparedImages.rows.map((image) =>
            db.insert(productImages).values(image).onConflictDoUpdate({
                target: productImages.id,
                set: {
                    url: image.url,
                    alt: image.alt,
                    isPrimary: image.isPrimary,
                    sortOrder: image.sortOrder,
                },
            })
        ));
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
        throw new ValidationError("Product SKU data is invalid: only one default SKU is allowed, and every non-default SKU must include at least one customer option.");
    }

    if (isSimpleDefaultSkuSet(activeVariants)) {
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

    try {
        const results = await safeBatch(db, batchOps as never) as unknown[];
        return readProductAggregateRevisionResult(results[1]);
    } catch (error) {
        return rethrowProductAggregateRevisionConflictIfStale(
            db,
            id,
            data.expectedAggregateRevision,
            error,
        );
    }
}

/**
 * Soft-deletes a product by setting deletedAt.
 */
export async function deleteProduct(
    db: Database,
    id: string,
    expectedAggregateRevision: number,
): Promise<ProductAggregateRevisionResult> {
    try {
        const results = await safeBatch(db, [
            buildProductAggregateRevisionGuard(db, id, expectedAggregateRevision),
            db
                .update(products)
                .set({
                    deletedAt: sql`unixepoch()`,
                    aggregateRevision: sql`${products.aggregateRevision} + 1`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(products.id, id))
                .returning({ aggregateRevision: products.aggregateRevision }),
        ] as never) as unknown[];
        return readProductAggregateRevisionResult(results[1]);
    } catch (error) {
        return rethrowProductAggregateRevisionConflictIfStale(
            db,
            id,
            expectedAggregateRevision,
            error,
        );
    }
}

/**
 * Restores a soft-deleted product by setting deletedAt to null.
 */
export async function restoreProduct(
    db: Database,
    id: string,
    expectedAggregateRevision: number,
): Promise<ProductAggregateRevisionResult> {
    const product = await db
        .select({
            id: products.id,
            price: products.price,
            isActive: products.isActive,
        })
        .from(products)
        .where(eq(products.id, id))
        .get();

    if (!product) {
        throw new NotFoundError("Product not found");
    }

    const activeVariantCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(productVariants)
        .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt)))
        .get();
    const defaultVariantId = `var_default_${id}`;
    const existingDefaultVariant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.id, defaultVariantId))
        .get();

    const statements: SQLiteBatchItem[] = [
        buildProductAggregateRevisionGuard(db, id, expectedAggregateRevision, "trashed"),
        db
            .update(products)
            .set({
                deletedAt: null,
                aggregateRevision: sql`${products.aggregateRevision} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(products.id, id))
            .returning({ aggregateRevision: products.aggregateRevision }),
    ];

    if (product.isActive && (activeVariantCount?.count ?? 0) === 0) {
        const { createdAt: _createdAt, ...defaultSkuRepairValues } = defaultVariantValues(id, product.price);
        void _createdAt;
        if (existingDefaultVariant) {
            statements.push(
                db
                    .update(productVariants)
                    .set({
                        ...defaultSkuRepairValues,
                        updatedAt: sql`unixepoch()`,
                        deletedAt: null,
                    })
                    .where(eq(productVariants.id, defaultVariantId)),
            );
        } else {
            statements.push(db.insert(productVariants).values(defaultVariantValues(id, product.price)));
        }
    }

    try {
        const results = await safeBatch(db, statements) as unknown[];
        return readProductAggregateRevisionResult(results[1]);
    } catch (error) {
        return rethrowProductAggregateRevisionConflictIfStale(
            db,
            id,
            expectedAggregateRevision,
            error,
            "trashed",
        );
    }
}

async function loadProductVariantIds(db: Database, productIds: string[]): Promise<string[]> {
    if (productIds.length === 0) return [];

    const variantRows = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(inArray(productVariants.productId, productIds));

    return variantRows.map((variant) => variant.id).filter(Boolean);
}

async function assertNoVariantInventoryHistory(
    db: Database,
    variantIds: string[],
    message: string,
): Promise<void> {
    if (variantIds.length === 0) return;

    const movementCheckArr = await db
        .select({ count: sql<number>`count(*)` })
        .from(inventoryMovements)
        .where(inArray(inventoryMovements.variantId, variantIds));

    if ((movementCheckArr[0]?.count ?? 0) > 0) {
        throw new ConflictError(message);
    }
}

async function assertNoPermanentDeleteReferences(
    db: Database,
    productIds: string[],
    messages: { orders: string; discounts: string; inventory: string },
): Promise<string[]> {
    const idSet = JSON.stringify(productIds);
    const orderCheck = await db
        .select({ count: sql<number>`count(*)` })
        .from(orderItems)
        .where(sql`
            ${orderItems.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
            ) OR ${orderItems.variantId} IN (
                SELECT ${productVariants.id} FROM ${productVariants}
                WHERE ${productVariants.productId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${idSet})
                )
            )
        `);
    if ((orderCheck[0]?.count ?? 0) > 0) throw new ConflictError(messages.orders);

    const discountCheck = await db
        .select({ count: sql<number>`count(*)` })
        .from(discountProducts)
        .where(inArray(discountProducts.productId, productIds));
    if ((discountCheck[0]?.count ?? 0) > 0) throw new ConflictError(messages.discounts);

    const variantIds = await loadProductVariantIds(db, productIds);
    await assertNoVariantInventoryHistory(db, variantIds, messages.inventory);
    return variantIds;
}

function buildPermanentDeleteReferenceGuard(
    db: Database,
    productIds: string[],
): SQLiteBatchItem {
    const idSet = JSON.stringify(productIds);
    return buildBatchGuard(db, sql`
        CASE WHEN NOT EXISTS (
            SELECT 1 FROM ${orderItems}
            WHERE ${orderItems.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
            )
        ) AND NOT EXISTS (
            SELECT 1 FROM ${discountProducts}
            WHERE ${discountProducts.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
            )
        ) AND NOT EXISTS (
            SELECT 1 FROM ${inventoryMovements}
            INNER JOIN ${productVariants}
                ON ${inventoryMovements.variantId} = ${productVariants.id}
            WHERE ${productVariants.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
            )
        ) AND NOT EXISTS (
            SELECT 1 FROM ${orderItems}
            WHERE ${orderItems.variantId} IN (
                SELECT ${productVariants.id} FROM ${productVariants}
                WHERE ${productVariants.productId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${idSet})
                )
            )
        ) THEN 1 ELSE json_extract('PRODUCT_HARD_DELETE_CONFLICT', '$') END
    `);
}

function deleteLowStockAlertsForProductBatch(
    db: Database,
    productIds: string[],
    variantIds: string[],
): SQLiteBatchItem {
    const productCondition = inArray(productLowStockAlerts.productId, productIds);
    const variantCondition = variantIds.length > 0
        ? inArray(productLowStockAlerts.variantId, variantIds)
        : undefined;

    return db
        .delete(productLowStockAlerts)
        .where(variantCondition ? or(productCondition, variantCondition) : productCondition);
}

/**
 * Permanently deletes a product and all of its related data (variants, images, attributes, rich content).
 * Throws an error if the product is linked to any existing orders or discounts.
 */
export async function permanentlyDeleteProduct(
    db: Database,
    id: string,
    expectedAggregateRevision: number,
): Promise<void> {
    const referenceMessages = {
        orders: "Cannot delete product. It is part of one or more existing orders.",
        discounts: "Cannot delete product. It is linked to one or more discounts.",
        inventory:
            "Cannot permanently delete product. One or more SKUs have inventory history; move the product to trash instead.",
    };
    const variantIds = await assertNoPermanentDeleteReferences(
        db,
        [id],
        referenceMessages,
    );

    try {
        await safeBatch(db, [
        buildProductAggregateRevisionGuard(db, id, expectedAggregateRevision, "trashed"),
        buildPermanentDeleteReferenceGuard(db, [id]),
        deleteLowStockAlertsForProductBatch(db, [id], variantIds),
        db.delete(productVariants).where(eq(productVariants.productId, id)),
        db.delete(productImages).where(eq(productImages.productId, id)),
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.delete(productRichContent).where(eq(productRichContent.productId, id)),
        db.delete(products).where(eq(products.id, id)),
        ]);
    } catch (error) {
        await assertNoPermanentDeleteReferences(db, [id], referenceMessages);
        return rethrowProductAggregateRevisionConflictIfStale(
            db,
            id,
            expectedAggregateRevision,
            error,
            "trashed",
        );
    }
}

/**
 * Bulk soft-deletes or permanently deletes multiple products.
 */
export type ProductAggregateRevisionClaim = {
    id: string;
    expectedAggregateRevision: number;
};

async function findStaleProductAggregateRevisionClaim(
    db: Database,
    claims: ProductAggregateRevisionClaim[],
    requiredState: "active" | "trashed",
): Promise<ProductAggregateRevisionClaim | null> {
    for (const claim of claims) {
        const current = await db
            .select({
                aggregateRevision: products.aggregateRevision,
                deletedAt: products.deletedAt,
            })
            .from(products)
            .where(eq(products.id, claim.id))
            .get();
        const stateMatches = requiredState === "active"
            ? current?.deletedAt === null
            : current?.deletedAt != null;
        if (
            current?.aggregateRevision !== claim.expectedAggregateRevision ||
            !stateMatches
        ) {
            return claim;
        }
    }
    return null;
}

export async function bulkDeleteProducts(
    db: Database,
    productClaims: ProductAggregateRevisionClaim[],
    permanent: boolean = false,
): Promise<ProductAggregateRevisionResult[]> {
    if (productClaims.length === 0) throw new ValidationError("No product IDs provided");
    const productIds = productClaims.map((claim) => claim.id);
    if (new Set(productIds).size !== productIds.length) {
        throw new ValidationError("Each product may appear only once in a bulk delete.");
    }

    if (permanent) {
        const referenceMessages = {
            orders:
                "Cannot delete products. One or more products are part of existing orders.",
            discounts:
                "Cannot delete products. One or more products are linked to discounts.",
            inventory:
                "Cannot permanently delete products. One or more SKUs have inventory history; move the products to trash instead.",
        };
        const variantIds = await assertNoPermanentDeleteReferences(
            db,
            productIds,
            referenceMessages,
        );

        try {
            await safeBatch(db, [
                ...productClaims.map((claim) =>
                    buildProductAggregateRevisionGuard(
                        db,
                        claim.id,
                        claim.expectedAggregateRevision,
                        "trashed",
                    )
                ),
                buildPermanentDeleteReferenceGuard(db, productIds),
                deleteLowStockAlertsForProductBatch(db, productIds, variantIds),
                db.delete(productVariants).where(inArray(productVariants.productId, productIds)),
                db.delete(productImages).where(inArray(productImages.productId, productIds)),
                db.delete(productAttributeValues).where(inArray(productAttributeValues.productId, productIds)),
                db.delete(productRichContent).where(inArray(productRichContent.productId, productIds)),
                db.delete(products).where(inArray(products.id, productIds)),
            ]);
        } catch (error) {
            await assertNoPermanentDeleteReferences(
                db,
                productIds,
                referenceMessages,
            );
            if (isProductAggregateRevisionConflict(error)) {
                const failedClaim = await findStaleProductAggregateRevisionClaim(
                    db,
                    productClaims,
                    "trashed",
                );
                if (failedClaim) {
                    return rethrowProductAggregateRevisionConflictIfStale(
                        db,
                        failedClaim.id,
                        failedClaim.expectedAggregateRevision,
                        error,
                        "trashed",
                    );
                }
            }
            throw error;
        }
        return [];
    } else {
        const statements = productClaims.flatMap((claim) => [
            buildProductAggregateRevisionGuard(
                db,
                claim.id,
                claim.expectedAggregateRevision,
            ),
            db
                .update(products)
                .set({
                    deletedAt: sql`unixepoch()`,
                    aggregateRevision: sql`${products.aggregateRevision} + 1`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(products.id, claim.id))
                .returning({ aggregateRevision: products.aggregateRevision }),
        ]);
        try {
            const results = await safeBatch(db, statements as never) as unknown[];
            return productClaims.map((_, index) =>
                readProductAggregateRevisionResult(results[index * 2 + 1])
            );
        } catch (error) {
            if (isProductAggregateRevisionConflict(error)) {
                const staleClaim = await findStaleProductAggregateRevisionClaim(
                    db,
                    productClaims,
                    "active",
                );
                if (staleClaim) {
                    return rethrowProductAggregateRevisionConflictIfStale(
                        db,
                        staleClaim.id,
                        staleClaim.expectedAggregateRevision,
                        error,
                    );
                }
            }
            throw error;
        }
    }
}
