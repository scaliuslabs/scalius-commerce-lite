import { pages } from "@scalius/database/schema";
import {
    buildBatchGuard,
    isBatchGuardError,
    type Database,
} from "@scalius/database/client";
import { sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { AppError, ValidationError } from "@scalius/core/errors";
import type { PageRevisionClaim } from "./pages.validation";

export const PAGE_REVISION_CONFLICT = "PAGE_REVISION_CONFLICT";

export type PageLifecycleState = "active" | "trashed";

export class PageRevisionConflictError extends AppError {
    constructor(pageId: string, expectedRevision: number, currentRevision: number | null) {
        super(
            409,
            PAGE_REVISION_CONFLICT,
            "This page changed while you were editing. Reload the latest page and try again.",
            { pageId, expectedRevision, currentRevision },
        );
        this.name = "PageRevisionConflictError";
    }
}

export class PageStateConflictError extends AppError {
    constructor(pageId: string, requiredState: PageLifecycleState) {
        super(
            409,
            "PAGE_STATE_CONFLICT",
            requiredState === "active"
                ? "This page is no longer active. Return to pages and reload."
                : "This page is not in trash. Return to pages and reload.",
            { pageId, requiredState },
        );
        this.name = "PageStateConflictError";
    }
}

export function normalizePageRevisionClaims(
    claims: readonly PageRevisionClaim[],
    limit: number,
): PageRevisionClaim[] {
    if (claims.length === 0) throw new ValidationError("Select at least one page.");
    if (claims.length > limit) {
        throw new ValidationError(`Change at most ${limit} pages at a time.`);
    }
    const normalized = claims.map((claim) => ({
        id: claim.id.trim(),
        expectedRevision: claim.expectedRevision,
    }));
    if (normalized.some((claim) =>
        !claim.id || !Number.isInteger(claim.expectedRevision) || claim.expectedRevision < 1
    )) {
        throw new ValidationError(
            "Every page change requires an ID and positive expected revision.",
        );
    }
    if (new Set(normalized.map((claim) => claim.id)).size !== normalized.length) {
        throw new ValidationError("Page revision claims must use unique IDs.");
    }
    return normalized;
}

export function pageClaimIdsCondition(claims: readonly PageRevisionClaim[]): SQL {
    return sql`${pages.id} IN (
        SELECT CAST(json_extract(value, '$.id') AS TEXT)
        FROM json_each(${JSON.stringify(claims)})
    )`;
}

export function pageRevisionClaimsMatchCondition(
    claims: readonly PageRevisionClaim[],
    requiredState: PageLifecycleState,
): SQL {
    const serialized = JSON.stringify(claims);
    return sql`(
        SELECT count(*)
        FROM json_each(${serialized}) AS claim
        INNER JOIN ${pages}
            ON ${pages.id} = CAST(json_extract(claim.value, '$.id') AS TEXT)
           AND ${pages.revision} = CAST(json_extract(claim.value, '$.expectedRevision') AS INTEGER)
        WHERE ${requiredState === "active"
            ? sql`${pages.deletedAt} IS NULL`
            : sql`${pages.deletedAt} IS NOT NULL`}
    ) = ${claims.length}`;
}

export function buildPageRevisionGuard(
    db: Database,
    claims: readonly PageRevisionClaim[],
    requiredState: PageLifecycleState,
): BatchItem<"sqlite"> {
    return buildBatchGuard(db, pageRevisionClaimsMatchCondition(
        claims,
        requiredState,
    ), PAGE_REVISION_CONFLICT);
}

function isPageRevisionGuardError(error: unknown): boolean {
    return isBatchGuardError(error, PAGE_REVISION_CONFLICT);
}

export async function rethrowPageRevisionConflict(
    db: Database,
    claims: readonly PageRevisionClaim[],
    error: unknown,
    requiredState: PageLifecycleState,
): Promise<never> {
    if (isPageRevisionGuardError(error)) {
        const rows = await db
            .select({
                id: pages.id,
                revision: pages.revision,
                deletedAt: pages.deletedAt,
            })
            .from(pages)
            .where(pageClaimIdsCondition(claims))
            .all();
        const currentById = new Map(rows.map((row) => [row.id, row.revision]));
        const stale = claims.find((claim) => currentById.get(claim.id) !== claim.expectedRevision);
        if (stale) {
            throw new PageRevisionConflictError(
                stale.id,
                stale.expectedRevision,
                currentById.get(stale.id) ?? null,
            );
        }
        const stateMismatch = rows.find((row) =>
            requiredState === "active" ? row.deletedAt !== null : row.deletedAt === null
        );
        if (stateMismatch) {
            throw new PageStateConflictError(stateMismatch.id, requiredState);
        }
    }
    throw error;
}
