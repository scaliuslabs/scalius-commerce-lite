import { categories } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { buildBatchGuard } from "@scalius/database/client";
import { sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { AppError, ValidationError } from "@scalius/core/errors";
import type { CategoryRevisionClaim } from "./categories.validation";

export const CATEGORY_REVISION_CONFLICT = "CATEGORY_REVISION_CONFLICT";

export type CategoryLifecycleState = "active" | "trashed";

export class CategoryRevisionConflictError extends AppError {
    constructor(
        categoryId: string,
        expectedRevision: number,
        currentRevision: number | null,
    ) {
        super(
            409,
            "CATEGORY_REVISION_CONFLICT",
            "This category changed while you were editing. Reload the latest category and try again.",
            { categoryId, expectedRevision, currentRevision },
        );
        this.name = "CategoryRevisionConflictError";
    }
}

export class CategoryStateConflictError extends AppError {
    constructor(categoryId: string, requiredState: CategoryLifecycleState) {
        super(
            409,
            "CATEGORY_STATE_CONFLICT",
            requiredState === "active"
                ? "This category is no longer active. Return to categories and reload."
                : "This category is not in trash. Return to categories and reload.",
            { categoryId, requiredState },
        );
        this.name = "CategoryStateConflictError";
    }
}

export function normalizeCategoryRevisionClaims(
    claims: readonly CategoryRevisionClaim[],
    limit: number,
): CategoryRevisionClaim[] {
    if (claims.length === 0) throw new ValidationError("Select at least one category.");
    if (claims.length > limit) {
        throw new ValidationError(`Change at most ${limit} categories at a time.`);
    }
    const normalized = claims.map((claim) => ({
        id: claim.id.trim(),
        expectedRevision: claim.expectedRevision,
    }));
    if (normalized.some((claim) => !claim.id || !Number.isInteger(claim.expectedRevision) || claim.expectedRevision < 1)) {
        throw new ValidationError("Every category change requires an ID and positive expected revision.");
    }
    if (new Set(normalized.map((claim) => claim.id)).size !== normalized.length) {
        throw new ValidationError("Category revision claims must use unique IDs.");
    }
    return normalized;
}

export function categoryClaimIdsCondition(
    claims: readonly CategoryRevisionClaim[],
): SQL {
    return sql`${categories.id} IN (
        SELECT CAST(json_extract(value, '$.id') AS TEXT)
        FROM json_each(${JSON.stringify(claims)})
    )`;
}

export function buildCategoryRevisionGuard(
    db: Database,
    claims: readonly CategoryRevisionClaim[],
    requiredState: CategoryLifecycleState,
): BatchItem<"sqlite"> {
    const serialized = JSON.stringify(claims);
    return buildBatchGuard(db, sql`
        CASE WHEN (
            SELECT count(*)
            FROM json_each(${serialized}) AS claim
            INNER JOIN ${categories}
                ON ${categories.id} = CAST(json_extract(claim.value, '$.id') AS TEXT)
               AND ${categories.revision} = CAST(json_extract(claim.value, '$.expectedRevision') AS INTEGER)
            WHERE ${requiredState === "active"
                ? sql`${categories.deletedAt} IS NULL`
                : sql`${categories.deletedAt} IS NOT NULL`}
        ) = ${claims.length}
        THEN 1 ELSE json_extract(${CATEGORY_REVISION_CONFLICT}, '$') END
    `);
}

function isCategoryRevisionGuardError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /CATEGORY_REVISION_CONFLICT|malformed json/i.test(message);
}

export async function rethrowCategoryRevisionConflict(
    db: Database,
    claims: readonly CategoryRevisionClaim[],
    error: unknown,
    requiredState: CategoryLifecycleState,
): Promise<never> {
    if (isCategoryRevisionGuardError(error)) {
        const rows = await db
            .select({
                id: categories.id,
                revision: categories.revision,
                deletedAt: categories.deletedAt,
            })
            .from(categories)
            .where(categoryClaimIdsCondition(claims))
            .all();
        const currentById = new Map(rows.map((row) => [row.id, row.revision]));
        const stale = claims.find((claim) => currentById.get(claim.id) !== claim.expectedRevision);
        if (stale) {
            throw new CategoryRevisionConflictError(
                stale.id,
                stale.expectedRevision,
                currentById.get(stale.id) ?? null,
            );
        }
        const stateMismatch = rows.find((row) =>
            requiredState === "active" ? row.deletedAt !== null : row.deletedAt === null
        );
        if (stateMismatch) {
            throw new CategoryStateConflictError(stateMismatch.id, requiredState);
        }
    }
    throw error;
}

export function revisionResult(rows: unknown): number {
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const revision = row && typeof row === "object"
        ? (row as { revision?: unknown }).revision
        : undefined;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
        throw new AppError(
            409,
            "CATEGORY_REVISION_UNCONFIRMED",
            "The category change could not be confirmed. Reload the category and try again.",
        );
    }
    return revision;
}
