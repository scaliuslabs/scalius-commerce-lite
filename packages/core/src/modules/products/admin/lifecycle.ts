// Product trash, restore, permanent delete and bulk status changes.
import {
    products,
    categories,
    productVariants,
    productMedia,
    productRichContent,
    productAttributeValues,
    orderItems,
    inventoryMovements,
    productLowStockAlerts,
} from "@scalius/database/schema";
import { and, sql, eq, inArray, isNull, or } from "drizzle-orm";
import { AppError, NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import {
    buildProductAggregateRevisionGuard,
    isProductAggregateRevisionConflict,
    readProductAggregateRevisionResult,
    rethrowProductAggregateRevisionConflictIfStale,
    type ProductAggregateRevisionResult,
} from "../aggregate-revision";
import { type SQLiteBatchItem, defaultVariantValues } from "./write";
import { catalogProjectionRefreshStatements } from "../catalog-projections";

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
            ...catalogProjectionRefreshStatements(db, [id]),
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

    statements.push(...catalogProjectionRefreshStatements(db, [id]));

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
        statements.push(...catalogProjectionRefreshStatements(db, productIds));
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
    statements.push(...catalogProjectionRefreshStatements(db, applied.map((claim) => claim.id)));
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
