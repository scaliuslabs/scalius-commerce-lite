// Customer segments (Customers & marketing): saved filters over customers,
// evaluated live. A definition compiles to one WHERE over `customers` LEFT
// JOIN `customer_order_stats` (trigger-maintained, indexed), with every value
// list bound as a single JSON value (`json_each`), so a definition with the
// maximum 12 conditions binds at most 36 values (D1 allows 100). Counts are
// one bounded query that stops at CUSTOMER_SEGMENT_COUNT_CAP; members are read
// a page at a time; membership of one customer is a primary-key lookup.
//
// Segments are soft-deleted only: a promotion that targeted a deleted segment
// keeps a valid reference and matches nobody (fail closed).

import type { Database } from "@scalius/database/client";
import {
    customFieldDefinitions,
    customerOrderStats,
    customerSegments,
    customers,
    promotionCustomerSegments,
    promotions,
} from "@scalius/database/schema";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { commerceDayStart } from "@scalius/shared/commerce-time";
import { currentStoreTimeZone } from "../../utils/store-time-zone";
import {
    CUSTOMER_SEGMENT_COUNT_CAP,
    canonicalSegmentDefinitionJson,
    customerSegmentDefinitionSchema,
    type CustomerSegmentCondition,
    type CustomerSegmentDateFilter,
    type CustomerSegmentDefinition,
    type MarketingChannel,
} from "@scalius/shared/customer-marketing";
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";

const DAY_SECONDS = 24 * 60 * 60;

export interface SegmentEvaluationContext {
    /** Epoch seconds that relative date filters count back from. */
    nowSeconds: number;
    /** The store's zone: a calendar-date filter starts at that day's first instant in it. */
    timeZone: string;
}

const now = (): SegmentEvaluationContext => ({ nowSeconds: Math.floor(Date.now() / 1000), timeZone: currentStoreTimeZone() });

/**
 * The outer customer row, spelled out for correlated subqueries: drizzle
 * leaves a single-table query's columns bare, and a bare name inside a
 * subquery binds to the subquery's own table first. Segment SQL always runs
 * over the unaliased `customers` table.
 */
const QUALIFIED = {
    id: sql.raw(`"customers"."id"`),
    email: sql.raw(`"customers"."email"`),
    phone: sql.raw(`"customers"."phone"`),
};

/** The customer's current address for a channel, as consent rows store it. */
export function currentMarketingContactSql(channel: MarketingChannel): SQL {
    if (channel === "push") return sql`CASE WHEN "customers"."account_claimed_at" IS NOT NULL THEN ${QUALIFIED.id} END`;
    return channel === "email" ? sql`nullif(lower(trim(${QUALIFIED.email})), '')` : sql`nullif(${QUALIFIED.phone}, ${NO_PHONE})`;
}

function dateFilterSql(column: SQL, filter: CustomerSegmentDateFilter, context: SegmentEvaluationContext): SQL {
    switch (filter.op) {
        case "within_last":
            return sql`${column} >= ${context.nowSeconds - filter.days * DAY_SECONDS}`;
        case "not_within_last":
            return sql`${column} < ${context.nowSeconds - filter.days * DAY_SECONDS}`;
        case "on_or_after":
            return sql`${column} >= ${commerceDayStart(context.timeZone, filter.date)}`;
        case "before":
            return sql`${column} < ${commerceDayStart(context.timeZone, filter.date)}`;
    }
}

function rangeSql(column: SQL, range: { min?: number; max?: number }): SQL {
    const parts: SQL[] = [];
    if (range.min !== undefined) parts.push(sql`${column} >= ${range.min}`);
    if (range.max !== undefined) parts.push(sql`${column} <= ${range.max}`);
    return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` AND `)})`;
}

const jsonList = (values: readonly string[]) => sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** One condition over `customers` (and the LEFT JOINed `customer_order_stats`). */
export function segmentConditionSql(condition: CustomerSegmentCondition, context: SegmentEvaluationContext): SQL {
    switch (condition.field) {
        case "amount_spent":
            return rangeSql(sql`COALESCE(${customerOrderStats.totalSpentMinor}, 0)`, condition);
        case "orders_count":
            return rangeSql(sql`COALESCE(${customerOrderStats.ordersCount}, 0)`, condition);
        case "last_order_date":
            return dateFilterSql(sql`${customerOrderStats.lastOrderAt}`, condition.filter, context);
        case "first_order_date":
            return dateFilterSql(sql`${customerOrderStats.firstOrderAt}`, condition.filter, context);
        case "customer_since":
            return dateFilterSql(sql`CAST(${customers.createdAt} AS INTEGER)`, condition.filter, context);
        case "city":
        case "zone": {
            // The default address's delivery location (Shopify's customer_cities reads the default address).
            const column = sql.raw(condition.field === "city" ? "segment_address.city" : "segment_address.zone");
            const located = sql`SELECT 1 FROM customer_addresses AS segment_address WHERE segment_address.customer_id = ${QUALIFIED.id} AND segment_address.is_default = 1 AND ${column} IN ${jsonList(condition.ids)}`;
            return condition.op === "in" ? sql`EXISTS (${located})` : sql`NOT EXISTS (${located})`;
        }
        case "tags": {
            const matching = sql`SELECT 1 FROM customer_tag_links AS segment_tag WHERE segment_tag.customer_id = ${QUALIFIED.id} AND segment_tag.tag IN ${jsonList(condition.tags)}`;
            if (condition.op === "has_any") return sql`EXISTS (${matching})`;
            if (condition.op === "has_none") return sql`NOT EXISTS (${matching})`;
            const unique = [...new Set(condition.tags)];
            return sql`(SELECT count(*) FROM customer_tag_links AS segment_tag WHERE segment_tag.customer_id = ${QUALIFIED.id} AND segment_tag.tag IN ${jsonList(unique)}) = ${unique.length}`;
        }
        case "marketing_consent": {
            const current = currentMarketingContactSql(condition.channel);
            const covering = sql`SELECT 1 FROM customer_marketing_consents AS segment_consent WHERE segment_consent.customer_id = ${QUALIFIED.id} AND segment_consent.channel = ${condition.channel} AND segment_consent.contact = ${current}`;
            return condition.status === "not_subscribed"
                ? sql`NOT EXISTS (${covering})`
                : sql`EXISTS (${covering} AND segment_consent.state = ${condition.status})`;
        }
        case "customer_type": {
            const parts = condition.types.map((type) => type === "account"
                ? sql`${customers.accountClaimedAt} IS NOT NULL`
                : type === "merchant"
                    ? sql`(${customers.accountClaimedAt} IS NULL AND ${customers.origin} = 'merchant')`
                    : sql`(${customers.accountClaimedAt} IS NULL AND ${customers.origin} <> 'merchant')`);
            return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` OR `)})`;
        }
        case "custom_field": {
            const value = sql`SELECT 1 FROM custom_field_values AS segment_field WHERE segment_field.definition_id = ${condition.definitionId} AND segment_field.owner_id = ${QUALIFIED.id} AND segment_field.owner_type = 'customer'`;
            if (condition.op === "is_set") return sql`EXISTS (${value})`;
            if (condition.op === "is_not_set") return sql`NOT EXISTS (${value})`;
            return sql`EXISTS (${value} AND segment_field.value = ${condition.value ?? ""})`;
        }
    }
}

/** The whole definition (live customers only). */
export function segmentWhereSql(definition: CustomerSegmentDefinition, context: SegmentEvaluationContext = now()): SQL {
    const parts = definition.conditions.map((condition) => segmentConditionSql(condition, context));
    const joined = sql.join(parts, definition.match === "any" ? sql` OR ` : sql` AND `);
    return sql`(${customers.deletedAt} IS NULL AND (${joined}))`;
}

/** Parses a definition (stored or from a request), with the store's references checked. */
export async function parseSegmentDefinition(db: Database, raw: unknown): Promise<CustomerSegmentDefinition> {
    const parsed = customerSegmentDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ValidationError("This segment's filters are not valid.", { issues: parsed.error.issues.slice(0, 10) });
    }
    const definitionIds = [...new Set(parsed.data.conditions.flatMap((condition) =>
        condition.field === "custom_field" ? [condition.definitionId] : []))];
    if (definitionIds.length > 0) {
        const found = await db.select({ id: customFieldDefinitions.id }).from(customFieldDefinitions)
            .where(and(inArray(customFieldDefinitions.id, definitionIds), eq(customFieldDefinitions.ownerType, "customer")));
        const known = new Set(found.map((row) => row.id));
        const missing = definitionIds.filter((id) => !known.has(id));
        if (missing.length > 0) throw new ValidationError("A filter uses a customer field that does not exist.", { definitionIds: missing });
    }
    return parsed.data;
}

/** A stored definition, or null when it no longer parses (a deleted segment matches nobody). */
export function readStoredSegmentDefinition(json: string): CustomerSegmentDefinition | null {
    try {
        const parsed = customerSegmentDefinitionSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

const fromCustomers = (db: Database) => db.select({ id: customers.id }).from(customers)
    .leftJoin(customerOrderStats, eq(customerOrderStats.customerId, customers.id));

/** Live member count, stopping at the cap (`capped` then means "at least"). */
export async function countSegmentMembers(
    db: Database,
    definition: CustomerSegmentDefinition,
    context: SegmentEvaluationContext = now(),
): Promise<{ count: number; capped: boolean }> {
    const bounded = fromCustomers(db).where(segmentWhereSql(definition, context)).limit(CUSTOMER_SEGMENT_COUNT_CAP + 1).as("bounded");
    const row = await db.select({ count: sql<number>`CAST(count(*) AS INTEGER)` }).from(bounded).get();
    const count = Number(row?.count ?? 0);
    return count > CUSTOMER_SEGMENT_COUNT_CAP
        ? { count: CUSTOMER_SEGMENT_COUNT_CAP, capped: true }
        : { count, capped: false };
}

/**
 * Member ids after `afterId` in id order, one page (exports and plugins
 * walk a whole segment this way without offsets).
 */
export async function listSegmentMemberIds(
    db: Database,
    definition: CustomerSegmentDefinition,
    options: { afterId?: string | null; limit?: number } & Partial<SegmentEvaluationContext> = {},
): Promise<string[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const context = { ...now(), ...options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds }, ...options.timeZone === undefined ? {} : { timeZone: options.timeZone } };
    const rows = await fromCustomers(db)
        .where(and(segmentWhereSql(definition, context), options.afterId ? sql`${customers.id} > ${options.afterId}` : undefined))
        .orderBy(asc(customers.id))
        .limit(limit);
    return rows.map((row) => row.id);
}

/**
 * Which of these segments one customer is in now. One query per segment, in
 * one batch; a segment whose definition no longer parses matches nobody.
 */
export async function customerSegmentMembership(
    db: Database,
    customerId: string,
    segments: ReadonlyArray<{ id: string; definition: CustomerSegmentDefinition | null }>,
    context: SegmentEvaluationContext = now(),
): Promise<Set<string>> {
    const live = segments.filter((segment): segment is { id: string; definition: CustomerSegmentDefinition } => segment.definition !== null);
    if (live.length === 0) return new Set();
    const statements = live.map((segment) => db.select({ id: sql<string>`${segment.id}` }).from(customers)
        .leftJoin(customerOrderStats, eq(customerOrderStats.customerId, customers.id))
        .where(and(eq(customers.id, customerId), segmentWhereSql(segment.definition, context)))
        .limit(1));
    const results = await db.batch(statements as unknown as Parameters<Database["batch"]>[0]) as unknown as Array<Array<{ id: string }>>;
    const members = new Set<string>();
    results.forEach((rows, index) => {
        if (rows.length > 0) members.add(live[index]!.id);
    });
    return members;
}

// ── Saved segments ───────────────────────────────────────────────────────

export interface CustomerSegmentRecord {
    id: string;
    name: string;
    description: string | null;
    definition: CustomerSegmentDefinition;
    revision: number;
    createdAt: string;
    updatedAt: string;
    /** Promotions (not archived) limited to this segment. */
    promotionCount: number;
}

const iso = (seconds: number) => new Date(Number(seconds) * 1000).toISOString();

function toRecord(row: typeof customerSegments.$inferSelect, promotionCount: number): CustomerSegmentRecord | null {
    const definition = readStoredSegmentDefinition(row.definition);
    if (!definition) return null;
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        definition,
        revision: row.revision,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        promotionCount,
    };
}

// Spelled out: drizzle leaves columns of a single-table query unqualified,
// and an unqualified `id` inside this subquery would bind to `promotions.id`.
const livePromotionUse = sql<number>`CAST((SELECT count(*) FROM promotion_customer_segments AS used_by
    JOIN promotions AS using_promotion ON using_promotion.id = used_by.promotion_id
    WHERE used_by.segment_id = customer_segments.id AND using_promotion.deleted_at IS NULL AND using_promotion.status <> 'archived') AS INTEGER)`;

export const CUSTOMER_SEGMENTS_MAX = 200;

/** Every live segment, most recently changed first (a store keeps at most 200). */
export async function listCustomerSegments(db: Database): Promise<CustomerSegmentRecord[]> {
    const rows = await db.select({ segment: customerSegments, promotionCount: livePromotionUse })
        .from(customerSegments)
        .where(isNull(customerSegments.deletedAt))
        .orderBy(desc(customerSegments.updatedAt), asc(customerSegments.id))
        .limit(CUSTOMER_SEGMENTS_MAX);
    return rows.flatMap((row) => toRecord(row.segment, Number(row.promotionCount)) ?? []);
}

export async function getCustomerSegment(db: Database, id: string): Promise<CustomerSegmentRecord> {
    const row = await db.select({ segment: customerSegments, promotionCount: livePromotionUse })
        .from(customerSegments)
        .where(and(eq(customerSegments.id, id), isNull(customerSegments.deletedAt)))
        .get();
    const record = row ? toRecord(row.segment, Number(row.promotionCount)) : null;
    if (!record) throw new NotFoundError("Segment not found");
    return record;
}

function cleanName(name: string): string {
    const value = name.normalize("NFC").replace(/\s+/g, " ").trim();
    if (value.length < 1 || value.length > 80) throw new ValidationError("A segment name is 1 to 80 characters.");
    return value;
}

function cleanDescription(description: string | null | undefined): string | null {
    const value = description?.normalize("NFC").trim();
    if (!value) return null;
    if (value.length > 300) throw new ValidationError("A description is at most 300 characters.");
    return value;
}

async function requireFreeName(db: Database, name: string, exceptId?: string): Promise<void> {
    const taken = await db.select({ id: customerSegments.id }).from(customerSegments)
        .where(and(
            sql`lower(${customerSegments.name}) = lower(${name})`,
            isNull(customerSegments.deletedAt),
            exceptId ? ne(customerSegments.id, exceptId) : undefined,
        ))
        .get();
    if (taken) throw new ConflictError("Another segment has this name.");
}

export async function createCustomerSegment(
    db: Database,
    input: { name: string; description?: string | null; definition: unknown },
    actorId: string | null,
): Promise<CustomerSegmentRecord> {
    const name = cleanName(input.name);
    const definition = await parseSegmentDefinition(db, input.definition);
    await requireFreeName(db, name);
    const live = await db.select({ count: sql<number>`CAST(count(*) AS INTEGER)` }).from(customerSegments)
        .where(isNull(customerSegments.deletedAt)).get();
    if (Number(live?.count ?? 0) >= CUSTOMER_SEGMENTS_MAX) {
        throw new ValidationError(`A store keeps at most ${CUSTOMER_SEGMENTS_MAX} segments.`);
    }
    const id = `seg_${nanoid(16)}`;
    try {
        await db.insert(customerSegments).values({
            id,
            name,
            description: cleanDescription(input.description),
            definition: canonicalSegmentDefinitionJson(definition),
            revision: 1,
            createdBy: actorId,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        });
    } catch (error) {
        if (/UNIQUE/i.test(String((error as Error)?.message ?? error))) throw new ConflictError("Another segment has this name.");
        throw error;
    }
    return getCustomerSegment(db, id);
}

export async function updateCustomerSegment(
    db: Database,
    id: string,
    input: { expectedRevision: number; name?: string; description?: string | null; definition?: unknown },
): Promise<CustomerSegmentRecord> {
    const current = await getCustomerSegment(db, id);
    const name = input.name === undefined ? current.name : cleanName(input.name);
    if (name.toLowerCase() !== current.name.toLowerCase()) await requireFreeName(db, name, id);
    const definition = input.definition === undefined ? current.definition : await parseSegmentDefinition(db, input.definition);
    const updated = await db.update(customerSegments)
        .set({
            name,
            description: input.description === undefined ? current.description : cleanDescription(input.description),
            definition: canonicalSegmentDefinitionJson(definition),
            revision: sql`${customerSegments.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(customerSegments.id, id),
            eq(customerSegments.revision, input.expectedRevision),
            isNull(customerSegments.deletedAt),
        ))
        .returning({ id: customerSegments.id });
    if (updated.length === 0) throw new ConflictError("This segment changed since you opened it. Reload it and try again.");
    return getCustomerSegment(db, id);
}

/** Soft delete; refused while a live (not archived) promotion is limited to it. */
export async function deleteCustomerSegment(db: Database, id: string): Promise<void> {
    const current = await getCustomerSegment(db, id);
    if (current.promotionCount > 0) {
        throw new ConflictError("Discounts are limited to this segment. Remove it from them first.");
    }
    // A price list for the segment's members (0120) keeps it too.
    const priced = await db.select({ id: sql<string>`segment_price_list.id` })
        .from(sql`price_lists AS segment_price_list`)
        .where(sql`segment_price_list.segment_id = ${id}`)
        .limit(1);
    if (priced.length > 0) {
        throw new ConflictError("A price list prices this segment. Delete that price list first.");
    }
    await db.update(customerSegments)
        .set({ deletedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
        .where(and(
            eq(customerSegments.id, id),
            isNull(customerSegments.deletedAt),
            sql`NOT EXISTS (SELECT 1 FROM ${promotionCustomerSegments} JOIN ${promotions} ON ${promotions.id} = ${promotionCustomerSegments.promotionId}
                WHERE ${promotionCustomerSegments.segmentId} = ${id} AND ${promotions.deletedAt} IS NULL AND ${promotions.status} <> 'archived')`,
            sql`NOT EXISTS (SELECT 1 FROM price_lists AS segment_price_list WHERE segment_price_list.segment_id = ${id})`,
        ));
}

/** Stored definitions of these segments (deleted or unreadable ones are null: they match nobody). */
export async function readSegmentDefinitions(
    db: Database,
    ids: readonly string[],
): Promise<Map<string, CustomerSegmentDefinition | null>> {
    const result = new Map<string, CustomerSegmentDefinition | null>();
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += 90) {
        const rows = await db.select({ id: customerSegments.id, definition: customerSegments.definition, deletedAt: customerSegments.deletedAt })
            .from(customerSegments)
            .where(inArray(customerSegments.id, unique.slice(start, start + 90)));
        for (const row of rows) result.set(row.id, row.deletedAt === null ? readStoredSegmentDefinition(row.definition) : null);
    }
    for (const id of unique) if (!result.has(id)) result.set(id, null);
    return result;
}
