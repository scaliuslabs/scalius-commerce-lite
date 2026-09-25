// src/modules/attributes/projection-refresh.ts
// The attributes domain rewrites `product_attribute_values`, which feed the
// catalogue projections (`product_facet_values`, `product_buyer_state`) owned
// by the products domain. The attributes domain does not import products, so
// the caller injects the refresh: the API passes
// `(ids) => catalogProjectionRefreshStatements(db, ids)`.
//
// Every write here that changes product value rows (or their facet key or
// label) runs in chunks of at most 90 products: one D1 batch per chunk with
// the row writes, the products' aggregate revision bump and then the refresh
// for exactly those products, so a chunk commits with its projection or not
// at all and every statement stays within 90 bound parameters.
import { products, productAttributeValues } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, gt, sql, type SQL } from "drizzle-orm";

export type AttributeBatchItem = BatchItem<"sqlite">;

/** Statements that refresh the catalogue projections of these products (<= 90 per group); the API passes catalogProjectionRefreshStatements. */
export type CatalogProjectionRefresh = (productIds: readonly string[]) => BatchItem<"sqlite">[];

/** Products per write batch: the D1 enrichment bound. */
export const ATTRIBUTE_WRITE_PRODUCTS_PER_BATCH = 90;

/** One bound JSON parameter naming a set of ids. */
export function jsonIdSet(ids: readonly string[]): SQL {
    return sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
}

export function chunked<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
    return out;
}

/** Bumps the aggregate revision of these products (their attribute values changed). */
export function productRevisionBumpStatement(db: Database, productIds: readonly string[]): AttributeBatchItem {
    return db.update(products)
        .set({
            aggregateRevision: sql`${products.aggregateRevision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(sql`${products.id} IN ${jsonIdSet(productIds)}`);
}

/**
 * Walks the products whose value rows of one attribute match `condition`, in
 * product-id order, 90 at a time, running one batch per chunk from `write`.
 * Returns how many products were written.
 */
export async function forEachAttributeProductChunk(
    db: Database,
    condition: SQL,
    write: (productIds: string[]) => AttributeBatchItem[],
): Promise<number> {
    let after: string | null = null;
    let written = 0;
    for (;;) {
        const rows: Array<{ productId: string }> = await db
            .selectDistinct({ productId: productAttributeValues.productId })
            .from(productAttributeValues)
            .where(and(condition, after === null ? undefined : gt(productAttributeValues.productId, after)))
            .orderBy(asc(productAttributeValues.productId))
            .limit(ATTRIBUTE_WRITE_PRODUCTS_PER_BATCH)
            .all();
        if (rows.length === 0) return written;
        const ids = rows.map((row) => row.productId);
        const statements = write(ids);
        if (statements.length > 0) await safeBatch(db, statements as never);
        written += ids.length;
        after = ids[ids.length - 1]!;
        if (rows.length < ATTRIBUTE_WRITE_PRODUCTS_PER_BATCH) return written;
    }
}
