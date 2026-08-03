import type { Database } from "@scalius/database/client";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
} from "@scalius/database/client";
import { promotions } from "@scalius/database/schema";
import { AppError, ConflictError } from "@scalius/core/errors";
import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

export const PROMOTION_REVISION_CONFLICT = "PROMOTION_REVISION_CONFLICT";

export class PromotionRevisionConflictError extends AppError {
    constructor(
        promotionId: string,
        expectedRevision: number,
        currentRevision: number | null,
    ) {
        super(
            409,
            PROMOTION_REVISION_CONFLICT,
            "This promotion changed while you were editing. Reload the latest rule and try again.",
            { promotionId, expectedRevision, currentRevision },
        );
        this.name = "PromotionRevisionConflictError";
    }
}

export class PromotionStateConflictError extends AppError {
    constructor(promotionId: string) {
        super(
            409,
            "PROMOTION_STATE_CONFLICT",
            "This promotion is no longer editable. Return to promotions and reload.",
            { promotionId },
        );
        this.name = "PromotionStateConflictError";
    }
}

export function buildPromotionRevisionGuard(
    db: Database,
    promotionId: string,
    expectedRevision: number,
): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`
        EXISTS (
            SELECT 1 FROM ${promotions}
            WHERE ${promotions.id} = ${promotionId}
              AND ${promotions.revision} = ${expectedRevision}
              AND ${promotions.deletedAt} IS NULL
              AND ${promotions.status} <> 'archived'
        )
    `, PROMOTION_REVISION_CONFLICT);
}

function buildPromotionRevisionBump(
    db: Database,
    promotionId: string,
): BatchItem<"sqlite"> {
    return db
        .update(promotions)
        .set({
            revision: sql`${promotions.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(promotions.id, promotionId))
        .returning({ revision: promotions.revision });
}

function isPromotionRevisionGuardError(error: unknown): boolean {
    return isBatchGuardError(error, PROMOTION_REVISION_CONFLICT);
}

async function rethrowPromotionRevisionConflictIfStale(
    db: Database,
    promotionId: string,
    expectedRevision: number,
    error: unknown,
): Promise<never> {
    if (isPromotionRevisionGuardError(error)) {
        const current = await db
            .select({
                revision: promotions.revision,
                status: promotions.status,
                deletedAt: promotions.deletedAt,
            })
            .from(promotions)
            .where(eq(promotions.id, promotionId))
            .get();
        if (current?.revision !== expectedRevision) {
            throw new PromotionRevisionConflictError(
                promotionId,
                expectedRevision,
                current?.revision ?? null,
            );
        }
        if (current.deletedAt !== null || current.status === "archived") {
            throw new PromotionStateConflictError(promotionId);
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
            "The promotion change could not be confirmed. Reload the latest rule and try again.",
        );
    }
    return revision;
}

export async function executePromotionRuleMutationBatch(
    db: Database,
    promotionId: string,
    expectedRevision: number,
    mutationStatements: BatchItem<"sqlite">[],
): Promise<{ mutationResults: unknown[]; revision: number }> {
    try {
        const results = await safeBatch(db, [
            buildPromotionRevisionGuard(db, promotionId, expectedRevision),
            ...mutationStatements,
            buildPromotionRevisionBump(db, promotionId),
        ] as never) as unknown[];
        return {
            mutationResults: results.slice(1, -1),
            revision: readRevisionResult(results.at(-1)),
        };
    } catch (error) {
        return rethrowPromotionRevisionConflictIfStale(
            db,
            promotionId,
            expectedRevision,
            error,
        );
    }
}
