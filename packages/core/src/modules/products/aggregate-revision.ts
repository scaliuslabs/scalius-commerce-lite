import { products, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
} from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { eq, sql, type SQL } from "drizzle-orm";
import { AppError, ConflictError } from "@scalius/core/errors";
import { catalogProjectionRefreshStatements } from "./catalog-projections";
import { buildGiftCardProductRulesGuard, rethrowGiftCardProductRuleViolation } from "./gift-card-rules";

export const PRODUCT_AGGREGATE_REVISION_CONFLICT =
    "PRODUCT_AGGREGATE_REVISION_CONFLICT";

export type ProductAggregateRevisionResult = {
    aggregateRevision: number;
};

export type ProductAggregateLifecycle = "active" | "trashed";

export class ProductRevisionConflictError extends AppError {
    constructor(expectedRevision: number, currentRevision: number | null) {
        super(
            409,
            "PRODUCT_REVISION_CONFLICT",
            "This product changed while you were editing. Reload the latest product and try again.",
            { expectedRevision, currentRevision },
        );
        this.name = "ProductRevisionConflictError";
    }
}

export class ProductStateConflictError extends AppError {
    constructor(requiredState: ProductAggregateLifecycle) {
        super(
            409,
            "PRODUCT_STATE_CONFLICT",
            requiredState === "active"
                ? "This product is no longer active. Return to products and reload."
                : "This product is not in trash. Return to products and reload.",
            { requiredState },
        );
        this.name = "ProductStateConflictError";
    }
}

/**
 * A zero-row UPDATE does not make an atomic batch fail. This guard deliberately
 * raises the provider-neutral batch-guard error when the expected revision is
 * stale, so every later statement in the same batch is rolled back atomically.
 */
export function buildProductAggregateRevisionGuard(
    db: Database,
    productId: string,
    expectedAggregateRevision: number,
    requiredState: ProductAggregateLifecycle = "active",
): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${products}
            WHERE ${products.id} = ${productId}
              AND ${products.aggregateRevision} = ${expectedAggregateRevision}
              AND ${requiredState === "active"
                ? sql`${products.deletedAt} IS NULL`
                : sql`${products.deletedAt} IS NOT NULL`}
        )`, PRODUCT_AGGREGATE_REVISION_CONFLICT);
}

/**
 * A product with options sells only its option SKUs, so its product-level
 * price is not the merchant's to edit: the server keeps it equal to the lowest
 * active option SKU price. A product without options keeps `fallback` (the
 * merchant's price, mirrored onto its hidden default SKU).
 */
export function productPriceMinorSql(productId: string, fallback: SQL | number): SQL<number> {
    return sql<number>`COALESCE((
        SELECT MIN(${productVariants.priceMinor}) FROM ${productVariants}
        WHERE ${productVariants.productId} = ${productId}
          AND ${productVariants.deletedAt} IS NULL
          AND ${productVariants.isDefault} = 0
          AND trim(coalesce(${productVariants.optionCombinationKey}, '')) <> ''
    ), ${fallback})`;
}

/**
 * Must be included exactly once in the guarded aggregate mutation batch. It
 * runs after the batch's SKU writes, so it also re-derives an optioned
 * product's price from the SKUs those writes left.
 */
export function buildProductAggregateRevisionBump(
    db: Database,
    productId: string,
): BatchItem<"sqlite"> {
    return db
        .update(products)
        .set({
            aggregateRevision: sql`${products.aggregateRevision} + 1`,
            priceMinor: productPriceMinorSql(productId, sql`${products.priceMinor}`),
            updatedAt: sql`unixepoch()`,
        })
        .where(sql`${products.id} = ${productId}`)
        .returning({ aggregateRevision: products.aggregateRevision });
}

export function isProductAggregateRevisionConflict(error: unknown): boolean {
    return isBatchGuardError(error, PRODUCT_AGGREGATE_REVISION_CONFLICT);
}

/**
 * Translates only a genuinely stale aggregate guard. Other malformed-JSON
 * sentinels (for example a SKU stock-version guard) retain their own error.
 */
export async function rethrowProductAggregateRevisionConflictIfStale(
    db: Database,
    productId: string,
    expectedRevision: number,
    error: unknown,
    requiredState: ProductAggregateLifecycle = "active",
): Promise<never> {
    if (isProductAggregateRevisionConflict(error)) {
        const current = await db
            .select({
                aggregateRevision: products.aggregateRevision,
                deletedAt: products.deletedAt,
            })
            .from(products)
            .where(eq(products.id, productId))
            .get();
        if (current?.aggregateRevision !== expectedRevision) {
            throw new ProductRevisionConflictError(
                expectedRevision,
                current?.aggregateRevision ?? null,
            );
        }
        const stateMatches = requiredState === "active"
            ? current.deletedAt === null
            : current.deletedAt !== null;
        if (!stateMatches) throw new ProductStateConflictError(requiredState);
    }
    throw error;
}

export function readProductAggregateRevisionResult(
    rows: unknown,
): ProductAggregateRevisionResult {
    const result = Array.isArray(rows) ? rows[0] : undefined;
    if (
        !result
        || typeof result !== "object"
        || typeof (result as { aggregateRevision?: unknown }).aggregateRevision !== "number"
    ) {
        throw new ConflictError(
            "The product change could not be confirmed. Reload the latest product and try again.",
        );
    }
    return result as ProductAggregateRevisionResult;
}

export async function executeProductAggregateMutationBatch(
    db: Database,
    productId: string,
    expectedAggregateRevision: number,
    mutationStatements: BatchItem<"sqlite">[],
    requiredState: ProductAggregateLifecycle = "active",
): Promise<{
    mutationResults: unknown[];
    aggregateRevision: number;
}> {
    try {
        const results = await safeBatch(db, [
            buildProductAggregateRevisionGuard(
                db,
                productId,
                expectedAggregateRevision,
                requiredState,
            ),
            ...mutationStatements,
            buildProductAggregateRevisionBump(db, productId),
            // Every aggregate write path keeps a gift card digital, untracked and undiscounted.
            buildGiftCardProductRulesGuard(db, productId),
            // The catalogue projections read this batch's own writes.
            ...catalogProjectionRefreshStatements(db, [productId]),
        ] as never) as unknown[];
        const revision = readProductAggregateRevisionResult(results[1 + mutationStatements.length]);
        return {
            mutationResults: results.slice(1, 1 + mutationStatements.length),
            aggregateRevision: revision.aggregateRevision,
        };
    } catch (error) {
        rethrowGiftCardProductRuleViolation(error);
        return rethrowProductAggregateRevisionConflictIfStale(
            db,
            productId,
            expectedAggregateRevision,
            error,
            requiredState,
        );
    }
}
