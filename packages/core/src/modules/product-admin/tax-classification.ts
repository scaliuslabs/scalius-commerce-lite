// src/modules/product-admin/tax-classification.ts
// The tax class a product or SKU carries: the dashboard's classification list
// and the guarded change, committed under the product aggregate revision.

import { buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import { productVariants, products, taxClasses } from "@scalius/database/schema";
import { ConflictError } from "@scalius/core/errors";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { containsText } from "../../utils/text-match";
import { assertActiveTaxClass } from "../tax";
import { variantOptionLabelSql } from "../products";
import { executeProductAggregateMutationBatch } from "./aggregate-revision";

export type TaxClassificationKind = "product" | "variant";

export async function listTaxClassifications(db: Database, input: {
    kind: TaxClassificationKind;
    page: number;
    limit: number;
    search?: string;
}) {
    const offset = (input.page - 1) * input.limit;
    const search = input.search?.trim();
    if (input.kind === "product") {
        const where = and(
            isNull(products.deletedAt),
            search ? or(containsText(products.name, search), containsText(products.slug, search)) : undefined,
        );
        const [rows, totalRow] = await Promise.all([
            db.select({
                id: products.id,
                productId: products.id,
                productName: products.name,
                label: products.name,
                sku: sql<string | null>`NULL`,
                taxClassId: products.taxClassId,
                taxClassName: taxClasses.name,
                version: products.taxClassificationVersion,
                aggregateRevision: products.aggregateRevision,
            }).from(products).leftJoin(taxClasses, eq(products.taxClassId, taxClasses.id))
                .where(where).orderBy(desc(products.updatedAt), asc(products.id)).limit(input.limit).offset(offset),
            db.select({ count: sql<number>`count(*)` }).from(products).where(where).get(),
        ]);
        return { items: rows.map((row) => ({ ...row, kind: "product" as const })), total: totalRow?.count ?? 0 };
    }

    const where = and(
        isNull(productVariants.deletedAt),
        isNull(products.deletedAt),
        search ? or(
            containsText(products.name, search),
            containsText(productVariants.sku, search),
            containsText(variantOptionLabelSql(productVariants.id), search),
        ) : undefined,
    );
    const [rows, totalRow] = await Promise.all([
        db.select({
            id: productVariants.id,
            productId: products.id,
            productName: products.name,
            label: sql<string>`trim(${products.name} || CASE WHEN ${variantOptionLabelSql(productVariants.id)} <> '' THEN ' · ' || ${variantOptionLabelSql(productVariants.id)} ELSE '' END)`,
            sku: productVariants.sku,
            taxClassId: productVariants.taxClassId,
            taxClassName: taxClasses.name,
            version: productVariants.taxClassificationVersion,
            aggregateRevision: products.aggregateRevision,
        }).from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
            .leftJoin(taxClasses, eq(productVariants.taxClassId, taxClasses.id))
            .where(where).orderBy(desc(productVariants.updatedAt), asc(productVariants.id)).limit(input.limit).offset(offset),
        db.select({ count: sql<number>`count(*)` }).from(productVariants)
            .innerJoin(products, eq(productVariants.productId, products.id)).where(where).get(),
    ]);
    return { items: rows.map((row) => ({ ...row, kind: "variant" as const })), total: totalRow?.count ?? 0 };
}

export async function updateTaxClassification(db: Database, input: {
    kind: TaxClassificationKind;
    id: string;
    taxClassId: string | null;
    expectedVersion: number;
    expectedAggregateRevision: number;
}) {
    await assertActiveTaxClass(db, input.taxClassId, "Tax class");
    if (input.kind === "product") {
        const classificationGuard = buildBatchGuard(db, sql`EXISTS (
                SELECT 1 FROM ${products}
                WHERE ${products.id} = ${input.id}
                  AND ${products.taxClassificationVersion} = ${input.expectedVersion}
                  AND ${products.deletedAt} IS NULL
            )`, "tax_classification_conflict");
        const update = db.update(products).set({
            taxClassId: input.taxClassId,
            taxClassificationVersion: sql`${products.taxClassificationVersion} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(products.id, input.id),
            isNull(products.deletedAt),
        )).returning({ id: products.id, taxClassId: products.taxClassId, version: products.taxClassificationVersion });
        try {
            const result = await executeProductAggregateMutationBatch(
                db,
                input.id,
                input.expectedAggregateRevision,
                [classificationGuard, update],
            );
            const row = (result.mutationResults[1] as Array<{
                id: string;
                taxClassId: string | null;
                version: number;
            }> | undefined)?.[0];
            if (row) {
                return {
                    ...row,
                    kind: input.kind,
                    aggregateRevision: result.aggregateRevision,
                };
            }
        } catch (error) {
            if (isBatchGuardError(error, "tax_classification_conflict")) {
                throw new ConflictError("Tax classification changed or the catalog item is unavailable. Reload and try again.");
            }
            throw error;
        }
    } else {
        const variant = await db
            .select({ productId: productVariants.productId })
            .from(productVariants)
            .where(and(eq(productVariants.id, input.id), isNull(productVariants.deletedAt)))
            .get();
        if (!variant) {
            throw new ConflictError("Tax classification changed or the catalog item is unavailable. Reload and try again.");
        }
        const classificationGuard = buildBatchGuard(db, sql`EXISTS (
                SELECT 1 FROM ${productVariants}
                WHERE ${productVariants.id} = ${input.id}
                  AND ${productVariants.productId} = ${variant.productId}
                  AND ${productVariants.taxClassificationVersion} = ${input.expectedVersion}
                  AND ${productVariants.deletedAt} IS NULL
            )`, "tax_classification_conflict");
        const update = db.update(productVariants).set({
            taxClassId: input.taxClassId,
            taxClassificationVersion: sql`${productVariants.taxClassificationVersion} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(productVariants.id, input.id),
            isNull(productVariants.deletedAt),
        )).returning({ id: productVariants.id, taxClassId: productVariants.taxClassId, version: productVariants.taxClassificationVersion });
        try {
            const result = await executeProductAggregateMutationBatch(
                db,
                variant.productId,
                input.expectedAggregateRevision,
                [classificationGuard, update],
            );
            const row = (result.mutationResults[1] as Array<{
                id: string;
                taxClassId: string | null;
                version: number;
            }> | undefined)?.[0];
            if (row) {
                return {
                    ...row,
                    kind: input.kind,
                    aggregateRevision: result.aggregateRevision,
                };
            }
        } catch (error) {
            if (isBatchGuardError(error, "tax_classification_conflict")) {
                throw new ConflictError("Tax classification changed or the catalog item is unavailable. Reload and try again.");
            }
            throw error;
        }
    }
    throw new ConflictError("Tax classification changed or the catalog item is unavailable. Reload and try again.");
}
