import type { Database } from "@scalius/database/client";
import { buildBatchGuard, safeBatch } from "@scalius/database/client";
import { discounts } from "@scalius/database/schema";
import { AppError, ConflictError } from "@scalius/core/errors";
import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

export const DISCOUNT_REVISION_CONFLICT = "DISCOUNT_REVISION_CONFLICT";

export class DiscountRevisionConflictError extends AppError {
    constructor(
        discountId: string,
        expectedRevision: number,
        currentRevision: number | null,
    ) {
        super(
            409,
            DISCOUNT_REVISION_CONFLICT,
            "This discount changed while you were editing. Reload the latest rule and try again.",
            { discountId, expectedRevision, currentRevision },
        );
        this.name = "DiscountRevisionConflictError";
    }
}

export class DiscountStateConflictError extends AppError {
    constructor(discountId: string) {
        super(
            409,
            "DISCOUNT_STATE_CONFLICT",
            "This discount is no longer active. Return to discounts and reload.",
            { discountId },
        );
        this.name = "DiscountStateConflictError";
    }
}

export function buildDiscountRevisionGuard(
    db: Database,
    discountId: string,
    expectedRevision: number,
): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`
        CASE WHEN EXISTS (
            SELECT 1 FROM ${discounts}
            WHERE ${discounts.id} = ${discountId}
              AND ${discounts.revision} = ${expectedRevision}
              AND ${discounts.deletedAt} IS NULL
        ) THEN 1 ELSE json_extract(${DISCOUNT_REVISION_CONFLICT}, '$') END
    `);
}

function buildDiscountRevisionBump(
    db: Database,
    discountId: string,
): BatchItem<"sqlite"> {
    return db
        .update(discounts)
        .set({
            revision: sql`${discounts.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(discounts.id, discountId))
        .returning({ revision: discounts.revision });
}

function isDiscountRevisionGuardError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /DISCOUNT_REVISION_CONFLICT|malformed json/i.test(message);
}

async function rethrowDiscountRevisionConflictIfStale(
    db: Database,
    discountId: string,
    expectedRevision: number,
    error: unknown,
): Promise<never> {
    if (isDiscountRevisionGuardError(error)) {
        const current = await db
            .select({
                revision: discounts.revision,
                deletedAt: discounts.deletedAt,
            })
            .from(discounts)
            .where(eq(discounts.id, discountId))
            .get();
        if (current?.revision !== expectedRevision) {
            throw new DiscountRevisionConflictError(
                discountId,
                expectedRevision,
                current?.revision ?? null,
            );
        }
        if (current.deletedAt !== null) {
            throw new DiscountStateConflictError(discountId);
        }
    }
    throw error;
}

function readRevisionResult(rows: unknown): number {
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const revision = row && typeof row === "object"
        ? (row as { revision?: unknown }).revision
        : undefined;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
        throw new ConflictError(
            "The discount change could not be confirmed. Reload the latest rule and try again.",
        );
    }
    return revision;
}

export async function executeDiscountRuleMutationBatch(
    db: Database,
    discountId: string,
    expectedRevision: number,
    mutationStatements: BatchItem<"sqlite">[],
): Promise<{ mutationResults: unknown[]; revision: number }> {
    try {
        const results = await safeBatch(db, [
            buildDiscountRevisionGuard(db, discountId, expectedRevision),
            ...mutationStatements,
            buildDiscountRevisionBump(db, discountId),
        ] as never) as unknown[];
        return {
            mutationResults: results.slice(1, -1),
            revision: readRevisionResult(results.at(-1)),
        };
    } catch (error) {
        return rethrowDiscountRevisionConflictIfStale(
            db,
            discountId,
            expectedRevision,
            error,
        );
    }
}
