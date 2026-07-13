import { safeBatch, type Database } from "@scalius/database/client";
import {
    discounts,
    promotionCodes,
    promotionConditions,
    promotionEffects,
    promotionRedemptions,
    promotions,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import {
    evaluatePromotionCandidates,
    promotionCandidateSchema,
    type PromotionCandidate,
    type PromotionEvaluationResult,
} from "./promotions.evaluator";
import {
    executePromotionRuleMutationBatch,
    PromotionRevisionConflictError,
} from "./promotions.revision";
import {
    createPromotionDraftSchema,
    updatePromotionDraftSchema,
    type CreatePromotionDraftInput,
    type UpdatePromotionDraftInput,
} from "./promotions.validation";

const CHILD_INSERT_CHUNK_SIZE = 8;
// A list page is also the enrichment lookup set. Keep it below D1's 100 bound
// parameter ceiling so codes/conditions/effects can each be read in one query.
const PROMOTION_LIST_LIMIT = 90;

type PromotionStatus = "draft" | "active" | "paused" | "archived";

export interface PromotionAggregate extends PromotionCandidate {
    title: string | null;
    timezone: string;
    createdAtEpochSeconds: number;
    updatedAtEpochSeconds: number;
    deletedAtEpochSeconds: number | null;
}

export async function getPromotionUsageStats(
    db: Database,
    promotionId: string,
    customerId: string | null,
): Promise<Pick<PromotionAggregate, "redemptionCount" | "customerRedemptionCount" | "discountSpendMinor">> {
    const totalRead = db.select({
        redemptionCount: count(),
        discountSpendMinor: sql<number>`coalesce(sum(${promotionRedemptions.discountAmountMinor}), 0)`,
    }).from(promotionRedemptions).where(eq(promotionRedemptions.promotionId, promotionId));
    const customerRead = customerId
        ? db.select({ customerRedemptionCount: count() })
            .from(promotionRedemptions)
            .where(and(
                eq(promotionRedemptions.promotionId, promotionId),
                eq(promotionRedemptions.customerId, customerId),
            ))
        : null;
    if (!customerRead) {
        const total = (await totalRead)[0];
        return {
            redemptionCount: Number(total?.redemptionCount ?? 0),
            customerRedemptionCount: 0,
            discountSpendMinor: Number(total?.discountSpendMinor ?? 0),
        };
    }
    const [totalRows, customerRows] = await db.batch([totalRead, customerRead]);
    return {
        redemptionCount: Number(totalRows[0]?.redemptionCount ?? 0),
        customerRedemptionCount: Number(customerRows[0]?.customerRedemptionCount ?? 0),
        discountSpendMinor: Number(totalRows[0]?.discountSpendMinor ?? 0),
    };
}

function chunksOf<T>(values: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

function toEpochSeconds(value: Date | number | null): number | null {
    if (value === null) return null;
    if (value instanceof Date) return Math.floor(value.getTime() / 1_000);
    return Number.isFinite(value) ? Math.floor(value) : null;
}

function fromEpochSeconds(value: number | null): Date | null {
    return value === null ? null : new Date(value * 1_000);
}

function parseConfig(value: string, label: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new ValidationError(`${label} configuration is unreadable. Repair the promotion before using it.`);
    }
}

function buildPromotionAggregate(
    parent: typeof promotions.$inferSelect,
    codeRows: Array<typeof promotionCodes.$inferSelect>,
    conditionRows: Array<typeof promotionConditions.$inferSelect>,
    effectRows: Array<typeof promotionEffects.$inferSelect>,
): PromotionAggregate {
    const candidate = promotionCandidateSchema.safeParse({
        id: parent.id,
        revision: parent.revision,
        name: parent.name,
        method: parent.method,
        status: parent.status,
        priority: parent.priority,
        conflictPolicy: parent.conflictPolicy,
        startsAtEpochSeconds: toEpochSeconds(parent.startsAt),
        endsAtEpochSeconds: toEpochSeconds(parent.endsAt),
        maxRedemptions: parent.maxRedemptions,
        maxRedemptionsPerCustomer: parent.maxRedemptionsPerCustomer,
        maxDiscountSpendMinor: parent.maxDiscountSpendMinor,
        budgetCurrencyCode: parent.budgetCurrencyCode,
        redemptionCount: 0,
        customerRedemptionCount: 0,
        discountSpendMinor: 0,
        codes: codeRows.map((code) => ({ code: code.normalizedCode, isActive: code.isActive })),
        conditions: conditionRows.map((condition) => ({
            id: condition.id,
            kind: condition.kind,
            config: parseConfig(condition.config, "Promotion condition"),
        })),
        effects: effectRows.map((effect) => ({
            id: effect.id,
            kind: effect.kind,
            target: effect.target,
            allocation: effect.allocation,
            config: parseConfig(effect.config, "Promotion effect"),
        })),
    });
    if (!candidate.success) {
        throw new ValidationError("Promotion configuration is invalid and cannot be evaluated.", {
            promotionId: parent.id,
            issues: candidate.error.issues,
        });
    }

    return {
        ...candidate.data,
        title: parent.title,
        timezone: parent.timezone,
        createdAtEpochSeconds: toEpochSeconds(parent.createdAt) ?? 0,
        updatedAtEpochSeconds: toEpochSeconds(parent.updatedAt) ?? 0,
        deletedAtEpochSeconds: toEpochSeconds(parent.deletedAt),
    };
}

function isCodeIdentityConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /promotion_codes_identity_unique|discounts\.code|PROMOTION_CODE_IDENTITY_CONFLICT/iu.test(message);
}

async function assertCodeIdentitiesAvailable(
    db: Database,
    codes: readonly string[],
    promotionId?: string,
): Promise<void> {
    if (codes.length === 0) return;

    const [promotionRows, legacyRows] = await db.batch([
        db.select({
            promotionId: promotionCodes.promotionId,
            code: promotionCodes.normalizedCode,
        }).from(promotionCodes).where(inArray(promotionCodes.normalizedCode, [...codes])),
        db.select({ code: discounts.code })
            .from(discounts)
            .where(inArray(sql<string>`upper(trim(${discounts.code}))`, [...codes])),
    ]);

    const collision = promotionRows.find((row) => row.promotionId !== promotionId)?.code
        ?? legacyRows[0]?.code
        ?? null;
    if (collision) {
        throw new ConflictError(`Promotion code ${String(collision).trim().toUpperCase()} is already reserved.`);
    }
}

function buildCodeRows(promotionId: string, input: CreatePromotionDraftInput) {
    return input.codes.map(({ code, isActive }) => ({
        id: `pcode_${nanoid()}`,
        promotionId,
        code,
        normalizedCode: code,
        isActive,
        createdAt: sql`unixepoch()`,
    }));
}

function buildConditionRows(promotionId: string, input: CreatePromotionDraftInput) {
    return input.conditions.map((condition, position) => ({
        id: `pcond_${nanoid()}`,
        promotionId,
        kind: condition.kind,
        config: JSON.stringify(condition.config),
        position,
        createdAt: sql`unixepoch()`,
    }));
}

function buildEffectInsertRow(
    promotionId: string,
    effect: CreatePromotionDraftInput["effects"][number],
    position: number,
) {
    return {
        id: `peff_${nanoid()}`,
        promotionId,
        kind: effect.kind,
        target: effect.target,
        allocation: effect.allocation,
        config: JSON.stringify(effect.config),
        position,
        deletedAt: null,
        createdAt: sql`unixepoch()`,
    };
}

function buildChildInsertStatements(
    db: Database,
    promotionId: string,
    input: CreatePromotionDraftInput,
): BatchItem<"sqlite">[] {
    const statements: BatchItem<"sqlite">[] = [];
    for (const rows of chunksOf(buildCodeRows(promotionId, input), CHILD_INSERT_CHUNK_SIZE)) {
        if (rows.length > 0) statements.push(db.insert(promotionCodes).values(rows));
    }
    for (const rows of chunksOf(buildConditionRows(promotionId, input), CHILD_INSERT_CHUNK_SIZE)) {
        if (rows.length > 0) statements.push(db.insert(promotionConditions).values(rows));
    }
    for (const rows of chunksOf(
        input.effects.map((effect, position) => buildEffectInsertRow(promotionId, effect, position)),
        CHILD_INSERT_CHUNK_SIZE,
    )) {
        if (rows.length > 0) statements.push(db.insert(promotionEffects).values(rows));
    }
    return statements;
}

export async function createPromotionDraft(
    db: Database,
    rawInput: CreatePromotionDraftInput,
): Promise<{ id: string; revision: number; status: "draft" }> {
    const input = createPromotionDraftSchema.parse(rawInput);
    await assertCodeIdentitiesAvailable(db, input.codes.map(({ code }) => code));

    const id = `promo_${nanoid()}`;
    const parentInsert = db.insert(promotions).values({
        id,
        name: input.name,
        title: input.title,
        method: input.method,
        status: "draft",
        priority: input.priority,
        conflictPolicy: input.conflictPolicy,
        startsAt: fromEpochSeconds(input.startsAtEpochSeconds),
        endsAt: fromEpochSeconds(input.endsAtEpochSeconds),
        timezone: input.timezone,
        maxRedemptions: input.maxRedemptions,
        maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer,
        maxDiscountSpendMinor: input.maxDiscountSpendMinor,
        budgetCurrencyCode: input.budgetCurrencyCode,
        revision: 1,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    });

    try {
        await safeBatch(db, [
            parentInsert,
            ...buildChildInsertStatements(db, id, input),
        ] as never);
    } catch (error) {
        if (isCodeIdentityConflict(error)) {
            throw new ConflictError("One or more promotion codes are already reserved.");
        }
        throw error;
    }

    return { id, revision: 1, status: "draft" };
}

export async function getPromotionAggregate(
    db: Database,
    promotionId: string,
    options: { includeDeleted?: boolean } = {},
): Promise<PromotionAggregate | null> {
    const normalizedId = promotionId.trim();
    if (!normalizedId) return null;

    const parentWhere = options.includeDeleted
        ? eq(promotions.id, normalizedId)
        : and(eq(promotions.id, normalizedId), isNull(promotions.deletedAt));
    const [parentRows, codeRows, conditionRows, effectRows] = await db.batch([
        db.select().from(promotions).where(parentWhere).limit(1),
        db.select().from(promotionCodes)
            .where(eq(promotionCodes.promotionId, normalizedId))
            .orderBy(asc(promotionCodes.normalizedCode)),
        db.select().from(promotionConditions)
            .where(eq(promotionConditions.promotionId, normalizedId))
            .orderBy(asc(promotionConditions.position), asc(promotionConditions.id)),
        db.select().from(promotionEffects)
            .where(and(
                eq(promotionEffects.promotionId, normalizedId),
                isNull(promotionEffects.deletedAt),
            ))
            .orderBy(asc(promotionEffects.position), asc(promotionEffects.id)),
    ]);
    const parent = parentRows[0];
    if (!parent) return null;

    return buildPromotionAggregate(parent, codeRows, conditionRows, effectRows);
}

export async function listPromotionDrafts(
    db: Database,
    input: { limit?: number; includeDeleted?: boolean } = {},
): Promise<PromotionAggregate[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), PROMOTION_LIST_LIMIT);
    const rows = await db.select()
        .from(promotions)
        .where(input.includeDeleted ? undefined : isNull(promotions.deletedAt))
        .orderBy(desc(promotions.updatedAt), asc(promotions.id))
        .limit(limit);
    if (rows.length === 0) return [];

    const ids = rows.map(({ id }) => id);
    const [codeRows, conditionRows, effectRows, usageRows] = await db.batch([
        db.select().from(promotionCodes)
            .where(inArray(promotionCodes.promotionId, ids))
            .orderBy(asc(promotionCodes.normalizedCode)),
        db.select().from(promotionConditions)
            .where(inArray(promotionConditions.promotionId, ids))
            .orderBy(asc(promotionConditions.position), asc(promotionConditions.id)),
        db.select().from(promotionEffects)
            .where(and(
                inArray(promotionEffects.promotionId, ids),
                isNull(promotionEffects.deletedAt),
            ))
            .orderBy(asc(promotionEffects.position), asc(promotionEffects.id)),
        db.select({
            promotionId: promotionRedemptions.promotionId,
            redemptionCount: count(),
            discountSpendMinor: sql<number>`coalesce(sum(${promotionRedemptions.discountAmountMinor}), 0)`,
        }).from(promotionRedemptions)
            .where(inArray(promotionRedemptions.promotionId, ids))
            .groupBy(promotionRedemptions.promotionId),
    ]);
    const usageByPromotionId = new Map(usageRows.map((usage) => [usage.promotionId, usage]));

    return rows.map((parent) => {
        const aggregate = buildPromotionAggregate(
            parent,
            codeRows.filter((code) => code.promotionId === parent.id),
            conditionRows.filter((condition) => condition.promotionId === parent.id),
            effectRows.filter((effect) => effect.promotionId === parent.id),
        );
        const usage = usageByPromotionId.get(parent.id);
        return {
            ...aggregate,
            redemptionCount: Number(usage?.redemptionCount ?? 0),
            discountSpendMinor: Number(usage?.discountSpendMinor ?? 0),
        };
    });
}

export async function updatePromotionDraft(
    db: Database,
    promotionId: string,
    rawInput: UpdatePromotionDraftInput,
): Promise<{ id: string; revision: number; status: PromotionStatus }> {
    const input = updatePromotionDraftSchema.parse(rawInput);
    const current = await getPromotionAggregate(db, promotionId);
    if (!current) throw new NotFoundError("Promotion not found");
    if (current.status === "archived") {
        throw new ConflictError("Archived promotions cannot be edited.");
    }
    await assertCodeIdentitiesAvailable(
        db,
        input.codes.map(({ code }) => code),
        promotionId,
    );

    const allEffectRows = await db.select({
        id: promotionEffects.id,
        target: promotionEffects.target,
    }).from(promotionEffects).where(eq(promotionEffects.promotionId, promotionId));
    const existingEffectByTarget = new Map(allEffectRows.map((row) => [row.target, row]));

    const statements: BatchItem<"sqlite">[] = [
        db.delete(promotionCodes).where(eq(promotionCodes.promotionId, promotionId)),
        db.delete(promotionConditions).where(eq(promotionConditions.promotionId, promotionId)),
        db.update(promotionEffects)
            .set({ deletedAt: sql`unixepoch()` })
            .where(and(
                eq(promotionEffects.promotionId, promotionId),
                isNull(promotionEffects.deletedAt),
            )),
        db.update(promotions).set({
            name: input.name,
            title: input.title,
            method: input.method,
            priority: input.priority,
            conflictPolicy: input.conflictPolicy,
            startsAt: fromEpochSeconds(input.startsAtEpochSeconds),
            endsAt: fromEpochSeconds(input.endsAtEpochSeconds),
            timezone: input.timezone,
            maxRedemptions: input.maxRedemptions,
            maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer,
            maxDiscountSpendMinor: input.maxDiscountSpendMinor,
            budgetCurrencyCode: input.budgetCurrencyCode,
            updatedAt: sql`unixepoch()`,
        }).where(eq(promotions.id, promotionId)),
    ];

    for (const rows of chunksOf(buildCodeRows(promotionId, input), CHILD_INSERT_CHUNK_SIZE)) {
        if (rows.length > 0) statements.push(db.insert(promotionCodes).values(rows));
    }
    for (const rows of chunksOf(buildConditionRows(promotionId, input), CHILD_INSERT_CHUNK_SIZE)) {
        if (rows.length > 0) statements.push(db.insert(promotionConditions).values(rows));
    }
    input.effects.forEach((effect, position) => {
        const existing = existingEffectByTarget.get(effect.target);
        if (existing) {
            statements.push(db.update(promotionEffects).set({
                kind: effect.kind,
                allocation: effect.allocation,
                config: JSON.stringify(effect.config),
                position,
                deletedAt: null,
            }).where(eq(promotionEffects.id, existing.id)));
        } else {
            statements.push(db.insert(promotionEffects).values(
                buildEffectInsertRow(promotionId, effect, position),
            ));
        }
    });

    try {
        const result = await executePromotionRuleMutationBatch(
            db,
            promotionId,
            input.expectedRevision,
            statements,
        );
        return { id: promotionId, revision: result.revision, status: current.status };
    } catch (error) {
        if (isCodeIdentityConflict(error)) {
            throw new ConflictError("One or more promotion codes are already reserved.");
        }
        throw error;
    }
}

export async function archivePromotionDraft(
    db: Database,
    promotionId: string,
    expectedRevision: number,
): Promise<{ id: string; revision: number; status: "archived" }> {
    const result = await executePromotionRuleMutationBatch(
        db,
        promotionId,
        expectedRevision,
        [
            db.update(promotions).set({
                status: "archived",
                deletedAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }).where(eq(promotions.id, promotionId)),
        ],
    );
    return { id: promotionId, revision: result.revision, status: "archived" };
}

export async function previewPersistedPromotion(
    db: Database,
    input: {
        promotionId: string;
        expectedRevision: number;
        cart: unknown;
        customerId?: string | null;
    },
): Promise<PromotionEvaluationResult & { assumedActive: boolean; promotionRevision: number }> {
    const promotion = await getPromotionAggregate(db, input.promotionId);
    if (!promotion) throw new NotFoundError("Promotion not found");
    if (promotion.revision !== input.expectedRevision) {
        throw new PromotionRevisionConflictError(
            input.promotionId,
            input.expectedRevision,
            promotion.revision,
        );
    }

    const usage = await getPromotionUsageStats(db, promotion.id, input.customerId ?? null);
    const assumedActive = promotion.status !== "active";
    const result = evaluatePromotionCandidates({
        cart: input.cart,
        candidates: [{
            ...promotion,
            ...usage,
            status: "active",
        }],
    });
    return {
        ...result,
        assumedActive,
        promotionRevision: promotion.revision,
    };
}
