// src/modules/products/products.admin.ts
// Admin product queries and CRUD mutations.
import {
    products,
    categories,
    productVariants,
    productMedia,
    media,
    productRichContent,
    productAttributeValues,
    productAttributes,
    orderItems,
    inventoryMovements,
    productLowStockAlerts,
    productOptionDefinitions,
    productOptionValues,
    productVariantOptionValues,
} from "@scalius/database/schema";
import { and, sql, desc, eq, asc, inArray, isNull, or } from "drizzle-orm";
import {
    ftsMatch,
    isFts5SearchEnabled,
    sanitizeFtsQuery,
} from "../../search/fts5";
import { createProductSchema, type CreateProductInput, type UpdateProductInput } from "./products.validation";
import { DEFAULT_PRODUCT_CONDITION } from "@scalius/shared/product-condition";
import { nanoid } from "nanoid";
import { AppError, NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import type { ProductWithDetails } from "./products.types";
import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { defaultProductSkuValues } from "./products.public-eligibility";
import {
    catalogPriceColumns,
    presentCatalogPrice,
    readStoreDecimalPlaces,
    storeCurrencyCodeSql,
    storeCurrencyFromCode,
    storeDecimalPlacesFromCode,
} from "./products.money";
import { readStoreCurrency, toStoreMinor } from "../settings/store-money";
import { bpsToPercent, fromMinor, percentToBps, toMinor } from "@scalius/shared/money";
import { unixToDate } from "@scalius/shared/timestamps";
import { getBarcodeIdentityKey } from "@scalius/shared/barcode-identity";
import { loadProductOptions, loadProductVariantSelectedOptions } from "./products.option-model";
import {
    buildProductAggregateRevisionGuard,
    executeProductAggregateMutationBatch,
    isProductAggregateRevisionConflict,
    productPriceMinorSql,
    readProductAggregateRevisionResult,
    rethrowProductAggregateRevisionConflictIfStale,
    type ProductAggregateRevisionResult,
} from "./products.aggregate-revision";
import { productVariantBarcodeIdentityEquals } from "./products.variant-identity";
import { normalizeOptionIdentity } from "./products.option-model";
import {
    resolveNewVariantBarcode,
    rethrowProductVariantIdentityConstraint,
    assertSkusFree,
    readableDefaultSku,
} from "./products.variants";
import { buildStockMovementClaim } from "../inventory/stock-movement-claims";
import { insertWithDerivedHandle } from "../../utils/derived-handle";
import {
    loadProductMediaProjections,
    MAX_PRODUCT_MEDIA_ASSOCIATIONS,
    PRODUCT_MEDIA_REORDER_OFFSET,
    resolveProductMediaProjectionRows,
    resolveProductImageRepresentation,
    selectProductMediaProjectionRows,
} from "./products.media";
import type {
    ProductMediaProjection,
    ProductMediaProjectionRow,
} from "./products.media";
import {
    buildBuyerCatalogPricingProjection,
    buyerPriceRangeColumns,
    presentBuyerPriceRange,
    type BuyerPriceRange,
} from "./products.buyer-projection";

type SQLiteBatchItem = BatchItem<"sqlite">;

// Each D1 statement accepts at most 100 bound parameters. Keep multi-row
// product aggregate inserts comfortably below that boundary.
const PRODUCT_AGGREGATE_INSERT_CHUNK = 18;
const PRODUCT_MEDIA_INSERT_CHUNK = 12;
const MAX_PRODUCT_ATTRIBUTE_ASSIGNMENTS = 90;

async function assertActiveAttributeAssignments(
    db: Database,
    assignments: Array<{ attributeId: string }>,
): Promise<void> {
    const attributeIds = [...new Set(assignments.map((item) => item.attributeId.trim()).filter(Boolean))];
    if (attributeIds.length === 0) return;
    if (attributeIds.length > MAX_PRODUCT_ATTRIBUTE_ASSIGNMENTS) {
        throw new ValidationError(
            `Assign at most ${MAX_PRODUCT_ATTRIBUTE_ASSIGNMENTS} attributes to a product.`,
        );
    }

    const activeAttributes = await db
        .select({ id: productAttributes.id })
        .from(productAttributes)
        .where(and(
            isNull(productAttributes.deletedAt),
            sql`${productAttributes.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(attributeIds)})
            )`,
        ))
        .all();

    if (activeAttributes.length !== attributeIds.length) {
        throw new ValidationError(
            "One or more assigned attributes are unavailable or in trash. Remove them and try again.",
        );
    }
}

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

function defaultVariantValues(productId: string, priceMinor: number) {
    return defaultProductSkuValues(productId, priceMinor);
}

type ProductMediaInput = CreateProductInput["media"][number];
type ProductMediaPlanRow = ProductMediaInput & {
    productId: string;
    sortOrder: number;
    kind: "image" | "video";
    status: "ready" | "trashed" | "deleting" | "deleted";
    existing: boolean;
};

type ProductMediaPlan = {
    rows: ProductMediaPlanRow[];
    existingRows: Array<{ id: string; mediaId: string }>;
    retainedRows: ProductMediaPlanRow[];
    newRows: ProductMediaPlanRow[];
};

export class ProductMediaSkuReferenceConflictError extends AppError {
    constructor(details: {
        affectedCount: number;
        affectedAssociationIds: string[];
        affectedSkus: Array<{ id: string; sku: string; imageId: string }>;
    }) {
        super(
            409,
            "PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT",
            "One or more removed images are still assigned to SKUs. Confirm that those SKUs should use the featured fallback.",
            details,
        );
        this.name = "ProductMediaSkuReferenceConflictError";
    }
}

async function validateProductMediaPlan(
    db: Database,
    productId: string,
    submitted: CreateProductInput["media"],
    existingProduct: boolean,
): Promise<ProductMediaPlan> {
    if (submitted.length > MAX_PRODUCT_MEDIA_ASSOCIATIONS) {
        throw new ValidationError(`Attach at most ${MAX_PRODUCT_MEDIA_ASSOCIATIONS} media items to a product.`);
    }
    const associationIds = submitted.map((item) => item.id);
    const mediaIds = submitted.map((item) => item.mediaId);
    if (
        new Set(associationIds).size !== associationIds.length
        || new Set(mediaIds).size !== mediaIds.length
    ) {
        throw new ValidationError("Product media association and asset IDs must be unique.");
    }
    const primaryCount = submitted.filter((item) => item.isPrimary).length;
    if (submitted.length > 0 && primaryCount !== 1) {
        throw new ValidationError("Choose exactly one featured media item.");
    }

    const existingRows = existingProduct
        ? await db
            .select({ id: productMedia.id, mediaId: productMedia.mediaId })
            .from(productMedia)
            .where(eq(productMedia.productId, productId))
        : [];
    const existingById = new Map(existingRows.map((row) => [row.id, row]));

    const collisions = associationIds.length === 0
        ? []
        : await db
            .select({ id: productMedia.id, productId: productMedia.productId, mediaId: productMedia.mediaId })
            .from(productMedia)
            .where(sql`${productMedia.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(associationIds)})
            )`);
    const collisionById = new Map(collisions.map((row) => [row.id, row]));

    const assetRows = mediaIds.length === 0
        ? []
        : await db
            .select({ id: media.id, kind: media.kind, status: media.status })
            .from(media)
            .where(sql`${media.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(mediaIds)})
            )`);
    const assetById = new Map(assetRows.map((row) => [row.id, row]));

    const rows = submitted.map((item, sortOrder): ProductMediaPlanRow => {
        const existing = existingById.get(item.id);
        const collision = collisionById.get(item.id);
        if (collision && (collision.productId !== productId || collision.mediaId !== item.mediaId)) {
            throw new ValidationError("A product media association ID is already in use or points to another asset.");
        }
        if (existing && existing.mediaId !== item.mediaId) {
            throw new ValidationError("An existing product media association cannot be changed to another asset.");
        }
        const asset = assetById.get(item.mediaId);
        if (!asset) throw new ValidationError("One or more selected media assets no longer exist.");
        if (existing) {
            if (asset.status !== "ready" && asset.status !== "trashed") {
                throw new ValidationError("An attached media asset is no longer available.");
            }
        } else if (asset.status !== "ready") {
            throw new ValidationError("Only ready media assets can be newly attached to a product.");
        }
        return {
            ...item,
            productId,
            sortOrder,
            kind: asset.kind,
            status: asset.status,
            existing: Boolean(existing),
        };
    });

    return {
        rows,
        existingRows,
        retainedRows: rows.filter((row) => row.existing),
        newRows: rows.filter((row) => !row.existing),
    };
}

function assertSubmittedSkuImage(
    imageId: string | null,
    rows: readonly ProductMediaPlanRow[],
): void {
    if (!imageId) return;
    const association = rows.find((row) => row.id === imageId);
    if (!association || association.kind !== "image" || association.status !== "ready") {
        throw new ValidationError("A selected SKU image must be a ready image attached to this product.");
    }
}

function buildProductMediaInsertStatements(
    db: Database,
    rows: readonly ProductMediaPlanRow[],
): SQLiteBatchItem[] {
    const statements: SQLiteBatchItem[] = [];
    for (let index = 0; index < rows.length; index += PRODUCT_MEDIA_INSERT_CHUNK) {
        statements.push(db.insert(productMedia).values(
            rows.slice(index, index + PRODUCT_MEDIA_INSERT_CHUNK).map((row) => ({
                id: row.id,
                productId: row.productId,
                mediaId: row.mediaId,
                altText: row.altText,
                isPrimary: row.isPrimary,
                sortOrder: row.sortOrder,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            })),
        ));
    }
    return statements;
}

async function assertRemovedSkuImagesAcknowledged(
    db: Database,
    productId: string,
    removedAssociationIds: readonly string[],
    acknowledgedAssociationIds: readonly string[],
): Promise<string[]> {
    if (removedAssociationIds.length === 0) {
        if (acknowledgedAssociationIds.length > 0) {
            throw new ValidationError("SKU image fallback acknowledgement is stale. Reload the product and try again.");
        }
        return [];
    }
    const removedJson = JSON.stringify(removedAssociationIds);
    const affected = await db
        .select({
            id: productVariants.id,
            sku: productVariants.sku,
            imageId: productVariants.imageId,
        })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
            sql`${productVariants.imageId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${removedJson})
            )`,
        ));
    const affectedAssociationIds = [...new Set(
        affected.flatMap((row) => row.imageId ? [row.imageId] : []),
    )];
    const affectedIdSet = new Set(affectedAssociationIds);
    const acknowledged = new Set(acknowledgedAssociationIds);
    if (acknowledgedAssociationIds.some((id) => !affectedIdSet.has(id))) {
        throw new ValidationError("SKU image fallback acknowledgement is stale. Reload the product and try again.");
    }
    if (affectedAssociationIds.some((id) => !acknowledged.has(id))) {
        throw new ProductMediaSkuReferenceConflictError({
            affectedCount: affected.length,
            affectedAssociationIds: affectedAssociationIds.slice(0, 20),
            affectedSkus: affected.slice(0, 5).map((row) => ({
                id: row.id,
                sku: row.sku,
                imageId: row.imageId!,
            })),
        });
    }
    return affectedAssociationIds;
}

function buildProductMediaUpdateStatements(
    db: Database,
    productId: string,
    plan: ProductMediaPlan,
    clearSkuImageIds: readonly string[],
): SQLiteBatchItem[] {
    const statements: SQLiteBatchItem[] = [];
    if (plan.existingRows.length > 0) {
        statements.push(db.update(productMedia).set({
            isPrimary: false,
            sortOrder: sql`${productMedia.sortOrder} + ${PRODUCT_MEDIA_REORDER_OFFSET}`,
            updatedAt: sql`unixepoch()`,
        }).where(eq(productMedia.productId, productId)));
    }
    if (clearSkuImageIds.length > 0) {
        statements.push(db.update(productVariants).set({
            imageId: null,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
            sql`${productVariants.imageId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(clearSkuImageIds)})
            )`,
        )));
    }

    const submittedIds = plan.rows.map((row) => row.id);
    statements.push(submittedIds.length > 0
        ? db.delete(productMedia).where(and(
            eq(productMedia.productId, productId),
            sql`${productMedia.id} NOT IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(submittedIds)})
            )`,
        ))
        : db.delete(productMedia).where(eq(productMedia.productId, productId)));

    if (plan.retainedRows.length > 0) {
        const retainedJson = JSON.stringify(plan.retainedRows.map((row) => ({
            id: row.id,
            altText: row.altText,
            isPrimary: row.isPrimary ? 1 : 0,
            sortOrder: row.sortOrder,
        })));
        statements.push(db.update(productMedia).set({
            altText: sql`(
                SELECT json_extract(value, '$.altText')
                FROM json_each(${retainedJson})
                WHERE json_extract(value, '$.id') = ${productMedia.id}
            )`,
            isPrimary: sql`(
                SELECT CAST(json_extract(value, '$.isPrimary') AS INTEGER)
                FROM json_each(${retainedJson})
                WHERE json_extract(value, '$.id') = ${productMedia.id}
            )`,
            sortOrder: sql`(
                SELECT CAST(json_extract(value, '$.sortOrder') AS INTEGER)
                FROM json_each(${retainedJson})
                WHERE json_extract(value, '$.id') = ${productMedia.id}
            )`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(productMedia.productId, productId),
            sql`${productMedia.id} IN (
                SELECT CAST(json_extract(value, '$.id') AS TEXT)
                FROM json_each(${retainedJson})
            )`,
        )));
    }
    statements.push(...buildProductMediaInsertStatements(db, plan.newRows));
    return statements;
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
    /** "active" = sold on the storefront, "draft" = hidden. */
    status?: "active" | "draft";
    sort?: "name" | "price" | "category" | "createdAt" | "updatedAt";
    order?: "asc" | "desc";
    /** Agent summaries omit large text/media projections before they leave SQL. */
    agentSummary?: boolean;
    /** Compact dashboard lists can omit rich text while preserving the default API contract. */
    includeDescription?: boolean;
}) {
    const {
        search,
        categoryId,
        page = 1,
        limit = 10,
        showTrashed = false,
        status,
        sort = "updatedAt",
        order = "desc",
        agentSummary = false,
        includeDescription = true,
    } = options;
    const offset = (page - 1) * limit;

    const whereConditions = [];

    if (showTrashed) {
        whereConditions.push(sql`${products.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${products.deletedAt} IS NULL`);
    }
    if (status) {
        whereConditions.push(eq(products.isActive, status === "active"));
    }

    let rankExpression = undefined;
    if (search) {
        const barcodeKey = getBarcodeIdentityKey(search);

        const sanitized = sanitizeFtsQuery(search);
        if (sanitized) {
            const productSearch = ftsMatch(
                db,
                "products_fts",
                "products",
                search,
            );
            const variantSearch = ftsMatch(
                db,
                "product_variants_fts",
                "product_variants",
                search,
            );
            const ftsCondition = or(
                productSearch,
                variantSearch
                    ? sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariants.deletedAt} IS NULL AND ${variantSearch})`
                    : undefined,
            );

            if (barcodeKey) {
                // Also match by exact barcode value
                const barcodeCondition = sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariantBarcodeIdentityEquals(barcodeKey)} AND ${productVariants.deletedAt} IS NULL)`;
                whereConditions.push(ftsCondition
                    ? sql`(${ftsCondition} OR ${barcodeCondition})`
                    : barcodeCondition);
            } else if (ftsCondition) {
                whereConditions.push(ftsCondition);
            }
            if (isFts5SearchEnabled(db)) {
                rankExpression = sql`COALESCE((SELECT rank FROM products_fts WHERE rowid = products.rowid AND products_fts MATCH ${sanitized}), 0) ASC`;
            }
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

    const buyerPricing = buildBuyerCatalogPricingProjection(db);
    const productResultsQuery = db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            priceMinor: products.priceMinor,
            ...buyerPriceRangeColumns(buyerPricing),
            description: includeDescription
                ? products.description
                : sql<string | null>`NULL`,
            isActive: products.isActive,
            discountBps: products.discountBps,
            discountType: products.discountType,
            discountAmountMinor: products.discountAmountMinor,
            freeDelivery: products.freeDelivery,
            aggregateRevision: products.aggregateRevision,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${products.deletedAt} AS INTEGER)`,
            categoryName: sql<string>`${categories.name}`.as("categoryName"),
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .leftJoin(buyerPricing, eq(buyerPricing.productId, products.id))
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
                            return products.priceMinor;
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

    const [[countArr, productResults], decimalPlaces] = await Promise.all([db.batch([
        countQuery,
        productResultsQuery,
    ]), readStoreDecimalPlaces(db)]);
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
    const productIdSet = JSON.stringify(productIds);

    const enrichmentResults = await safeBatch(db, [
        db
            .select({
                productId: productVariants.productId,
                count: sql<number>`count(${productVariants.id})`,
                trackedCount: sql<number>`sum(CASE WHEN ${productVariants.trackInventory} THEN 1 ELSE 0 END)`,
                onHand: sql<number>`sum(CASE WHEN ${productVariants.trackInventory} THEN ${productVariants.stock} ELSE 0 END)`,
                hasSkuDiscount: sql<number>`max(CASE WHEN ${productVariants.discountBps} > 0 OR ${productVariants.discountAmountMinor} > 0 THEN 1 ELSE 0 END)`,
            })
            .from(productVariants)
            .where(
                sql`${productVariants.productId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
                ) AND ${productVariants.deletedAt} IS NULL`,
            )
            .groupBy(productVariants.productId),
        // Trash only: SKUs with stock history keep a product from permanent delete.
        db
            .selectDistinct({ productId: productVariants.productId })
            .from(productVariants)
            .where(sql`${showTrashed ? sql`1` : sql`0`} = 1 AND ${productVariants.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
            ) AND EXISTS (SELECT 1 FROM ${inventoryMovements} WHERE ${inventoryMovements.variantId} = ${productVariants.id})`),
        db
            .select({
                productId: productMedia.productId,
                count: sql<number>`count(${productMedia.id})`,
            })
            .from(productMedia)
            .where(sql`${productMedia.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
            )`)
            .groupBy(productMedia.productId),
        db
            .select({
                productId: productVariants.productId,
                sku: productVariants.sku,
            })
            .from(productVariants)
            .where(
                sql`${productVariants.productId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
                ) AND ${productVariants.deletedAt} IS NULL`,
            )
            .orderBy(productVariants.productId, asc(productVariants.createdAt)),
        selectProductMediaProjectionRows(db, agentSummary ? [] : productIds),
    ]);
    type VariantSummaryRow = { productId: string; count: number; trackedCount: number; onHand: number; hasSkuDiscount: number };
    const variantCounts = enrichmentResults[0] as VariantSummaryRow[];
    const productsWithStockHistory = new Set((enrichmentResults[1] as { productId: string }[]).map((row) => row.productId));
    const mediaCounts = enrichmentResults[2] as { productId: string; count: number }[];
    const productSkus = enrichmentResults[3] as { productId: string; sku: string }[];
    const mediaProjectionRows = enrichmentResults[4] as ProductMediaProjectionRow[];
    const mediaByProduct = agentSummary
        ? new Map<string, ProductMediaProjection[]>()
        : resolveProductMediaProjectionRows(mediaProjectionRows);

    const variantSummaryMap = new Map(variantCounts.map((row) => [row.productId, row]));

    const mediaCountMap = new Map<string, number>(
        mediaCounts.map((ic: { productId: string; count: number }) => [ic.productId, ic.count]),
    );

    const primaryImageMap = new Map<string, string>(
        productIds.flatMap((productId) => {
            const representation = resolveProductImageRepresentation(mediaByProduct.get(productId) ?? []);
            return representation ? [[productId, representation.url] as const] : [];
        }),
    );

    const skuMap = new Map<string, string>();
    productSkus.forEach((item: { productId: string; sku: string }) => {
        if (!skuMap.has(item.productId)) {
            skuMap.set(item.productId, item.sku);
        }
    });

    const combinedProducts = productResults.map((product) => {
        const price = presentCatalogPrice(product, decimalPlaces);
        return {
        id: product.id,
        name: product.name,
        slug: product.slug,
        price: price.price,
        priceRange: presentBuyerPriceRange(product, decimalPlaces),
        description: product.description,
        isActive: product.isActive,
        discountPercentage: price.discountPercentage,
        discountType: product.discountType || "percentage",
        discountAmount: price.discountAmount,
        freeDelivery: product.freeDelivery,
        aggregateRevision: product.aggregateRevision,
        createdAt: requireProductTimestamp(product.createdAt, "created timestamp"),
        updatedAt: requireProductTimestamp(product.updatedAt, "updated timestamp"),
        category: {
            name: product.categoryName || "Uncategorized",
        },
        variantCount: Number(variantSummaryMap.get(product.id)?.count ?? 0),
        /** Tracked on-hand units across live SKUs; null when no SKU tracks quantity. */
        onHand: Number(variantSummaryMap.get(product.id)?.trackedCount ?? 0) > 0
            ? Number(variantSummaryMap.get(product.id)?.onHand ?? 0)
            : null,
        /** Some SKUs carry their own discount, so the product price isn't the whole story. */
        hasVariantDiscount: Number(variantSummaryMap.get(product.id)?.hasSkuDiscount ?? 0) > 0,
        /** Trash only: stock history keeps this product from permanent delete. */
        hasStockHistory: productsWithStockHistory.has(product.id),
        mediaCount: mediaCountMap.get(product.id) || 0,
        primaryImage: primaryImageMap.get(product.id) || null,
        sku: skuMap.get(product.id) || undefined,
        };
    });

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
 * Bounded operation projection for MCP/CLI product discovery. Rich text and
 * media URLs stay behind the section/detail operations, so a page cannot echo
 * merchant-authored 100k fields into a 64 KiB structured result.
 */
export async function listProductAgentSummaries(db: Database, options: {
    search?: string;
    categoryId?: string;
    page?: number;
    limit?: number;
    showTrashed?: boolean;
    sort?: "name" | "price" | "category" | "createdAt" | "updatedAt";
    order?: "asc" | "desc";
}) {
    const result = await listProducts(db, { ...options, agentSummary: true });
    return {
        products: result.products.map((product) => ({
            id: product.id,
            name: product.name.slice(0, 100),
            slug: product.slug.slice(0, 100),
            price: product.price,
            isActive: product.isActive,
            aggregateRevision: product.aggregateRevision,
            category: { name: product.category.name.slice(0, 100) },
            variantCount: product.variantCount,
            sku: product.sku?.slice(0, 100),
        })),
        pagination: result.pagination,
    };
}

export interface ProductPickerSummary {
    id: string;
    name: string;
    price: number;
    /** What buyers pay; null when the product has no live SKU. */
    priceRange: BuyerPriceRange | null;
    categoryId: string | null;
    primaryImage: string | null;
    discountPercentage: number | null;
}

function normalizeLookupIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, 90);
}

/** Returns lightweight product metadata for already-known product IDs. */
export async function getProductsByIds(
    db: Database,
    ids: string[],
): Promise<ProductPickerSummary[]> {
    const lookupIds = normalizeLookupIds(ids);
    if (lookupIds.length === 0) return [];

    const orderById = new Map(lookupIds.map((id, index) => [id, index]));
    const buyerPricing = buildBuyerCatalogPricingProjection(db);
    const [rows, decimalPlaces] = await Promise.all([db
        .select({
            id: products.id,
            name: products.name,
            priceMinor: products.priceMinor,
            ...buyerPriceRangeColumns(buyerPricing),
            categoryId: products.categoryId,
            discountBps: products.discountBps,
        })
        .from(products)
        .leftJoin(buyerPricing, eq(buyerPricing.productId, products.id))
        .where(and(inArray(products.id, lookupIds), isNull(products.deletedAt))), readStoreDecimalPlaces(db)]);

    const mediaByProduct = await loadProductMediaProjections(db, rows.map((row) => row.id));
    return rows.map(({ priceMinor, discountBps, buyerFromMinor, buyerToMinor, buyerBaseMinor, ...row }) => ({
        ...row,
        price: fromMinor(priceMinor, decimalPlaces),
        priceRange: presentBuyerPriceRange({ buyerFromMinor, buyerToMinor, buyerBaseMinor }, decimalPlaces),
        discountPercentage: bpsToPercent(discountBps),
        primaryImage: resolveProductImageRepresentation(mediaByProduct.get(row.id) ?? [])?.url ?? null,
    })).sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));
}

/**
 * Returns full product details including variants and ordered media.
 * Returns null if the product does not exist.
 */
export async function getProductDetails(
    db: Database,
    id: string,
): Promise<ProductWithDetails | null> {
    // Every read is keyed by the product id: one wave, not three.
    const productRead = db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            priceMinor: products.priceMinor,
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
            discountBps: products.discountBps,
            discountType: products.discountType,
            discountAmountMinor: products.discountAmountMinor,
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

    const [[result], variants, mediaByProduct, richContent, attributeValues, decimalPlaces, optionsByProduct, selectedOptionsByVariant] = await Promise.all([
        productRead,
        db
            .select()
            .from(productVariants)
            .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt))),
        loadProductMediaProjections(db, [id]),
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
        readStoreDecimalPlaces(db),
        loadProductOptions(db, [id]),
        loadProductVariantSelectedOptions(db, id),
    ]);
    if (!result) return null;
    return {
        ...presentCatalogPrice(result, decimalPlaces),
        createdAt: requireProductTimestamp(result.createdAt, "created timestamp"),
        updatedAt: requireProductTimestamp(result.updatedAt, "updated timestamp"),
        deletedAt: result.deletedAt
            ? requireProductTimestamp(result.deletedAt, "deleted timestamp")
            : null,
        variants: variants.map((variant) => ({
            ...presentCatalogPrice(variant, decimalPlaces),
            selectedOptions: selectedOptionsByVariant.get(variant.id) ?? [],
        })),
        options: optionsByProduct.get(id) ?? [],
        media: mediaByProduct.get(id) ?? [],
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
            .where(sql`${products.deletedAt} IS NULL AND EXISTS (
                SELECT 1
                FROM product_media AS admin_product_media
                JOIN media AS admin_media ON admin_media.id = admin_product_media.media_id
                LEFT JOIN media AS admin_poster ON admin_poster.id = admin_media.poster_media_id
                WHERE admin_product_media.product_id = ${products.id}
                  AND admin_media.status IN ('ready', 'trashed')
                  AND (
                    admin_media.kind = 'image'
                    OR (
                      admin_media.kind = 'video'
                      AND admin_poster.kind = 'image'
                      AND admin_poster.status IN ('ready', 'trashed')
                    )
                  )
            )`),
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
 * Creates a new product along with ordered media, rich content, and attributes.
 * A typed slug that is already in use is refused; an omitted one is derived
 * from the name and suffixed until it is free.
 * Returns the new product ID on success.
 */
function isProductSlugConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /products(?:_slug_idx|\.slug)/i.test(message);
}

export async function createProduct(
    db: Database,
    data: CreateProductInput,
): Promise<{ id: string; aggregateRevision: number }> {
    if (data.slug) {
        const existingProduct = await db
            .select({ id: products.id })
            .from(products)
            .where(eq(products.slug, data.slug))
            .get();
        if (existingProduct) throw new ConflictError("A product with this slug already exists");
    }

    await assertActiveAttributeAssignments(db, data.attributes ?? []);

    await assertSkusFree(db, data.optionMatrix
        ? data.optionMatrix.variants.map((variant, index) => ({ sku: variant.sku, field: `optionMatrix.variants.${index}.sku` }))
        : data.defaultSku?.sku ? [{ sku: data.defaultSku.sku, field: "defaultSku.sku" }] : []);

    const productId = "prod_" + nanoid();
    const currency = await readStoreCurrency(db);
    const productPrice = catalogPriceColumns(data, currency);
    // With options, the product price is its lowest variant price (productPriceMinorSql).
    const priceMinor = data.optionMatrix?.variants.length
        ? Math.min(...data.optionMatrix.variants.map((variant) => toStoreMinor(variant.price, currency)))
        : toStoreMinor(data.price, currency);
    const baseDefaultVariant = defaultVariantValues(productId, priceMinor);
    const defaultVariant = {
        ...baseDefaultVariant,
        sku: data.optionMatrix ? baseDefaultVariant.sku : data.defaultSku?.sku ?? await readableDefaultSku(db, data.name),
        trackInventory: data.defaultSku?.trackInventory ?? false,
        weight: data.defaultSku?.weight ?? null,
        ...(data.defaultSku?.barcode
            ? resolveNewVariantBarcode(baseDefaultVariant.id, data.defaultSku.barcode, data.defaultSku.barcodeType)
            : {}),
    };
    const mediaPlan = await validateProductMediaPlan(db, productId, data.media, false);

    const productInsert = (slug: string) => db.insert(products).values({
            id: productId,
            name: data.name,
            description: data.description || null,
            priceMinor,
            categoryId: data.categoryId,
            slug,
            metaTitle: data.metaTitle || null,
            metaDescription: data.metaDescription,
            canonicalPath: data.canonicalPath ?? null,
            noIndex: data.noIndex ?? false,
            excludeFromSitemap: data.excludeFromSitemap ?? false,
            excludeFromProductFeed: data.excludeFromProductFeed ?? false,
            productCondition: data.productCondition,
            isActive: data.isActive,
            discountType: data.discountType || "percentage",
            discountBps: (data.discountType || "percentage") === "percentage" ? (productPrice.discountBps ?? 0) : 0,
            discountAmountMinor: (data.discountType || "percentage") === "flat" ? (productPrice.discountAmountMinor ?? 0) : 0,
            freeDelivery: data.freeDelivery,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
            deletedAt: null,
        });
    const batchOps: SQLiteBatchItem[] = [];

    if (!data.optionMatrix) {
        batchOps.push(db.insert(productVariants).values(defaultVariant));
        const initialStock = data.defaultSku?.stock ?? 0;
        if (initialStock > 0) {
            batchOps.push(buildStockMovementClaim(db, {
                movementId: crypto.randomUUID(),
                variantId: defaultVariant.id,
                pool: "regular",
                quantity: initialStock,
                before: { stock: 0, reservedStock: 0, preorderStock: 0, stockVersion: 1 },
                after: { stock: initialStock, reservedStock: 0, preorderStock: 0, stockVersion: 2 },
                notes: "Stocktake: Initial product stock",
            }));
            batchOps.push(db.update(productVariants)
                .set({ stock: initialStock, stockVersion: 2, updatedAt: sql`unixepoch()` })
                .where(and(eq(productVariants.id, defaultVariant.id), eq(productVariants.stockVersion, 1))));
        }
    }

    batchOps.push(...buildProductMediaInsertStatements(db, mediaPlan.newRows));

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
            assertSubmittedSkuImage(matrixVariant.imageId, mediaPlan.rows);
            const barcode = resolveNewVariantBarcode(
                variantId,
                matrixVariant.barcode,
                matrixVariant.barcodeType,
            );
            const variantFields = {
                id: variantId,
                productId,
                optionCombinationKey: selectedOptionValueIds.join("|"),
                imageId: matrixVariant.imageId,
                weight: matrixVariant.weight,
                sku: matrixVariant.sku.trim(),
                priceMinor: toStoreMinor(matrixVariant.price, currency),
                stock: 0,
                reservedStock: 0,
                preorderStock: 0,
                isDefault: false,
                trackInventory: matrixVariant.trackInventory,
                barcode: barcode.barcode,
                barcodeType: barcode.barcodeType,
                discountType: matrixVariant.discountType,
                discountBps: matrixVariant.discountType === "percentage"
                    ? percentToBps(matrixVariant.discountPercentage)
                    : 0,
                discountAmountMinor: matrixVariant.discountType === "flat"
                    ? toStoreMinor(matrixVariant.discountAmount ?? 0, currency)
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
            const initialStock = matrixVariant.stock ?? 0;
            if (initialStock > 0) {
                batchOps.push(buildStockMovementClaim(db, {
                    movementId: crypto.randomUUID(),
                    variantId,
                    pool: "regular",
                    quantity: initialStock,
                    before: { stock: 0, reservedStock: 0, preorderStock: 0, stockVersion: 1 },
                    after: { stock: initialStock, reservedStock: 0, preorderStock: 0, stockVersion: 2 },
                    notes: "Stocktake: Initial product option stock",
                }));
                batchOps.push(db.update(productVariants)
                    .set({ stock: initialStock, stockVersion: 2, updatedAt: sql`unixepoch()` })
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
        const richContentRows = data.additionalInfo.map((item) => ({
                    id: `prc_${nanoid()}`,
                    productId,
                    title: item.title,
                    content: item.content,
                    sortOrder: item.sortOrder,
                }));
        for (let index = 0; index < richContentRows.length; index += PRODUCT_AGGREGATE_INSERT_CHUNK) {
            batchOps.push(db.insert(productRichContent).values(
                richContentRows.slice(index, index + PRODUCT_AGGREGATE_INSERT_CHUNK),
            ));
        }
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
            for (let index = 0; index < attributeValuesToInsert.length; index += PRODUCT_AGGREGATE_INSERT_CHUNK) {
                batchOps.push(db.insert(productAttributeValues).values(
                    attributeValuesToInsert.slice(index, index + PRODUCT_AGGREGATE_INSERT_CHUNK),
                ));
            }
        }
    }

    const insertWithSlug = async (slug: string) => {
        await db.batch([productInsert(slug), ...batchOps]);
    };
    try {
        if (data.slug) await insertWithSlug(data.slug);
        else {
            await insertWithDerivedHandle(
                { db, table: products, column: products.slug, isHandleConflict: isProductSlugConstraintError },
                data.name,
                "product",
                insertWithSlug,
            );
        }
    } catch (error) {
        if (isProductSlugConstraintError(error)) throw new ConflictError("A product with this slug already exists");
        rethrowProductVariantIdentityConstraint(error);
    }
    return { id: productId, aggregateRevision: 1 };
}

/**
 * Updates an existing product, replacing ordered media, rich content, and attributes.
 * Validates that the product exists and the slug is not taken by another product.
 */
export async function updateProduct(
    db: Database,
    id: string,
    data: UpdateProductInput,
): Promise<ProductAggregateRevisionResult> {
    const existingProduct = await db
        .select({ id: products.id, storeCurrencyCode: storeCurrencyCodeSql() })
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

    await assertActiveAttributeAssignments(db, data.attributes ?? []);
    const decimalPlaces = storeDecimalPlacesFromCode(existingProduct.storeCurrencyCode);
    const currency = { code: storeCurrencyFromCode(existingProduct.storeCurrencyCode), decimalPlaces };
    const productPrice = catalogPriceColumns(data, currency);
    const priceMinor = toStoreMinor(data.price, currency);

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
            optionCombinationKey: productVariants.optionCombinationKey,
        })
        .from(productVariants)
        .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt)));
    const mediaPlan = await validateProductMediaPlan(db, id, data.media, true);
    const submittedMediaIds = new Set(mediaPlan.rows.map((row) => row.id));
    const removedAssociationIds = mediaPlan.existingRows
        .map((row) => row.id)
        .filter((associationId) => !submittedMediaIds.has(associationId));
    const clearSkuImageIds = await assertRemovedSkuImagesAcknowledged(
        db,
        id,
        removedAssociationIds,
        data.acknowledgedSkuImageRemovalIds ?? [],
    );

    // Drizzle D1 batch() requires specific tuple types
    const batchOps: unknown[] = [
        buildProductAggregateRevisionGuard(db, id, data.expectedAggregateRevision),
        db.update(products)
            .set({
                name: data.name,
                description: data.description,
                priceMinor: productPriceMinorSql(id, priceMinor),
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
                discountBps: (data.discountType || "percentage") === "percentage" ? (productPrice.discountBps ?? 0) : 0,
                discountAmountMinor: (data.discountType || "percentage") === "flat" ? (productPrice.discountAmountMinor ?? 0) : 0,
                freeDelivery: data.freeDelivery,
                aggregateRevision: sql`${products.aggregateRevision} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(products.id, id))
            .returning({ aggregateRevision: products.aggregateRevision }),
        ...buildProductMediaUpdateStatements(db, id, mediaPlan, clearSkuImageIds),
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.delete(productRichContent).where(eq(productRichContent.productId, id)),
    ];

    if (attributeValuesToInsert.length > 0) {
        for (let index = 0; index < attributeValuesToInsert.length; index += PRODUCT_AGGREGATE_INSERT_CHUNK) {
            batchOps.push(db.insert(productAttributeValues).values(
                attributeValuesToInsert.slice(index, index + PRODUCT_AGGREGATE_INSERT_CHUNK),
            ));
        }
    }

    if (contentToInsert.length > 0) {
        for (let index = 0; index < contentToInsert.length; index += PRODUCT_AGGREGATE_INSERT_CHUNK) {
            batchOps.push(db.insert(productRichContent).values(
                contentToInsert.slice(index, index + PRODUCT_AGGREGATE_INSERT_CHUNK),
            ));
        }
    }

    if (data.isActive && activeVariants.length === 0) {
        batchOps.push(db.insert(productVariants).values(defaultVariantValues(id, priceMinor)));
    } else if (hasInvalidSkuTopology(activeVariants)) {
        throw new ValidationError("Product SKU data is invalid: only one default SKU is allowed, and every non-default SKU must include at least one customer option.");
    }

    if (isSimpleDefaultSkuSet(activeVariants)) {
        batchOps.push(
            db
                .update(productVariants)
                .set({
                    priceMinor,
                    discountType: "percentage",
                    discountBps: 0,
                    discountAmountMinor: 0,
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
 * Replaces only the bounded product-media aggregate while preserving the same
 * association, SKU-image fallback, and aggregate-revision invariants as the
 * full editor command. This is the semantic section command used by bounded
 * API clients; it deliberately does not load or rewrite unrelated product
 * text, attributes, rich content, options, or SKUs.
 */
export async function updateProductMediaSection(
    db: Database,
    productId: string,
    expectedAggregateRevision: number,
    submitted: UpdateProductInput["media"],
    acknowledgedSkuImageRemovalIds: readonly string[] = [],
): Promise<ProductAggregateRevisionResult | null> {
    const product = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, productId))
        .get();
    if (!product) return null;

    const mediaPlan = await validateProductMediaPlan(db, productId, submitted, true);
    const submittedMediaIds = new Set(mediaPlan.rows.map((row) => row.id));
    const removedAssociationIds = mediaPlan.existingRows
        .map((row) => row.id)
        .filter((associationId) => !submittedMediaIds.has(associationId));
    const clearSkuImageIds = await assertRemovedSkuImagesAcknowledged(
        db,
        productId,
        removedAssociationIds,
        acknowledgedSkuImageRemovalIds,
    );
    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        expectedAggregateRevision,
        buildProductMediaUpdateStatements(db, productId, mediaPlan, clearSkuImageIds),
    );
    return { aggregateRevision: result.aggregateRevision };
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
            priceMinor: products.priceMinor,
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
        const { createdAt: _createdAt, ...defaultSkuRepairValues } = defaultVariantValues(id, product.priceMinor);
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
            statements.push(db.insert(productVariants).values(defaultVariantValues(id, product.priceMinor)));
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
    const variantIdSet = JSON.stringify(variantIds);

    const movementCheckArr = await db
        .select({ count: sql<number>`count(*)` })
        .from(inventoryMovements)
        .where(sql`${inventoryMovements.variantId} IN (
            SELECT CAST(value AS TEXT) FROM json_each(${variantIdSet})
        )`);

    if ((movementCheckArr[0]?.count ?? 0) > 0) {
        throw new ConflictError(message);
    }
}

async function assertNoPermanentDeleteReferences(
    db: Database,
    productIds: string[],
    messages: { orders: string; inventory: string },
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

    const variantIds = await loadProductVariantIds(db, productIds);
    await assertNoVariantInventoryHistory(db, variantIds, messages.inventory);
    return variantIds;
}

function buildPermanentDeleteReferenceGuard(
    db: Database,
    productIds: string[],
): SQLiteBatchItem {
    const idSet = JSON.stringify(productIds);
    const guardedMovementVariantId = sql`${sql.identifier("inventory_movements")}.${sql.identifier("variant_id")}`;
    const guardedVariantId = sql`${sql.identifier("product_variants")}.${sql.identifier("id")}`;
    const guardedVariantProductId = sql`${sql.identifier("product_variants")}.${sql.identifier("product_id")}`;
    return buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM ${orderItems}
            WHERE ${orderItems.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${idSet})
            )
        ) AND NOT EXISTS (
            SELECT 1 FROM ${inventoryMovements}
            INNER JOIN ${productVariants}
                ON ${guardedMovementVariantId} = ${guardedVariantId}
            WHERE ${guardedVariantProductId} IN (
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
        )`, "PRODUCT_HARD_DELETE_CONFLICT");
}

function deleteLowStockAlertsForProductBatch(
    db: Database,
    productIds: string[],
    variantIds: string[],
): SQLiteBatchItem {
    const productIdSet = JSON.stringify(productIds);
    const variantIdSet = JSON.stringify(variantIds);

    return db
        .delete(productLowStockAlerts)
        .where(sql`
            ${productLowStockAlerts.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
            )
            ${variantIds.length > 0 ? sql`OR ${productLowStockAlerts.variantId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${variantIdSet})
            )` : sql``}
        `);
}

export function buildPermanentProductDeleteBatch(
    db: Database,
    id: string,
    expectedAggregateRevision: number,
    variantIds: string[],
): SQLiteBatchItem[] {
    return [
        buildProductAggregateRevisionGuard(db, id, expectedAggregateRevision, "trashed"),
        buildPermanentDeleteReferenceGuard(db, [id]),
        deleteLowStockAlertsForProductBatch(db, [id], variantIds),
        db.delete(productVariants).where(eq(productVariants.productId, id)),
        db.delete(productMedia).where(eq(productMedia.productId, id)),
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.delete(productRichContent).where(eq(productRichContent.productId, id)),
        db.delete(products).where(eq(products.id, id)),
    ];
}

/**
 * Permanently deletes a product and all of its related data (variants, media associations, attributes, rich content).
 * Throws an error if the product is linked to any existing orders or discounts.
 */
export async function permanentlyDeleteProduct(
    db: Database,
    id: string,
    expectedAggregateRevision: number,
): Promise<void> {
    const referenceMessages = {
        orders: "Cannot delete product. It is part of one or more existing orders.",
        inventory:
            "Cannot permanently delete product. One or more SKUs have inventory history; move the product to trash instead.",
    };
    const variantIds = await assertNoPermanentDeleteReferences(
        db,
        [id],
        referenceMessages,
    );

    try {
        await safeBatch(db, buildPermanentProductDeleteBatch(
            db,
            id,
            expectedAggregateRevision,
            variantIds,
        ));
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

export type ProductBulkDeleteOutcome = {
    id: string;
    status: "trashed" | "deleted" | "blocked" | "failed";
    code: string | null;
    message: string | null;
};

export type BulkDeleteProductsResult = {
    revisions: ProductAggregateRevisionResult[];
    outcomes: ProductBulkDeleteOutcome[];
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
): Promise<BulkDeleteProductsResult> {
    if (productClaims.length === 0) throw new ValidationError("No product IDs provided");
    const productIds = productClaims.map((claim) => claim.id);
    if (new Set(productIds).size !== productIds.length) {
        throw new ValidationError("Each product may appear only once in a bulk delete.");
    }

    if (permanent) {
        const outcomes: ProductBulkDeleteOutcome[] = [];
        // Keep every product's guard and destructive writes in its own D1 batch.
        // One blocked or malformed demo row must not roll back unrelated products,
        // and sequential execution stays below the six-connection Worker limit.
        for (const claim of productClaims) {
            try {
                await permanentlyDeleteProduct(
                    db,
                    claim.id,
                    claim.expectedAggregateRevision,
                );
                outcomes.push({
                    id: claim.id,
                    status: "deleted",
                    code: null,
                    message: null,
                });
            } catch (error) {
                if (error instanceof AppError) {
                    outcomes.push({
                        id: claim.id,
                        status: "blocked",
                        code: error.code,
                        message: error.message,
                    });
                } else {
                    console.error("[Products] Permanent delete failed unexpectedly", {
                        productIdPrefix: claim.id.slice(0, 16),
                        errorName: error instanceof Error ? error.name : "UnknownError",
                        errorMessage: error instanceof Error
                            ? error.message
                            : String(error),
                    });
                    outcomes.push({
                        id: claim.id,
                        status: "failed",
                        code: "PRODUCT_PERMANENT_DELETE_FAILED",
                        message:
                            "This product could not be permanently deleted. Retry it individually; if it still fails, keep it in trash and contact support.",
                    });
                }
            }
        }
        return { revisions: [], outcomes };
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
            const revisions = productClaims.map((_, index) =>
                readProductAggregateRevisionResult(results[index * 2 + 1])
            );
            return {
                revisions,
                outcomes: productClaims.map((claim) => ({
                    id: claim.id,
                    status: "trashed" as const,
                    code: null,
                    message: null,
                })),
            };
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

export type ProductBulkChanges = { isActive?: boolean; categoryId?: string };

export type ProductBulkUpdateResult = {
    products: Array<{ id: string; aggregateRevision: number }>;
    /** Left unchanged, with why (activating needs a price above 0). */
    skipped: Array<{ id: string; name: string; reason: "needs_price" }>;
};

/**
 * Sets status and/or category on up to 90 products in one batch. Every applied
 * claim is revision-guarded, so those change together or not at all. Activating
 * skips (and reports) products without a positive price on the product and
 * every live SKU; the others still change.
 */
export async function bulkUpdateProducts(
    db: Database,
    claims: ProductAggregateRevisionClaim[],
    changes: ProductBulkChanges,
): Promise<ProductBulkUpdateResult> {
    const ids = claims.map((claim) => claim.id);
    if (ids.length === 0) throw new ValidationError("No product IDs provided");
    if (new Set(ids).size !== ids.length) {
        throw new ValidationError("Each product may appear only once in a bulk change.");
    }
    if (changes.isActive === undefined && changes.categoryId === undefined) {
        throw new ValidationError("Choose what to change.");
    }
    if (changes.categoryId !== undefined) {
        const category = await db
            .select({ id: categories.id })
            .from(categories)
            .where(and(eq(categories.id, changes.categoryId), isNull(categories.deletedAt)))
            .get();
        if (!category) throw new ValidationError("That category no longer exists.", { field: "categoryId" });
    }
    // Activating skips products (or variants) without a price above 0; the rest still change.
    const skipped = changes.isActive
        ? await db
            .select({ id: products.id, name: products.name })
            .from(products)
            .where(and(
                inArray(products.id, ids),
                or(
                    sql`${products.priceMinor} <= 0`,
                    sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariants.deletedAt} IS NULL AND ${productVariants.priceMinor} <= 0)`,
                ),
            ))
        : [];
    const skippedIds = new Set(skipped.map((row) => row.id));
    const applied = claims.filter((claim) => !skippedIds.has(claim.id));
    const skippedRows = skipped.map((row) => ({ ...row, reason: "needs_price" as const }));
    if (applied.length === 0) return { products: [], skipped: skippedRows };
    const statements = applied.flatMap((claim) => [
        buildProductAggregateRevisionGuard(db, claim.id, claim.expectedAggregateRevision),
        db
            .update(products)
            .set({
                ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
                ...(changes.categoryId !== undefined ? { categoryId: changes.categoryId } : {}),
                aggregateRevision: sql`${products.aggregateRevision} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(eq(products.id, claim.id), isNull(products.deletedAt)))
            .returning({ aggregateRevision: products.aggregateRevision }),
    ]);
    try {
        const results = await safeBatch(db, statements as never) as unknown[];
        return {
            products: applied.map((claim, index) => ({
                id: claim.id,
                aggregateRevision: readProductAggregateRevisionResult(results[index * 2 + 1]).aggregateRevision,
            })),
            skipped: skippedRows,
        };
    } catch (error) {
        if (isProductAggregateRevisionConflict(error)) {
            const staleClaim = await findStaleProductAggregateRevisionClaim(db, applied, "active");
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

/** `${base}${suffix}` values that no SKU uses yet: BASE-COPY, then BASE-COPY-2 … */
async function freeCopySkus(db: Database, skus: string[]): Promise<string[]> {
    const stems = skus.map((sku) => `${sku.trim().slice(0, 90)}-COPY`);
    const taken = new Set<string>();
    for (let index = 0; index < stems.length; index += 40) {
        const chunk = stems.slice(index, index + 40);
        const rows = await db
            .select({ sku: productVariants.sku })
            .from(productVariants)
            .where(or(...chunk.map((stem) => sql`lower(trim(${productVariants.sku})) = ${stem.toLowerCase()} OR lower(trim(${productVariants.sku})) LIKE ${`${stem.toLowerCase()}-%`}`)));
        rows.forEach((row) => taken.add(row.sku.trim().toLowerCase()));
    }
    return stems.map((stem) => {
        let candidate = stem;
        for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) candidate = `${stem}-${suffix}`;
        taken.add(candidate.toLowerCase());
        return candidate;
    });
}

/**
 * Copies a product as a new draft: text, pricing, media, attributes, extra
 * sections and its options with every live variant. Copies start with no
 * stock, new SKUs (…-COPY) and fresh generated barcodes, because stock,
 * SKU and barcode identities belong to one sellable item only.
 */
export async function duplicateProduct(
    db: Database,
    id: string,
    name: string,
): Promise<{ id: string; aggregateRevision: number }> {
    const source = await getProductDetails(db, id);
    if (!source || source.deletedAt) throw new NotFoundError("Product not found");

    let slug = `${source.slug.slice(0, 90)}-copy`;
    const slugRows = await db
        .select({ slug: products.slug })
        .from(products)
        .where(sql`${products.slug} = ${slug} OR ${products.slug} LIKE ${`${slug}-%`}`);
    const slugs = new Set(slugRows.map((row) => row.slug));
    for (let suffix = 2; slugs.has(slug); suffix += 1) slug = `${source.slug.slice(0, 90)}-copy-${suffix}`;

    const readyMedia = source.media.filter((item) => item.status === "ready");
    const mediaIdMap = new Map(readyMedia.map((item) => [item.id, `pmed_${nanoid()}`]));
    const media = readyMedia.map((item, index) => ({
        id: mediaIdMap.get(item.id)!,
        mediaId: item.mediaId,
        altText: item.contextualAltText ?? null,
        isPrimary: readyMedia.some((entry) => entry.isPrimary) ? item.isPrimary : index === 0,
    }));
    const liveVariants = source.variants.filter((variant) => !variant.deletedAt);
    const optionVariants = liveVariants.filter((variant) => !variant.isDefault);
    const skus = await freeCopySkus(db, liveVariants.map((variant) => variant.sku));
    const skuOf = new Map(liveVariants.map((variant, index) => [variant.id, skus[index]!]));

    const input = createProductSchema.parse({
        name: name.trim().slice(0, 100),
        description: source.description,
        price: source.price,
        categoryId: source.categoryId,
        isActive: false,
        discountType: source.discountType === "flat" ? "flat" : "percentage",
        discountPercentage: source.discountPercentage,
        discountAmount: source.discountAmount,
        freeDelivery: source.freeDelivery,
        metaTitle: source.metaTitle,
        metaDescription: source.metaDescription,
        canonicalPath: null,
        noIndex: source.noIndex,
        excludeFromSitemap: source.excludeFromSitemap,
        excludeFromProductFeed: source.excludeFromProductFeed,
        productCondition: source.productCondition ?? DEFAULT_PRODUCT_CONDITION,
        slug,
        media,
        attributes: source.attributes,
        additionalInfo: source.additionalInfo.map((item) => ({ ...item, id: `prc_${nanoid()}` })),
        ...(source.options.length > 0 && optionVariants.length > 0
            ? {
                optionMatrix: {
                    options: source.options.map((option) => ({
                        id: option.id,
                        name: option.name,
                        standardMapping: option.standardMapping,
                        values: option.values.map((value) => ({ id: value.id, value: value.value })),
                    })),
                    variants: optionVariants.map((variant) => ({
                        id: variant.id,
                        selectedOptionValueIds: [...variant.selectedOptions]
                            .sort((a, b) => a.position - b.position)
                            .map((option) => option.optionValueId),
                        imageId: variant.imageId ? mediaIdMap.get(variant.imageId) ?? null : null,
                        sku: skuOf.get(variant.id)!,
                        price: variant.price,
                        stock: 0,
                        trackInventory: variant.trackInventory,
                        weight: variant.weight,
                        barcode: null,
                        barcodeType: null,
                        discountType: variant.discountType === "flat" ? "flat" : "percentage",
                        discountPercentage: variant.discountType === "flat" ? null : variant.discountPercentage,
                        discountAmount: variant.discountType === "flat" ? variant.discountAmount : null,
                    })),
                },
            }
            : {
                defaultSku: {
                    sku: liveVariants[0] ? skuOf.get(liveVariants[0].id) : undefined,
                    trackInventory: liveVariants[0]?.trackInventory ?? false,
                    stock: 0,
                    weight: liveVariants[0]?.weight ?? null,
                },
            }),
    });
    return createProduct(db, input);
}
