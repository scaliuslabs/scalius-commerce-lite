import { products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { eq, sql } from "drizzle-orm";
import { AppError, ConflictError } from "@scalius/core/errors";

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
 * A zero-row UPDATE does not make D1 batch() fail. This guard deliberately
 * raises a SQLite JSON error when the expected revision is stale, so every
 * later statement in the same batch is rolled back atomically.
 */
export function buildProductAggregateRevisionGuard(
    db: Database,
    productId: string,
    expectedAggregateRevision: number,
    requiredState: ProductAggregateLifecycle = "active",
): BatchItem<"sqlite"> {
    return db.run(sql`
        SELECT CASE WHEN EXISTS (
            SELECT 1 FROM ${products}
            WHERE ${products.id} = ${productId}
              AND ${products.aggregateRevision} = ${expectedAggregateRevision}
              AND ${requiredState === "active"
                ? sql`${products.deletedAt} IS NULL`
                : sql`${products.deletedAt} IS NOT NULL`}
        ) THEN 1 ELSE json_extract(${PRODUCT_AGGREGATE_REVISION_CONFLICT}, '$') END
    `);
}

/** Must be included exactly once in the guarded aggregate mutation batch. */
export function buildProductAggregateRevisionBump(
    db: Database,
    productId: string,
): BatchItem<"sqlite"> {
    return db
        .update(products)
        .set({
            aggregateRevision: sql`${products.aggregateRevision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(sql`${products.id} = ${productId}`)
        .returning({ aggregateRevision: products.aggregateRevision });
}

export function isProductAggregateRevisionConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /PRODUCT_AGGREGATE_REVISION_CONFLICT|malformed json/i.test(message);
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
        ] as never) as unknown[];
        const revision = readProductAggregateRevisionResult(results.at(-1));
        return {
            mutationResults: results.slice(1, -1),
            aggregateRevision: revision.aggregateRevision,
        };
    } catch (error) {
        return rethrowProductAggregateRevisionConflictIfStale(
            db,
            productId,
            expectedAggregateRevision,
            error,
            requiredState,
        );
    }
}
