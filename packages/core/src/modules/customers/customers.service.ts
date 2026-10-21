// src/modules/customers/customers.service.ts
// All DB queries and business logic for the customers domain.

import {
    customerAddresses,
    customerMarketingConsents,
    customerOrderStats,
    customerTagLinks,
    customers,
    customerHistory,
    customerSessions,
    firstCustomerAddressId,
    orders,
} from "@scalius/database/schema";
import { sql, isNull, asc, desc, eq, and, or, inArray, getTableColumns, type SQL, type SQLWrapper } from "drizzle-orm";
import { BULK_MATCHING_SLICE, matchingSliceCondition, nextMatchingCursor } from "../../utils/bulk-matching";
import { alias } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import { fromMinor } from "@scalius/shared/money";
import { customerKind, guestRecordForContact, normalizeContactEmail } from "./customer-identity";
import { storedPhone } from "@scalius/shared/customer-auth-policy";
import { currentMarketingContactSql, segmentWhereSql } from "./customer-segments";
import {
    MARKETING_CHANNELS,
    marketingConsentContact,
    marketingConsentStatus,
    type CustomerSegmentDefinition,
    type MarketingChannel,
} from "@scalius/shared/customer-marketing";
import { listCustomerTags } from "./customer-tags";
import { searchKeyColumn, searchKeys, searchPrefixKeys } from "../../search";
import { buildPhoneSearchTerms, isLikelyPhoneSearch } from "../../utils/phone-search";
import { anySetIsSmall } from "../../utils/list-lead";
import type { CursorValueKind } from "@scalius/shared/pagination";
import {
    COUNT_PROBE_COLUMN,
    cappedCountQuery,
    cappedPagination,
    planKeysetPage,
    resolveReferencedBoundary,
} from "../../utils/keyset";
import { type Database, getDatabaseProviderForClient } from "@scalius/database/client";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { customerAuthDocument, validateCustomerPhoneCountry } from "../settings";
import { customerAddressColumns, listCustomerAddresses, resolveAddress } from "./addresses";

// Re-export schemas from the canonical validation module
export {
    addressInputSchema,
    customerAddressInputSchema,
    createCustomerSchema,
    updateCustomerSchema,
    type AddressInputBody,
    type CustomerAddressInputBody,
    type CreateCustomerInput,
    type UpdateCustomerInput,
} from "./customers.validation";
import type { CreateCustomerInput, UpdateCustomerInput } from "./customers.validation";

/** The customer's default address (the address book's one default row). */
const defaultAddress = alias(customerAddresses, "default_address");

/**
 * Paid spend summed exactly in minor units. A store has one currency (it is
 * locked once orders exist), so the orders' own decimal places convert it.
 */
export function paidSpendProjection() {
    return {
        totalSpentMinor: sql<number>`COALESCE(SUM(CASE WHEN ${orders.paidAmountMinor} > 0 THEN ${orders.paidAmountMinor} ELSE 0 END), 0)`,
        spendDecimalPlaces: sql<number>`COALESCE(MAX(${orders.currencyDecimalPlaces}), 2)`,
    };
}

export function paidSpendAmount(row: { totalSpentMinor: number; spendDecimalPlaces: number }): number {
    return fromMinor(Number(row.totalSpentMinor), Number(row.spendDecimalPlaces));
}

export function buildCustomerOrderMetricsProjection() {
    return {
        totalOrders: sql<number>`CAST(count(${orders.id}) AS INTEGER)`,
        ...paidSpendProjection(),
        lastOrderAt: sql<number | null>`max(CAST(${orders.createdAt} AS INTEGER))`,
    };
}

// Drizzle renders a column unqualified in a single-table select, and an
// unqualified `id` inside the subquery binds to `orders.id`: the outer
// customer is always named by table.
const OUTER_CUSTOMER_ID = sql.raw('"customers"."id"');

/**
 * The name on the record's most recent order (a guest record's secondary
 * text), for a select over `customers`. One probe of
 * `orders_customer_activity_idx`.
 */
export function latestOrderNameSql() {
    return sql<string | null>`(SELECT ${orders.customerName} FROM ${orders} WHERE ${orders.customerId} = ${OUTER_CUSTOMER_ID} AND ${orders.deletedAt} IS NULL ORDER BY ${orders.createdAt} DESC, ${orders.orderNumber} DESC LIMIT 1)`;
}

/** Extra list filters (Customers & marketing): a tag, a segment's filters, a subscribed channel. */
export interface CustomerListFilters {
    /** Normalised tag the customer carries. */
    tag?: string;
    /** A segment definition (saved or inline) the customer must match. */
    segment?: CustomerSegmentDefinition;
    /** Customers subscribed on this channel now (`any`: on at least one). */
    subscribed?: MarketingChannel | "any";
}

/** The WHERE for the list filters (needs `customer_order_stats` LEFT JOINed). */
export function customerListFilterSql(filters: CustomerListFilters = {}): SQL[] {
    const conditions: SQL[] = [];
    if (filters.tag) {
        conditions.push(sql`EXISTS (SELECT 1 FROM ${customerTagLinks} WHERE ${customerTagLinks.customerId} = ${customers.id} AND ${customerTagLinks.tag} = ${filters.tag})`);
    }
    if (filters.segment) conditions.push(segmentWhereSql(filters.segment));
    if (filters.subscribed) {
        const channels = filters.subscribed === "any" ? MARKETING_CHANNELS : [filters.subscribed];
        const subscribed = channels.map((channel) => sql`EXISTS (SELECT 1 FROM ${customerMarketingConsents} WHERE ${customerMarketingConsents.customerId} = ${customers.id} AND ${customerMarketingConsents.channel} = ${channel} AND ${customerMarketingConsents.state} = 'subscribed' AND ${customerMarketingConsents.contact} = ${currentMarketingContactSql(channel)})`);
        conditions.push(sql`(${sql.join(subscribed, sql` OR `)})`);
    }
    return conditions;
}

/** The customers list's filters, shared by the list and its "all matching" bulk actions. */
export interface CustomerListFilter {
    search?: string;
    showTrashed?: boolean;
    filters?: CustomerListFilters;
    /** An app column filter (plugins/list-columns.ts): an indexed match on the app's records. */
    appCondition?: SQL;
    /** Read the customers a filter names first (`customerListLeads`). */
    leadWithMatches?: boolean;
}

/**
 * The keys (`searchKeyColumn`) of the customers a search finds: a word of
 * the name, phone or email, or the phone in any of its forms as a prefix
 * ("01712" finds +8801712…). Index lookups only, never a scan of every
 * customer.
 */
function customerSearchKeys(db: Database, term: string): SQL | undefined {
    const sources: SQL[] = [];
    const words = searchKeys(db, "customers", term);
    if (words) sources.push(words);
    const phoneTerms = isLikelyPhoneSearch(term) ? buildPhoneSearchTerms(term) : [];
    if (phoneTerms.length > 0) sources.push(searchPrefixKeys(db, "customers", "phone", phoneTerms));
    return sources.length > 0 ? sql.join(sources, sql` UNION `) : undefined;
}

/** The rowids of the customers a set names (`customerIds` selects `customer_id`), the set first. */
function namedCustomerRowids(customerIds: SQL): SQL {
    return sql`SELECT named_customer.rowid FROM (${customerIds}) AS named
        CROSS JOIN customers AS named_customer ON named_customer.id = named.customer_id`;
}

/**
 * The sets of customers the filters name, each an indexed read: the tag's
 * links, the channels' subscribed consents (a superset: the list's own
 * condition also checks the consent is for the current contact).
 */
function customerFilterSets(filters: CustomerListFilters = {}): SQL[] {
    const sets: SQL[] = [];
    if (filters.tag) {
        sets.push(namedCustomerRowids(sql`SELECT ${customerTagLinks.customerId} AS customer_id FROM ${customerTagLinks}
            WHERE ${customerTagLinks.tag} = ${filters.tag}`));
    }
    if (filters.subscribed) {
        const channels = filters.subscribed === "any" ? [...MARKETING_CHANNELS] : [filters.subscribed];
        sets.push(namedCustomerRowids(sql`SELECT ${customerMarketingConsents.customerId} AS customer_id FROM ${customerMarketingConsents}
            WHERE ${inArray(customerMarketingConsents.channel, channels)} AND ${customerMarketingConsents.state} = 'subscribed'`));
    }
    return sets;
}

/**
 * Whether a list read should start from a set of customers its filter names
 * (`utils/list-lead.ts`): the search's matches, a tag, or a channel's
 * subscribers, when one of them is small.
 */
export async function customerListLeads(db: Database, filter: CustomerListFilter): Promise<boolean> {
    if (getDatabaseProviderForClient(db) === "postgres") return false;
    const term = filter.search?.trim();
    const searchRowids = term ? customerSearchKeys(db, term) : undefined;
    return anySetIsSmall(db, [...(searchRowids ? [searchRowids] : []), ...customerFilterSets(filter.filters)]);
}

/** The list's WHERE conditions: the same rows for the list and for an "all matching" bulk action. */
export function customerListConditions(db: Database, filter: CustomerListFilter): SQL[] {
    const { search = "", showTrashed = false } = filter;
    const whereConditions: SQL[] = filter.appCondition ? [filter.appCondition] : [];
    // The list indexes start with `deleted_at`: the unary `+` keeps SQLite
    // off them when the list reads a named set first.
    const deletedAt = filter.leadWithMatches ? sql`+${customers.deletedAt}` : sql`${customers.deletedAt}`;
    if (showTrashed) {
        // A retired guest record (all its orders joined an account) is merged, not trashed.
        // Nearly every customer is unmerged: SQLite's `+` keeps it reading the trash by `deleted_at`.
        const unmerged = getDatabaseProviderForClient(db) === "postgres"
            ? sql`${customers.mergedIntoCustomerId} IS NULL`
            : sql`+${customers.mergedIntoCustomerId} IS NULL`;
        whereConditions.push(sql`${deletedAt} IS NOT NULL AND ${unmerged}`);
    } else {
        whereConditions.push(sql`${deletedAt} IS NULL`);
    }
    const term = search.trim();
    const keys = term ? customerSearchKeys(db, term) : undefined;
    if (keys) whereConditions.push(sql`customers.${sql.raw(searchKeyColumn(db))} IN (${keys})`);

    whereConditions.push(...customerListFilterSql(filter.filters));
    if (getDatabaseProviderForClient(db) !== "postgres") {
        for (const set of customerFilterSets(filter.filters)) whereConditions.push(sql`customers.rowid IN (${set})`);
    }
    return whereConditions;
}

/**
 * One slice of an "all matching" bulk action (`utils/bulk-matching.ts`): the
 * next `limit` customer ids the list's filter matches after `cursor`.
 * `deletableOnly` keeps to customers with no orders (only they can be
 * deleted permanently), so the walk never stops on a blocked row.
 */
export async function listMatchingCustomerIds(
    db: Database,
    filter: CustomerListFilter,
    cursor: string | undefined,
    limit: number = BULK_MATCHING_SLICE,
    options: { deletableOnly?: boolean } = {},
): Promise<{ ids: string[]; next: string | null }> {
    const conditions = customerListConditions(db, { ...filter, leadWithMatches: await customerListLeads(db, filter) });
    const after = matchingSliceCondition(customers.id, cursor);
    if (after) conditions.push(after);
    if (options.deletableOnly) {
        conditions.push(sql`NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.customerId} = ${customers.id})`);
        conditions.push(sql`NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.accountOwnerCustomerId} = ${customers.id})`);
    }
    // Filters read `customer_order_stats` (segments), as the list does.
    const rows = await db
        .select({ id: customers.id })
        .from(customers)
        .leftJoin(customerOrderStats, eq(customerOrderStats.customerId, customers.id))
        .where(and(...conditions))
        .orderBy(asc(customers.id))
        .limit(limit);
    return { ids: rows.map((row) => row.id), next: nextMatchingCursor(rows, limit) };
}

/** Restores several trashed customers one by one; a merged guest record stays merged and is reported. */
export async function bulkRestoreCustomers(db: Database, ids: readonly string[], actorId: string | null = null): Promise<{ restored: string[]; blocked: string[] }> {
    const restored: string[] = [];
    const blocked: string[] = [];
    for (const id of ids) {
        try {
            await restoreCustomer(db, id, actorId);
            restored.push(id);
        } catch (error) {
            if (!(error instanceof ValidationError) && !(error instanceof NotFoundError)) throw error;
            blocked.push(id);
        }
    }
    return { restored, blocked };
}

/**
 * Order facts come from `customer_order_stats` (trigger-maintained: real
 * orders only, not `incomplete` or deleted), so the list, its sorting and
 * segment filters read one indexed row per customer instead of grouping
 * every order.
 */
export async function listCustomers(
    db: Database,
    options: {
        page?: number;
        limit?: number;
        /** Rows after this cursor (`pageInfo.endCursor`); excludes `before` and `page` beyond 1. */
        after?: string;
        /** Rows before this cursor (`pageInfo.startCursor`). */
        before?: string;
        search?: string;
        showTrashed?: boolean;
        sort?: "name" | "totalOrders" | "totalSpent" | "lastOrderAt" | "createdAt" | "updatedAt";
        order?: "asc" | "desc";
        filters?: CustomerListFilters;
        /** An app column filter (plugins/list-columns.ts): an indexed match on the app's records. */
        appCondition?: SQL;
    } = {},
) {
    const {
        page = 1,
        limit: rawLimit = 10,
        after,
        before,
        search = "",
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
    } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    const listFilter: CustomerListFilter = { search, showTrashed, filters: options.filters, appCondition: options.appCondition };
    const leadWithMatches = await customerListLeads(db, listFilter);
    const whereConditions = customerListConditions(db, { ...listFilter, leadWithMatches });

    const whereClause =
        whereConditions.length > 0
            ? sql`${sql.join(whereConditions, sql` AND `)}`
            : undefined;

    const totalOrders = sql<number>`COALESCE(${customerOrderStats.ordersCount}, 0)`;
    const totalSpentMinor = sql<number>`COALESCE(${customerOrderStats.totalSpentMinor}, 0)`;
    // Every sort walks by keyset (sort value + id). Only `lastOrderAt` can be NULL
    // (a customer with no orders): first ascending, last descending. The name is
    // personal data: its cursors are references (they name the customer and never
    // carry the name, which must not enter a URL); the name is read back by id.
    const keysetSorts = {
        name: { column: customers.name, kind: "text", nullable: false, referenced: true },
        totalOrders: { column: totalOrders, kind: "number", nullable: false, referenced: false },
        totalSpent: { column: totalSpentMinor, kind: "number", nullable: false, referenced: false },
        lastOrderAt: { column: customerOrderStats.lastOrderAt, kind: "number", nullable: true, referenced: false },
        createdAt: { column: customers.createdAt, kind: "number", nullable: false, referenced: false },
        updatedAt: { column: customers.updatedAt, kind: "number", nullable: false, referenced: false },
    } as const satisfies Record<string, { column: SQLWrapper; kind: CursorValueKind; nullable: boolean; referenced: boolean }>;
    const sortKey = (sort in keysetSorts ? sort : "updatedAt") as keyof typeof keysetSorts;
    // Every customer has a `customer_order_stats` row (migration 0128: a
    // trigger on insert, existing customers backfilled), so an order-facts
    // sort of the live list walks the stats row's own index
    // (count/spent/last order, customer_id) and probes each customer:
    // `stats cross join customers` keeps that order on SQLite. A search, tag
    // or channel that names few customers still reads them first.
    const statsSorts = {
        totalOrders: customerOrderStats.ordersCount,
        totalSpent: customerOrderStats.totalSpentMinor,
        lastOrderAt: customerOrderStats.lastOrderAt,
    } as const;
    const statsDriven = sortKey in statsSorts && !showTrashed && !leadWithMatches;
    const keysetSpec = statsDriven
        ? { ...keysetSorts[sortKey], column: statsSorts[sortKey as keyof typeof statsSorts] }
        : keysetSorts[sortKey];
    const keysetId = statsDriven ? customerOrderStats.customerId : customers.id;
    const boundary = keysetSpec.referenced
        ? await resolveReferencedBoundary({ after, before }, { sort: sortKey, direction: order }, async (id) => {
            const [row] = await db.select({ value: sql<string>`${keysetSpec.column}` }).from(customers).where(eq(customers.id, id)).limit(1);
            return row?.value;
        })
        : undefined;
    const plan = planKeysetPage({ page, limit, after, before, boundary }, {
        sort: sortKey,
        order: { column: keysetSpec.column, id: keysetId, direction: order, nullable: keysetSpec.nullable },
        kind: keysetSpec.kind,
        referenced: keysetSpec.referenced,
    });

    // Filters read `customer_order_stats`, so every count joins it too.
    const countProbe = (where: SQL | undefined) => cappedCountQuery(
        db,
        db.select(COUNT_PROBE_COLUMN).from(customers)
            .leftJoin(customerOrderStats, eq(customerOrderStats.customerId, customers.id))
            .where(where)
            .$dynamic(),
    );

    // The page's ids first, from the sort index; the address, latest order
    // and spend are then read for those ids only (a 200,000-customer store).
    const pageKeys = (statsDriven
        ? db
            .select({ id: customers.id })
            .from(customerOrderStats)
            .crossJoin(customers)
            .where(and(eq(customers.id, customerOrderStats.customerId), plan.pageWhere(whereClause)))
        : db
            .select({ id: customers.id })
            .from(customers)
            .leftJoin(customerOrderStats, eq(customerOrderStats.customerId, customers.id))
            .where(plan.pageWhere(whereClause)))
        .orderBy(...plan.orderBy)
        .limit(plan.fetchLimit)
        .offset(plan.offset);

    const resultsQuery = db
        .select({
            id: customers.id,
            name: customers.name,
            email: customers.email,
            phone: customers.phone,
            defaultCountryCode: defaultAddress.countryCode,
            defaultLine1: defaultAddress.line1,
            defaultLine2: defaultAddress.line2,
            defaultDependentLocality: defaultAddress.dependentLocality,
            defaultLocality: defaultAddress.locality,
            defaultAdminArea: defaultAddress.adminArea,
            defaultPostalCode: defaultAddress.postalCode,
            defaultCity: defaultAddress.city,
            defaultZone: defaultAddress.zone,
            defaultArea: defaultAddress.area,
            defaultCityName: defaultAddress.cityName,
            defaultZoneName: defaultAddress.zoneName,
            defaultAreaName: defaultAddress.areaName,
            accountClaimedAt: sql<number | null>`CAST(${customers.accountClaimedAt} AS INTEGER)`,
            origin: customers.origin,
            latestOrderName: latestOrderNameSql().as("latest_order_name"),
            totalOrders,
            totalSpentMinor,
            // One store currency (locked once orders exist): any of the customer's orders converts it.
            spendDecimalPlaces: sql<number>`COALESCE((SELECT ${orders.currencyDecimalPlaces} FROM ${orders} WHERE ${orders.customerId} = ${customers.id} LIMIT 1), 2)`,
            lastOrderAt: sql<number | null>`${customerOrderStats.lastOrderAt}`,
            createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${customers.updatedAt} AS INTEGER)`,
            // The sort column as stored: a cursor compares what the ORDER BY compared.
            keysetValue: sql<number | string | null>`${keysetSpec.column}`.as("keyset_value"),
        })
        .from(customers)
        .leftJoin(customerOrderStats, eq(customerOrderStats.customerId, customers.id))
        .leftJoin(defaultAddress, and(
            eq(defaultAddress.customerId, customers.id),
            eq(defaultAddress.isDefault, true),
        ))
        .where(inArray(customers.id, pageKeys))
        .orderBy(...plan.orderBy);

    // The total reads at most `countCap` + 1 rows; a cursor page also
    // counts the rows leading up to it (same cap) for its "51-100 of 1,000+".
    const positionWhere = plan.positionWhere(whereClause);
    const statements: unknown[] = [countProbe(whereClause), resultsQuery];
    if (positionWhere) statements.push(countProbe(positionWhere));
    const batchResult = await db.batch(statements as unknown as Parameters<Database["batch"]>[0]) as unknown as [
        { count: number }[],
        { id: string; name: string; email: string | null; phone: string | null; defaultCountryCode: string | null; defaultLine1: string | null; defaultLine2: string | null; defaultDependentLocality: string | null; defaultLocality: string | null; defaultAdminArea: string | null; defaultPostalCode: string | null; defaultCity: string | null; defaultZone: string | null; defaultArea: string | null; defaultCityName: string | null; defaultZoneName: string | null; defaultAreaName: string | null; accountClaimedAt: number | null; origin: string; latestOrderName: string | null; totalOrders: number; totalSpentMinor: number; spendDecimalPlaces: number; lastOrderAt: number | null; createdAt: number; updatedAt: number; keysetValue: number | string | null }[],
        { count: number }[]?,
    ];
    const { rows: results, pageInfo, pageStart } = plan.finish(batchResult[1], batchResult[2]?.[0]?.count);

    const formattedCustomers = results.map(({
        totalSpentMinor, spendDecimalPlaces, origin, keysetValue: _keysetValue,
        defaultCountryCode, defaultLine1, defaultLine2, defaultDependentLocality, defaultLocality, defaultAdminArea, defaultPostalCode,
        defaultCity, defaultZone, defaultArea, defaultCityName, defaultZoneName, defaultAreaName,
        ...c
    }) => ({
        ...c,
        /** The default address (a staff order prefills it from the customer found by phone). */
        defaultAddress: defaultCountryCode
            ? {
                countryCode: defaultCountryCode,
                line1: defaultLine1,
                line2: defaultLine2,
                dependentLocality: defaultDependentLocality,
                locality: defaultLocality,
                adminArea: defaultAdminArea,
                postalCode: defaultPostalCode,
                city: defaultCity,
                zone: defaultZone,
                area: defaultArea,
                cityName: defaultCityName,
                zoneName: defaultZoneName,
                areaName: defaultAreaName,
            }
            : null,
        kind: customerKind({ accountClaimedAt: c.accountClaimedAt, origin }),
        totalOrders: Number(c.totalOrders),
        totalSpent: paidSpendAmount({ totalSpentMinor: Number(totalSpentMinor), spendDecimalPlaces: Number(spendDecimalPlaces) }),
        accountClaimedAt: c.accountClaimedAt ? new Date(c.accountClaimedAt * 1000).toISOString() : null,
        lastOrderAt: c.lastOrderAt ? new Date(Number(c.lastOrderAt) * 1000).toISOString() : null,
        createdAt: new Date(c.createdAt * 1000).toISOString(),
        updatedAt: new Date(c.updatedAt * 1000).toISOString(),
    }));

    return {
        customers: formattedCustomers,
        pagination: cappedPagination(batchResult[0][0]?.count ?? 0, pageStart, limit),
        pageInfo,
    };
}

// ─────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────

export async function createCustomer(
    db: Database,
    data: CreateCustomerInput,
    actorId: string | null = null,
): Promise<{ id: string }> {
    if (data.phone) {
        await validateCustomerPhoneCountry(db, data.phone);
        const existing = await findActiveCustomerWithPhone(db, data.phone);
        if (existing) throw new ValidationError("Customer with this phone number already exists", { customer: existing });
    } else {
        await assertPhonelessCustomerAllowed(db, data.email);
    }
    // The first address (Shopify's new-customer form) is the default of the new address book.
    const address = data.address
        ? await resolveAddress(db, data.address, { skipValidation: data.address.skipValidation === true })
        : null;

    const customerId = "cust_" + nanoid();
    await db.batch([
        db.insert(customers).values({
            id: customerId,
            name: data.name,
            email: data.email,
            phone: storedPhone(data.phone),
            origin: "merchant",
            totalOrders: 0,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId,
            name: data.name,
            email: data.email,
            phone: storedPhone(data.phone),
            changeType: "created",
            actor: "staff",
            actorId,
            createdAt: sql`unixepoch()`,
        }),
        ...(address
            ? [db.insert(customerAddresses).values({
                id: firstCustomerAddressId(customerId),
                customerId,
                isDefault: true,
                ...customerAddressColumns(address),
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            })]
            : []),
    ] as Parameters<Database["batch"]>[0]);

    return { id: customerId };
}

export async function getCustomerById(db: Database, id: string) {
    return db.select().from(customers).where(eq(customers.id, id)).get() ?? null;
}

/**
 * The customer row plus its paid spend, derived from its orders, its tags and
 * its marketing consent status per channel (Customers & marketing).
 */
export async function getCustomerDetail(db: Database, id: string, relatedObjectsProjection?: SQL<string | null>) {
    const [customer, spend, latest, tags, consentRows, addresses] = await Promise.all([
        db.select({ ...getTableColumns(customers), relatedObjectsJson: relatedObjectsProjection ?? sql<string | null>`null` })
            .from(customers).where(eq(customers.id, id)).get(),
        db.select(paidSpendProjection()).from(orders)
            .where(and(eq(orders.customerId, id), isNull(orders.deletedAt)))
            .get(),
        db.select({ name: latestOrderNameSql() }).from(customers).where(eq(customers.id, id)).get(),
        listCustomerTags(db, id),
        db.select({
            channel: customerMarketingConsents.channel,
            state: customerMarketingConsents.state,
            contact: customerMarketingConsents.contact,
            updatedAt: customerMarketingConsents.updatedAt,
        }).from(customerMarketingConsents).where(eq(customerMarketingConsents.customerId, id)),
        listCustomerAddresses(db, id),
    ]);
    if (!customer) return null;
    const mergedInto = customer.mergedIntoCustomerId
        ? await db.select({ id: customers.id, name: customers.name }).from(customers)
            .where(eq(customers.id, customer.mergedIntoCustomerId)).get() ?? null
        : null;
    return {
        ...customer,
        mergedInto,
        kind: customerKind(customer),
        latestOrderName: latest?.name ?? null,
        totalSpent: spend ? paidSpendAmount(spend) : 0,
        tags,
        /** The address book, the default first. */
        addresses,
        /** What applies to the current address on each channel (consent covers one address). */
        marketing: MARKETING_CHANNELS.map((channel) => {
            const row = consentRows.find((candidate) => candidate.channel === channel);
            return {
                channel,
                status: marketingConsentStatus(row, marketingConsentContact(channel, customer)),
                updatedAt: row ? new Date(Number(row.updatedAt) * 1000).toISOString() : null,
            };
        }),
    };
}

export async function updateCustomer(
    db: Database,
    id: string,
    data: UpdateCustomerInput,
    actorId: string | null = null,
) {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");

    if (data.phone && data.phone !== existing.phone) {
        await validateCustomerPhoneCountry(db, data.phone);
        const phoneConflict = await findActiveCustomerWithPhone(db, data.phone, id);
        if (phoneConflict) {
            throw new ValidationError("Another customer with this phone number already exists", { customer: phoneConflict });
        }
    }

    // Addresses are edited in the address book (customer addresses), not here.
    const next = {
        name: data.name ?? existing.name,
        email: data.email !== undefined ? data.email : existing.email,
        phone: data.phone ?? existing.phone,
    };
    // A customer without a phone is keyed by its email: it keeps one, unique among them.
    if (!next.phone && !existing.accountClaimedAt && normalizeContactEmail(next.email) !== normalizeContactEmail(existing.email)) {
        const email = normalizeContactEmail(next.email);
        if (!email) throw new ValidationError("A customer without a phone needs an email address.", { field: "email" });
        const taken = await db.select({ id: customers.id }).from(customers)
            .where(and(guestRecordForContact({ phone: null, email }), sql`${customers.id} != ${id}`))
            .get();
        if (taken) throw new ValidationError("A customer without a phone already uses this email address.", { field: "email" });
    }
    // A save that changes nothing writes nothing: no bumped timestamp, no empty "Updated" entry.
    if ((Object.keys(next) as Array<keyof typeof next>).every((key) => (next[key] ?? null) === (existing[key] ?? null))) return;

    // Naming a checkout guest record in the dashboard makes it the merchant's customer.
    const origin = !existing.accountClaimedAt && next.name !== existing.name ? { origin: "merchant" as const } : {};
    await db.batch([
        db.update(customers).set({ ...next, phone: storedPhone(next.phone), ...origin, updatedAt: sql`unixepoch()` }).where(eq(customers.id, id)),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: id,
            ...next,
            phone: storedPhone(next.phone),
            changeType: "updated",
            actor: "staff",
            actorId,
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);

}

export async function deleteCustomer(db: Database, id: string, actorId: string | null = null): Promise<void> {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");

    await db.batch([
        db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(eq(customers.id, id)),
        db
            .update(customerSessions)
            .set({ revokedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(and(eq(customerSessions.customerId, id), isNull(customerSessions.revokedAt))),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: id,
            name: existing.name,
            email: existing.email,
            phone: storedPhone(existing.phone),
            changeType: "deleted",
            actor: "staff",
            actorId,
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);
}

export async function permanentlyDeleteCustomer(db: Database, id: string): Promise<void> {
    const referencedOrder = await db
        .select({ id: orders.id })
        .from(orders)
        .where(or(eq(orders.customerId, id), eq(orders.accountOwnerCustomerId, id)))
        .limit(1)
        .get();
    if (referencedOrder) {
        throw new ValidationError("Customers with order history cannot be permanently deleted. Keep the customer archived.");
    }
    await db.batch([
        db.delete(customerSessions).where(eq(customerSessions.customerId, id)),
        db.delete(customerHistory).where(eq(customerHistory.customerId, id)),
        db.delete(customers).where(eq(customers.id, id)),
    ] as Parameters<Database["batch"]>[0]);
}

/** Restores a trashed customer (a merged guest record stays merged) and logs who did it. */
export async function restoreCustomer(db: Database, id: string, actorId: string | null = null): Promise<void> {
    const existing = await getCustomerById(db, id);
    if (!existing) throw new NotFoundError("Customer not found");
    if (!existing.deletedAt) return;
    if (existing.erasedAt) {
        throw new ValidationError("This customer's data was erased, so the record can't be restored.");
    }
    if (existing.mergedIntoCustomerId) {
        throw new ValidationError("This guest record was merged into an account and can't be restored.");
    }
    await db.batch([
        db.update(customers).set({ deletedAt: null, updatedAt: sql`unixepoch()` }).where(eq(customers.id, id)),
        db.insert(customerHistory).values({
            id: "hist_" + nanoid(),
            customerId: id,
            name: existing.name,
            email: existing.email,
            phone: storedPhone(existing.phone),
            changeType: "restored",
            actor: "staff",
            actorId,
            createdAt: sql`unixepoch()`,
        }),
    ] as Parameters<Database["batch"]>[0]);
}

/**
 * A customer without a phone (Shopify keys such a customer by email): only
 * when the store lets digital and service orders go without a phone, with an
 * email that no other phoneless customer record uses (migration 0117).
 */
async function assertPhonelessCustomerAllowed(db: Database, email: string | null | undefined): Promise<void> {
    const normalized = normalizeContactEmail(email);
    if (!normalized) throw new ValidationError("Enter a phone number or an email address.", { field: "phone" });
    const identity = await customerAuthDocument.read(db);
    if (!identity.phoneOptionalForDigital) {
        throw new ValidationError(
            "Enter a phone number. A customer without one needs Settings → Customer accounts to let digital and service orders go without a phone.",
            { field: "phone" },
        );
    }
    const existing = await db.select({ id: customers.id, name: customers.name, phone: customers.phone, accountClaimedAt: customers.accountClaimedAt, origin: customers.origin })
        .from(customers)
        .where(guestRecordForContact({ phone: null, email: normalized }))
        .get();
    if (existing) {
        throw new ValidationError("A customer without a phone already uses this email address.", {
            field: "email",
            customer: { id: existing.id, name: existing.name, phone: existing.phone, kind: customerKind(existing) },
        });
    }
}

/** The active customer already using a phone, for a dashboard "uses this phone" link. */
async function findActiveCustomerWithPhone(db: Database, phone: string, exceptId?: string) {
    const row = await db
        .select({ id: customers.id, name: customers.name, phone: customers.phone, accountClaimedAt: customers.accountClaimedAt, origin: customers.origin })
        .from(customers)
        .where(and(
            eq(customers.phone, phone),
            isNull(customers.deletedAt),
            exceptId ? sql`${customers.id} != ${exceptId}` : undefined,
        ))
        .orderBy(desc(customers.accountClaimedAt))
        .get();
    return row ? { id: row.id, name: row.name, phone: row.phone, kind: customerKind(row) } : null;
}

export async function bulkDeleteCustomers(db: Database, ids: string[], permanent = false): Promise<void> {
    if (ids.length === 0) return;
    // One bound value for the whole id set: a list of 90 ids used twice would
    // bind 180 values, over D1's 100.
    const idSet = JSON.stringify(ids);
    const inSet = (column: SQLWrapper) => sql`${column} IN (SELECT CAST(value AS TEXT) FROM json_each(${idSet}))`;
    if (permanent) {
        const referencedOrder = await db
            .select({ id: orders.id })
            .from(orders)
            .where(or(inSet(orders.customerId), inSet(orders.accountOwnerCustomerId)))
            .limit(1)
            .get();
        if (referencedOrder) {
            throw new ValidationError("Customers with order history cannot be permanently deleted. Keep those customers archived.");
        }
        await db.batch([
            db.delete(customerSessions).where(inSet(customerSessions.customerId)),
            db.delete(customerHistory).where(inSet(customerHistory.customerId)),
            db.delete(customers).where(inSet(customers.id)),
        ] as Parameters<Database["batch"]>[0]);
    } else {
        await db.batch([
            db.update(customers).set({ deletedAt: sql`unixepoch()` }).where(inSet(customers.id)),
            db
                .update(customerSessions)
                .set({ revokedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(and(inSet(customerSessions.customerId), isNull(customerSessions.revokedAt))),
        ] as Parameters<Database["batch"]>[0]);
    }
}
