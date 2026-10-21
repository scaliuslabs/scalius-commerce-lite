import { chunkForD1, type Database, safeBatch } from "@scalius/database/client";
import {
    orderDiscountAllocations,
    promotionCodes,
    promotionConditions,
    promotionCustomerSegments,
    promotionEffects,
    promotionRedemptions,
    promotions,
} from "@scalius/database/schema";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { planLimits } from "@scalius/shared/plan-limits";
import { containsText } from "../../utils/text-match";
import { COUNT_PROBE_COLUMN, cappedCountQuery, cappedPagination, tooDeepPage } from "../../utils/keyset";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import { customerSegmentMembership, readSegmentDefinitions } from "../customers";
import { currentStoreTimeZone } from "../../utils/store-time-zone";
import { priceIncrementForCurrency } from "../settings";
import { readStoreCurrency } from "../markets";
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
    promotionAmountIssues,
    updatePromotionDraftSchema,
    type CreatePromotionDraftInput,
    type PromotionRule,
    type UpdatePromotionDraftInput,
} from "./promotions.validation";

const CHILD_INSERT_CHUNK_SIZE = 8;
// A list page is also the enrichment lookup set. Keep it below D1's 100 bound
// parameter ceiling so codes/conditions/effects can each be read in one query.
const PROMOTION_LIST_LIMIT = 90;

type PromotionStatus = "draft" | "active" | "paused" | "archived";

/** A stored rule; `customerInSegment` belongs to one buyer's evaluation, not to the rule. */
export interface PromotionAggregate extends Omit<PromotionCandidate, "customerInSegment"> {
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

function toEpochSeconds(value: Date | number | null): number | null {
    if (value === null) return null;
    if (value instanceof Date) return Math.floor(value.getTime() / 1_000);
    return Number.isFinite(value) ? Math.floor(value) : null;
}

function fromIso(value: string | null): Date | null {
    return value === null ? null : new Date(value);
}

function parseConfig(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

/**
 * Unvalidated evaluator input; the evaluator rejects a broken rule on its
 * own. A rule limited to customer segments stays closed to everyone until
 * the caller sets `customerInSegment` for its signed-in customer.
 */
export function promotionCandidateRecord(
    parent: typeof promotions.$inferSelect,
    codeRows: Array<typeof promotionCodes.$inferSelect>,
    conditionRows: Array<typeof promotionConditions.$inferSelect>,
    effectRows: Array<typeof promotionEffects.$inferSelect>,
    segmentRows: ReadonlyArray<{ segmentId: string }> = [],
) {
    return {
        id: parent.id,
        revision: parent.revision,
        name: parent.name,
        method: parent.method,
        status: parent.status,
        priority: parent.priority,
        conflictPolicy: parent.conflictPolicy,
        combinesWith: {
            product: parent.combinesWithProductDiscounts,
            order: parent.combinesWithOrderDiscounts,
            shipping: parent.combinesWithShippingDiscounts,
        },
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
            config: parseConfig(condition.config),
        })),
        effects: effectRows.map((effect) => ({
            id: effect.id,
            kind: effect.kind,
            target: effect.target,
            allocation: effect.allocation,
            config: parseConfig(effect.config),
        })),
        customerSegmentIds: segmentRows.map(({ segmentId }) => segmentId).sort(),
        customerInSegment: false,
    };
}

/**
 * Which of these segments one signed-in customer is in now: one read of the
 * definitions and one batch of primary-key membership lookups. Deleted or
 * unreadable segments match nobody; no customer matches nothing.
 */
export async function matchCustomerSegments(
    db: Database,
    customerId: string | null | undefined,
    segmentIds: readonly string[],
    nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<Set<string>> {
    const unique = [...new Set(segmentIds)];
    if (!customerId || unique.length === 0) return new Set();
    const definitions = await readSegmentDefinitions(db, unique);
    return customerSegmentMembership(
        db,
        customerId,
        unique.map((id) => ({ id, definition: definitions.get(id) ?? null })),
        { nowSeconds, timeZone: currentStoreTimeZone() },
    );
}

function buildPromotionAggregate(
    parent: typeof promotions.$inferSelect,
    codeRows: Array<typeof promotionCodes.$inferSelect>,
    conditionRows: Array<typeof promotionConditions.$inferSelect>,
    effectRows: Array<typeof promotionEffects.$inferSelect>,
    segmentRows: ReadonlyArray<{ segmentId: string }>,
): PromotionAggregate {
    const candidate = promotionCandidateSchema.safeParse(
        promotionCandidateRecord(parent, codeRows, conditionRows, effectRows, segmentRows),
    );
    if (!candidate.success) {
        throw new ValidationError("Promotion configuration is invalid and cannot be evaluated.", {
            promotionId: parent.id,
            issues: candidate.error.issues,
        });
    }

    const { customerInSegment: _buyerOnly, ...rule } = candidate.data;
    return {
        ...rule,
        title: parent.title,
        timezone: parent.timezone,
        createdAtEpochSeconds: toEpochSeconds(parent.createdAt) ?? 0,
        updatedAtEpochSeconds: toEpochSeconds(parent.updatedAt) ?? 0,
        deletedAtEpochSeconds: toEpochSeconds(parent.deletedAt),
    };
}

function isCodeIdentityConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /promotion_codes_identity_unique|promotion_codes\.normalized_code/iu.test(message);
}

async function assertCodeIdentitiesAvailable(
    db: Database,
    codes: readonly string[],
    promotionId?: string,
): Promise<void> {
    if (codes.length === 0) return;

    const promotionRows = await db.select({
        promotionId: promotionCodes.promotionId,
        code: promotionCodes.normalizedCode,
    }).from(promotionCodes).where(inArray(promotionCodes.normalizedCode, [...codes]));

    const collision = promotionRows.find((row) => row.promotionId !== promotionId)?.code;
    if (collision) {
        throw new ConflictError(`The discount code ${collision} is already in use.`);
    }
}

/** Every chosen segment exists and is not deleted (one read of at most five rows). */
async function assertCustomerSegmentsUsable(db: Database, segmentIds: readonly string[]): Promise<void> {
    if (segmentIds.length === 0) return;
    const definitions = await readSegmentDefinitions(db, segmentIds);
    const missing = segmentIds.filter((id) => !definitions.get(id));
    if (missing.length > 0) {
        throw new ValidationError(
            "A customer segment you chose no longer exists. Reload the segments and choose again.",
            { customerSegmentIds: missing },
        );
    }
}

function buildSegmentLinkInserts(db: Database, promotionId: string, input: PromotionRule): BatchItem<"sqlite">[] {
    if (input.customerSegmentIds.length === 0) return [];
    return [db.insert(promotionCustomerSegments).values(input.customerSegmentIds.map((segmentId) => ({
        promotionId,
        segmentId,
        createdAt: sql`unixepoch()`,
    })))];
}

function combinesWithColumns(input: PromotionRule) {
    return {
        combinesWithProductDiscounts: input.combinesWith.product,
        combinesWithOrderDiscounts: input.combinesWith.order,
        combinesWithShippingDiscounts: input.combinesWith.shipping,
    };
}

function buildCodeRows(promotionId: string, input: PromotionRule) {
    return input.codes.map(({ code, isActive }) => ({
        id: `pcode_${nanoid()}`,
        promotionId,
        code,
        normalizedCode: code,
        isActive,
        createdAt: sql`unixepoch()`,
    }));
}

function buildConditionRows(promotionId: string, input: PromotionRule) {
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
    effect: PromotionRule["effects"][number],
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
    input: PromotionRule,
): BatchItem<"sqlite">[] {
    const statements: BatchItem<"sqlite">[] = [];
    for (const rows of chunkForD1(buildCodeRows(promotionId, input), CHILD_INSERT_CHUNK_SIZE)) {
        if (rows.length > 0) statements.push(db.insert(promotionCodes).values(rows));
    }
    for (const rows of chunkForD1(buildConditionRows(promotionId, input), CHILD_INSERT_CHUNK_SIZE)) {
        if (rows.length > 0) statements.push(db.insert(promotionConditions).values(rows));
    }
    for (const rows of chunkForD1(
        input.effects.map((effect, position) => buildEffectInsertRow(promotionId, effect, position)),
        CHILD_INSERT_CHUNK_SIZE,
    )) {
        if (rows.length > 0) statements.push(db.insert(promotionEffects).values(rows));
    }
    statements.push(...buildSegmentLinkInserts(db, promotionId, input));
    return statements;
}

/** Every amount of the rule is on its currency's price increment (the store's for the store currency). */
async function assertPromotionAmountsOnIncrement(db: Database, rule: PromotionRule): Promise<void> {
    const store = await readStoreCurrency(db);
    const issues = promotionAmountIssues(rule, (currencyCode) => priceIncrementForCurrency(store, currencyCode));
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, { issues });
}

export async function createPromotionDraft(
    db: Database,
    rawInput: CreatePromotionDraftInput,
): Promise<{ id: string; revision: number; status: "draft" }> {
    const input = createPromotionDraftSchema.parse(rawInput);
    await assertPromotionAmountsOnIncrement(db, input);
    await assertCodeIdentitiesAvailable(db, input.codes.map(({ code }) => code));
    await assertCustomerSegmentsUsable(db, input.customerSegmentIds);

    const id = `promo_${nanoid()}`;
    const parentInsert = db.insert(promotions).values({
        id,
        name: input.name,
        title: input.title,
        method: input.method,
        status: "draft",
        priority: input.priority,
        conflictPolicy: input.conflictPolicy,
        ...combinesWithColumns(input),
        startsAt: fromIso(input.startsAt),
        endsAt: fromIso(input.endsAt),
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
            throw new ConflictError("This discount code is already in use.");
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
    const [parentRows, codeRows, conditionRows, effectRows, segmentRows] = await db.batch([
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
        db.select({ segmentId: promotionCustomerSegments.segmentId })
            .from(promotionCustomerSegments)
            .where(eq(promotionCustomerSegments.promotionId, normalizedId)),
    ]);
    const parent = parentRows[0];
    if (!parent) return null;

    return buildPromotionAggregate(parent, codeRows, conditionRows, effectRows, segmentRows);
}

/** The discounts list's views (the dashboard's tabs), as the list's status words read them. */
export const PROMOTION_LIST_VIEWS = ["active", "scheduled", "expired"] as const;
export type PromotionListView = (typeof PROMOTION_LIST_VIEWS)[number];
export const PROMOTION_LIST_SORTS = ["updated", "titleAsc", "titleDesc"] as const;
export type PromotionListSort = (typeof PROMOTION_LIST_SORTS)[number];

/** A list row: the rule with its first code only, and how many codes it has. */
export type PromotionListItem = PromotionAggregate & { codeCount: number };

/**
 * The view's condition at `now` (epoch seconds), the same words as the
 * dashboard's status badge: active (on and started), scheduled (on, starts
 * later), expired (on or draft, its end passed).
 */
function promotionViewCondition(view: PromotionListView) {
    const now = sql`unixepoch()`;
    const notEnded = sql`(${promotions.endsAt} IS NULL OR ${promotions.endsAt} > ${now})`;
    if (view === "active") {
        return sql`${promotions.status} = 'active' AND ${notEnded} AND (${promotions.startsAt} IS NULL OR ${promotions.startsAt} <= ${now})`;
    }
    if (view === "scheduled") return sql`${promotions.status} = 'active' AND ${notEnded} AND ${promotions.startsAt} > ${now}`;
    return sql`${promotions.status} IN ('active', 'draft') AND ${promotions.endsAt} <= ${now}`;
}

/**
 * Matches a discount's name or title anywhere, or one of its codes from the
 * start: codes are upper-case, so a prefix is one seek on the code index
 * (a bulk-generated discount can hold thousands of codes).
 */
function promotionSearchCondition(term: string) {
    const code = term.trim().toUpperCase();
    const byCode = /^[A-Z0-9_-]{1,50}$/.test(code)
        ? sql` OR ${promotions.id} IN (SELECT ${promotionCodes.promotionId} FROM ${promotionCodes} WHERE ${promotionCodes.normalizedCode} >= ${code} AND ${promotionCodes.normalizedCode} < ${`${code}~`})`
        : sql``;
    return sql`(${containsText(promotions.name, term)} OR ${containsText(sql`coalesce(${promotions.title}, '')`, term)}${byCode})`;
}

/**
 * One page of the dashboard's discounts list: searched, filtered by view and
 * sorted in SQL, counted (capped as every list), and each row with only its
 * first code and the count of the rest, so a discount with 10,000
 * bulk-generated codes costs one row.
 */
export async function listPromotionPage(
    db: Database,
    input: {
        page?: number;
        limit?: number;
        search?: string;
        view?: PromotionListView;
        sort?: PromotionListSort;
        includeDeleted?: boolean;
    } = {},
): Promise<{ discounts: PromotionListItem[]; pagination: ReturnType<typeof cappedPagination> }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), PROMOTION_LIST_LIMIT);
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const offset = (page - 1) * limit;
    const { maxOffset } = planLimits().lists;
    if (offset >= maxOffset) throw tooDeepPage(offset, maxOffset);
    const conditions = [
        ...(input.includeDeleted ? [] : [isNull(promotions.deletedAt)]),
        ...(input.view ? [promotionViewCondition(input.view)] : []),
        ...(input.search?.trim() ? [promotionSearchCondition(input.search.trim())] : []),
    ];
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const orderBy = input.sort === "titleAsc"
        ? [asc(promotions.name), asc(promotions.id)]
        : input.sort === "titleDesc"
            ? [desc(promotions.name), asc(promotions.id)]
            : [desc(promotions.updatedAt), asc(promotions.id)];
    const [counted, rows] = await db.batch([
        cappedCountQuery(db, db.select(COUNT_PROBE_COLUMN).from(promotions).where(where).$dynamic()),
        db.select().from(promotions).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    ]);
    const pagination = cappedPagination(Number(counted[0]?.count ?? 0), offset, limit);
    if (rows.length === 0) return { discounts: [], pagination };

    const ids = rows.map(({ id }) => id);
    const idSet = JSON.stringify(ids);
    const inPage = (column: typeof promotionCodes.promotionId) => sql`${column} IN (SELECT CAST(value AS TEXT) FROM json_each(${idSet}))`;
    const [codeRows, codeCounts, conditionRows, effectRows, segmentRows, usageRows] = await db.batch([
        // Each discount's first code (the one the list names it by).
        db.select().from(promotionCodes).where(sql`(${promotionCodes.promotionId}, ${promotionCodes.normalizedCode}) IN (
            SELECT ${promotionCodes.promotionId}, min(${promotionCodes.normalizedCode}) FROM ${promotionCodes}
            WHERE ${inPage(promotionCodes.promotionId)} GROUP BY ${promotionCodes.promotionId})`),
        db.select({ promotionId: promotionCodes.promotionId, count: count() })
            .from(promotionCodes)
            .where(inPage(promotionCodes.promotionId))
            .groupBy(promotionCodes.promotionId),
        db.select().from(promotionConditions)
            .where(inArray(promotionConditions.promotionId, ids))
            .orderBy(asc(promotionConditions.position), asc(promotionConditions.id)),
        db.select().from(promotionEffects)
            .where(and(
                inArray(promotionEffects.promotionId, ids),
                isNull(promotionEffects.deletedAt),
            ))
            .orderBy(asc(promotionEffects.position), asc(promotionEffects.id)),
        db.select({ promotionId: promotionCustomerSegments.promotionId, segmentId: promotionCustomerSegments.segmentId })
            .from(promotionCustomerSegments)
            .where(inArray(promotionCustomerSegments.promotionId, ids)),
        orderUsageQuery(db, ids),
    ]);
    const usageByPromotionId = new Map(usageRows.map((usage) => [usage.promotionId, usage]));
    const codeCountById = new Map(codeCounts.map((row) => [row.promotionId, Number(row.count)]));

    const discounts = rows.flatMap((parent): PromotionListItem[] => {
        let aggregate: PromotionAggregate;
        try {
            aggregate = buildPromotionAggregate(
                parent,
                codeRows.filter((code) => code.promotionId === parent.id),
                conditionRows.filter((condition) => condition.promotionId === parent.id),
                effectRows.filter((effect) => effect.promotionId === parent.id),
                segmentRows.filter((segment) => segment.promotionId === parent.id),
            );
        } catch {
            // A rule the evaluator cannot read never applies; keep the list usable.
            return [];
        }
        const usage = usageByPromotionId.get(parent.id);
        return [{
            ...aggregate,
            redemptionCount: Number(usage?.redemptionCount ?? 0),
            discountSpendMinor: Number(usage?.discountSpendMinor ?? 0),
            codeCount: codeCountById.get(parent.id) ?? 0,
        }];
    });
    return { discounts, pagination };
}

/** The first page of discounts, newest edits first (tests and simple callers). */
export async function listPromotionDrafts(
    db: Database,
    input: { limit?: number; includeDeleted?: boolean } = {},
): Promise<PromotionListItem[]> {
    return (await listPromotionPage(db, input)).discounts;
}

/**
 * Orders and savings per discount. Allocations cover code and automatic
 * discounts alike (a code order's allocations always sum to its claim).
 */
function orderUsageQuery(db: Database, ids: string[]) {
    return db.select({
        promotionId: orderDiscountAllocations.promotionId,
        redemptionCount: sql<number>`count(DISTINCT ${orderDiscountAllocations.orderId})`,
        discountSpendMinor: sql<number>`coalesce(sum(${orderDiscountAllocations.discountAmountMinor}), 0)`,
    }).from(orderDiscountAllocations)
        .where(inArray(orderDiscountAllocations.promotionId, ids))
        .groupBy(orderDiscountAllocations.promotionId);
}

export async function getPromotionOrderUsage(
    db: Database,
    promotionId: string,
): Promise<{ redemptionCount: number; discountSpendMinor: number }> {
    const [usage] = await orderUsageQuery(db, [promotionId]);
    return {
        redemptionCount: Number(usage?.redemptionCount ?? 0),
        discountSpendMinor: Number(usage?.discountSpendMinor ?? 0),
    };
}

export async function updatePromotionDraft(
    db: Database,
    promotionId: string,
    rawInput: UpdatePromotionDraftInput,
): Promise<{ id: string; revision: number; status: PromotionStatus }> {
    const input = updatePromotionDraftSchema.parse(rawInput);
    await assertPromotionAmountsOnIncrement(db, input);
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
    await assertCustomerSegmentsUsable(db, input.customerSegmentIds);

    const allEffectRows = await db.select({
        id: promotionEffects.id,
        target: promotionEffects.target,
    }).from(promotionEffects).where(eq(promotionEffects.promotionId, promotionId));
    const existingEffectByTarget = new Map(allEffectRows.map((row) => [row.target, row]));

    const statements: BatchItem<"sqlite">[] = [
        db.delete(promotionCodes).where(eq(promotionCodes.promotionId, promotionId)),
        db.delete(promotionConditions).where(eq(promotionConditions.promotionId, promotionId)),
        db.delete(promotionCustomerSegments).where(eq(promotionCustomerSegments.promotionId, promotionId)),
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
            ...combinesWithColumns(input),
            startsAt: fromIso(input.startsAt),
            endsAt: fromIso(input.endsAt),
            timezone: input.timezone,
            maxRedemptions: input.maxRedemptions,
            maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer,
            maxDiscountSpendMinor: input.maxDiscountSpendMinor,
            budgetCurrencyCode: input.budgetCurrencyCode,
            updatedAt: sql`unixepoch()`,
        }).where(eq(promotions.id, promotionId)),
    ];

    for (const rows of chunkForD1(buildCodeRows(promotionId, input), CHILD_INSERT_CHUNK_SIZE)) {
        if (rows.length > 0) statements.push(db.insert(promotionCodes).values(rows));
    }
    for (const rows of chunkForD1(buildConditionRows(promotionId, input), CHILD_INSERT_CHUNK_SIZE)) {
        if (rows.length > 0) statements.push(db.insert(promotionConditions).values(rows));
    }
    statements.push(...buildSegmentLinkInserts(db, promotionId, input));
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
            throw new ConflictError("This discount code is already in use.");
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

    const [usage, segmentsMatched] = await Promise.all([
        getPromotionUsageStats(db, promotion.id, input.customerId ?? null),
        // The previewed customer counts as signed in; without one, a promotion
        // limited to segments previews as it would for a guest.
        matchCustomerSegments(db, input.customerId, promotion.customerSegmentIds),
    ]);
    const assumedActive = promotion.status !== "active";
    // A preview without an increment prices like checkout: at the store's.
    const cart = input.cart && typeof input.cart === "object" && !("priceIncrementMinor" in input.cart)
        && typeof (input.cart as { currencyCode?: unknown }).currencyCode === "string"
        ? {
            ...input.cart,
            priceIncrementMinor: priceIncrementForCurrency(
                await readStoreCurrency(db),
                (input.cart as { currencyCode: string }).currencyCode,
            ),
        }
        : input.cart;
    const result = evaluatePromotionCandidates({
        cart,
        candidates: [{
            ...promotion,
            ...usage,
            customerInSegment: segmentsMatched.size > 0,
            status: "active",
        }],
    });
    return {
        ...result,
        assumedActive,
        promotionRevision: promotion.revision,
    };
}
