import { analytics } from "@scalius/database/schema";
import {
    and,
    asc,
    desc,
    eq,
    isNotNull,
    isNull,
    ne,
    sql,
    type SQL,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { safeBatch, type Database } from "@scalius/database/client";
import type { Analytics } from "@scalius/database/schema";
import type { z } from "zod";
import {
    ConflictError,
    ForbiddenError,
    ValidationError,
} from "@scalius/core/errors";
import {
    getActiveAnalyticsConfigError,
    getAnalyticsProviderIdentifier,
    normalizeCloudflareWebAnalyticsConfig,
    resolveAnalyticsPartytownPolicy,
    type AnalyticsScriptType,
    type createAnalyticsSchema,
    type updateAnalyticsSchema,
} from "./analytics.validation";

type CreateAnalyticsInput = z.infer<typeof createAnalyticsSchema>;
type UpdateAnalyticsInput = z.infer<typeof updateAnalyticsSchema>;

export interface AnalyticsLifecycleAuthority {
    canToggle?: boolean;
}

export interface AnalyticsListOptions {
    page?: number;
    limit?: number;
    search?: string;
    type?: AnalyticsScriptType;
    status?: "active" | "inactive";
    showTrashed?: boolean;
    sort?: "name" | "type" | "createdAt" | "updatedAt";
    order?: "asc" | "desc";
}

function assertAnalyticsLifecycleAuthority(
    requestedActive: boolean,
    currentActive: boolean,
    authority: AnalyticsLifecycleAuthority,
) {
    if (requestedActive !== currentActive && authority.canToggle !== true) {
        throw new ForbiddenError(
            "Activating or deactivating analytics scripts requires analytics.toggle permission.",
        );
    }
}

function toIso(value: Date | number | string | null | undefined): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const numeric = Number(value);
    const date = Number.isFinite(numeric)
        ? new Date(numeric * 1000)
        : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatScriptDetail(script: Analytics | undefined | null) {
    if (!script) return null;
    return {
        ...script,
        usePartytown: resolveAnalyticsPartytownPolicy(script),
        createdAt: toIso(script.createdAt),
        updatedAt: toIso(script.updatedAt),
        deletedAt: toIso(script.deletedAt),
    };
}

function formatScriptSummary(script: Analytics) {
    const configIssue = getActiveAnalyticsConfigError({
        type: script.type,
        config: script.config,
        isActive: true,
    });
    return {
        id: script.id,
        name: script.name,
        type: script.type,
        isActive: script.isActive,
        usePartytown: resolveAnalyticsPartytownPolicy(script),
        location: script.location,
        revision: script.revision,
        identifier: getAnalyticsProviderIdentifier(script.type, script.config),
        readiness: script.deletedAt
            ? "trashed"
            : script.isActive
              ? configIssue ? "blocked" : "ready"
              : configIssue ? "draft" : "ready_to_activate",
        configIssue,
        createdAt: toIso(script.createdAt),
        updatedAt: toIso(script.updatedAt),
        deletedAt: toIso(script.deletedAt),
    };
}

function normalizeAnalyticsScriptValues(
    data: CreateAnalyticsInput | UpdateAnalyticsInput,
) {
    const config = data.type === "cloudflare_web_analytics"
        ? normalizeCloudflareWebAnalyticsConfig(data.config)
        : data.config.trim();

    return {
        config,
        usePartytown: resolveAnalyticsPartytownPolicy({
            type: data.type,
            config,
            usePartytown: data.usePartytown,
        }),
    };
}

function assertAnalyticsScriptCanBeActive(data: {
    type: string;
    config: string;
    isActive: boolean;
}) {
    const error = getActiveAnalyticsConfigError(data);
    if (error) throw new ValidationError(error);
}

async function assertNoUnacknowledgedDuplicateProvider(
    db: Database,
    input: {
        type: AnalyticsScriptType | string;
        isActive: boolean;
        allowDuplicateProvider?: boolean;
        excludeId?: string;
    },
) {
    if (
        !input.isActive ||
        input.type === "custom" ||
        input.allowDuplicateProvider === true
    ) return;

    const conditions: SQL[] = [
        eq(analytics.type, input.type),
        eq(analytics.isActive, true),
        isNull(analytics.deletedAt),
    ];
    if (input.excludeId) conditions.push(ne(analytics.id, input.excludeId));

    const duplicate = await db
        .select({ id: analytics.id })
        .from(analytics)
        .where(and(...conditions))
        .limit(1)
        .get();

    if (duplicate) {
        throw new ConflictError(
            "Another script for this provider is already active. Confirm duplicate tracking only when separate accounts are intentional.",
        );
    }
}

function escapedLike(value: string) {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function listAnalyticsScripts(
    db: Database,
    options: AnalyticsListOptions = {},
) {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const search = options.search?.trim() ?? "";
    const conditions: SQL[] = [
        options.showTrashed
            ? isNotNull(analytics.deletedAt)
            : isNull(analytics.deletedAt),
    ];
    if (search) {
        conditions.push(
            sql`${analytics.name} LIKE ${`%${escapedLike(search)}%`} ESCAPE '\\'`,
        );
    }
    if (options.type) conditions.push(eq(analytics.type, options.type));
    if (options.status) {
        conditions.push(eq(analytics.isActive, options.status === "active"));
    }
    const where = and(...conditions);

    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(analytics)
        .where(where);

    const sortColumn = (() => {
        switch (options.sort) {
            case "name": return analytics.name;
            case "type": return analytics.type;
            case "createdAt": return analytics.createdAt;
            default: return analytics.updatedAt;
        }
    })();

    const rowsQuery = db
        .select()
        .from(analytics)
        .where(where)
        .orderBy(options.order === "asc" ? asc(sortColumn) : desc(sortColumn))
        .limit(limit)
        .offset((page - 1) * limit);

    const batchResults = await safeBatch(db, [countQuery, rowsQuery]);
    const countRows = batchResults[0] as { count: number }[];
    const rows = batchResults[1] as Analytics[];
    const total = Number(countRows[0]?.count ?? 0);

    return {
        scripts: rows.map(formatScriptSummary),
        pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        },
    };
}

export async function getAnalyticsScript(db: Database, id: string) {
    const script = await db
        .select()
        .from(analytics)
        .where(and(eq(analytics.id, id), isNull(analytics.deletedAt)))
        .get();
    return formatScriptDetail(script);
}

export async function createAnalyticsScript(
    db: Database,
    data: CreateAnalyticsInput,
    authority: AnalyticsLifecycleAuthority = {},
) {
    assertAnalyticsLifecycleAuthority(data.isActive, false, authority);
    const normalized = normalizeAnalyticsScriptValues(data);
    assertAnalyticsScriptCanBeActive({
        type: data.type,
        config: normalized.config,
        isActive: data.isActive,
    });
    await assertNoUnacknowledgedDuplicateProvider(db, data);

    const analyticsId = `analytics_${nanoid()}`;
    const [script] = await db
        .insert(analytics)
        .values({
            id: analyticsId,
            name: data.name.trim(),
            type: data.type,
            isActive: data.isActive,
            usePartytown: normalized.usePartytown,
            config: normalized.config,
            location: data.location,
            revision: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
            deletedAt: null,
        })
        .returning();

    return { id: analyticsId, revision: 1, script: formatScriptDetail(script) };
}

export async function updateAnalyticsScript(
    db: Database,
    id: string,
    data: UpdateAnalyticsInput,
    authority: AnalyticsLifecycleAuthority = {},
) {
    const existing = await db
        .select({
            isActive: analytics.isActive,
            revision: analytics.revision,
            type: analytics.type,
        })
        .from(analytics)
        .where(and(eq(analytics.id, id), isNull(analytics.deletedAt)))
        .get();
    if (!existing) return null;
    if (existing.revision !== data.expectedRevision) {
        throw new ConflictError("Analytics script changed. Reload before saving again.");
    }

    assertAnalyticsLifecycleAuthority(data.isActive, existing.isActive, authority);
    const normalized = normalizeAnalyticsScriptValues(data);
    assertAnalyticsScriptCanBeActive({
        type: data.type,
        config: normalized.config,
        isActive: data.isActive,
    });
    if (!existing.isActive || existing.type !== data.type) {
        await assertNoUnacknowledgedDuplicateProvider(db, {
            ...data,
            excludeId: id,
        });
    }

    const updated = await db
        .update(analytics)
        .set({
            name: data.name.trim(),
            type: data.type,
            isActive: data.isActive,
            usePartytown: normalized.usePartytown,
            config: normalized.config,
            location: data.location,
            revision: sql`${analytics.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(analytics.id, id),
            eq(analytics.revision, data.expectedRevision),
            isNull(analytics.deletedAt),
        ))
        .returning()
        .get();
    if (!updated) {
        throw new ConflictError("Analytics script changed. Reload before saving again.");
    }
    return formatScriptDetail(updated);
}

export async function toggleAnalyticsScript(
    db: Database,
    id: string,
    input: {
        isActive: boolean;
        expectedRevision: number;
        allowDuplicateProvider?: boolean;
    },
) {
    const existing = await db
        .select({
            type: analytics.type,
            config: analytics.config,
            revision: analytics.revision,
        })
        .from(analytics)
        .where(and(eq(analytics.id, id), isNull(analytics.deletedAt)))
        .get();
    if (!existing) return null;
    if (existing.revision !== input.expectedRevision) {
        throw new ConflictError("Analytics script changed. Reload before changing its status.");
    }
    assertAnalyticsScriptCanBeActive({
        type: existing.type,
        config: existing.config,
        isActive: input.isActive,
    });
    await assertNoUnacknowledgedDuplicateProvider(db, {
        type: existing.type,
        isActive: input.isActive,
        allowDuplicateProvider: input.allowDuplicateProvider,
        excludeId: id,
    });

    const updated = await db
        .update(analytics)
        .set({
            isActive: input.isActive,
            revision: sql`${analytics.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(analytics.id, id),
            eq(analytics.revision, input.expectedRevision),
            isNull(analytics.deletedAt),
        ))
        .returning()
        .get();
    if (!updated) {
        throw new ConflictError("Analytics script changed. Reload before changing its status.");
    }
    return formatScriptDetail(updated);
}

/** Moves a script to recoverable trash and always deactivates it. */
export async function deleteAnalyticsScript(
    db: Database,
    id: string,
    expectedRevision: number,
) {
    const updated = await db
        .update(analytics)
        .set({
            isActive: false,
            deletedAt: sql`unixepoch()`,
            revision: sql`${analytics.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(analytics.id, id),
            eq(analytics.revision, expectedRevision),
            isNull(analytics.deletedAt),
        ))
        .returning()
        .get();
    if (!updated) {
        throw new ConflictError("Analytics script changed or is already in trash. Reload and try again.");
    }
    return formatScriptSummary(updated);
}

export async function restoreAnalyticsScript(
    db: Database,
    id: string,
    expectedRevision: number,
) {
    const updated = await db
        .update(analytics)
        .set({
            isActive: false,
            deletedAt: null,
            revision: sql`${analytics.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(analytics.id, id),
            eq(analytics.revision, expectedRevision),
            isNotNull(analytics.deletedAt),
        ))
        .returning()
        .get();
    if (!updated) {
        throw new ConflictError("Analytics script changed or is not in trash. Reload and try again.");
    }
    return formatScriptSummary(updated);
}

export async function permanentlyDeleteAnalyticsScript(
    db: Database,
    id: string,
    expectedRevision: number,
) {
    const deleted = await db
        .delete(analytics)
        .where(and(
            eq(analytics.id, id),
            eq(analytics.revision, expectedRevision),
            isNotNull(analytics.deletedAt),
        ))
        .returning({ id: analytics.id })
        .get();
    if (!deleted) {
        throw new ConflictError("Only the current trashed script can be permanently deleted.");
    }
    return deleted;
}
