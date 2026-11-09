// src/modules/analytics/dashboard.service.ts
// Dashboard statistics and activity data queries.
// Extracted from src/lib/admin.ts.

import { safeBatch, type Database } from "@scalius/database/client";
import { products, customers, orders } from "@scalius/database/schema";
import { and, sql, desc } from "drizzle-orm";
import { fromMinor } from "@scalius/shared/money";
import { capTotal } from "@scalius/shared/pagination";
import { DEFAULT_CURRENCY, getDecimalPlaces } from "@scalius/shared/currency";
import {
    commerceCalendarDateKey,
    commerceDayStart,
    commerceMonthBounds,
    shiftCommerceCalendarDateKey,
    zoneOffsetSchedule,
} from "@scalius/shared/commerce-time";
import { analyticsEpochDay } from "@scalius/shared/analytics-period";
import { merchantDaySql } from "./reports/sales-sql";
import { createAnalyticsContext, num } from "./reports/context";
import { salesOverTimeSql } from "./reports/sales-over-time-sql";
import { retryTransientD1 } from "../../utils/transient-d1";
import { COUNT_PROBE_COLUMN, cappedCountQuery } from "../../utils/keyset";

const DASHBOARD_QUERY_RETRY_DELAYS_MS = [150, 350, 750] as const;

function getDashboardQueryErrorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

async function runDashboardQuery<T>(
    query: string,
    operation: () => Promise<T> | T,
): Promise<T> {
    const startedAt = Date.now();
    let lastAttempt = 0;

    try {
        const result = await retryTransientD1((attempt) => {
            lastAttempt = attempt;
            return operation();
        }, {
            delaysMs: DASHBOARD_QUERY_RETRY_DELAYS_MS,
            onRetry: (error, attempt, delayMs) => {
                console.warn("[dashboard-query]", {
                    event: "dashboard_query_retry",
                    query,
                    attempt: attempt + 1,
                    nextAttempt: attempt + 2,
                    delayMs,
                    error: getDashboardQueryErrorMessage(error),
                });
            },
        });

        console.log("[dashboard-query]", {
            event: "dashboard_query_completed",
            query,
            attempts: lastAttempt + 1,
            durationMs: Date.now() - startedAt,
        });

        return result;
    } catch (error) {
        console.error("[dashboard-query]", {
            event: "dashboard_query_failed",
            query,
            attempts: lastAttempt + 1,
            durationMs: Date.now() - startedAt,
            error: getDashboardQueryErrorMessage(error),
        });
        throw error;
    }
}

type CountRow = { count: number };
type CurrentMonthRow = {
    count: number;
    delivered: number;
    processing: number;
    shipping: number;
    cancelled: number;
};
type MonthComparisonRow = { count: number };
type DailyOrderRow = {
    day: number;
    orderCount: number;
};
type DailyCustomerRow = {
    day: number;
    customerCount: number;
};
type RecentOrderRow = {
    id: string;
    orderNumber: number | null;
    customerName: string;
    totalAmountMinor: number;
    currencyDecimalPlaces: number;
    status: string;
    createdAt: Date | string;
};

/**
 * Revenue is the Analytics overview's total sales, read through the same
 * primitive (sealed buckets, else the order facts): in the store currency,
 * net of refunds and returns, nothing for an unfinished, cancelled or
 * reversed order, and the gift cards sold left out (a liability, not a
 * sale). `granularity` buckets the merchant days from `from` to `to`
 * (inclusive date keys); the result maps each bucket's first day to its
 * total in major units.
 */
async function readTotalSales(
    db: Database,
    timeZone: string,
    range: { from: string; to: string },
    granularity: "day" | "month",
    now: Date,
): Promise<Map<number, number>> {
    const ctx = await createAnalyticsContext(db, timeZone, now);
    const rows = await db.all<{ bucket: unknown; total_sales: unknown }>(await salesOverTimeSql(ctx, range, granularity));
    const places = getDecimalPlaces(ctx.currency.code ?? DEFAULT_CURRENCY.code);
    return new Map(rows.map((row) => [num(row.bucket), fromMinor(num(row.total_sales), places)]));
}

function calculateGrowth(current: number, previous: number): number | null {
    if (previous === 0) return current === 0 ? 0 : null;

    return ((current - previous) / previous) * 100;
}

function getDashboardMonthBounds(timeZone: string, now: Date) {
    const bounds = commerceMonthBounds(timeZone, now);
    const firstDayOfMonthTs = bounds.currentMonthStart;
    const firstDayOfLastMonthTs = bounds.previousMonthStart;

    return { firstDayOfMonthTs, firstDayOfLastMonthTs };
}

function getDashboardSummaryQueries(
    db: Database,
    {
        firstDayOfMonthTs,
        firstDayOfLastMonthTs,
    }: ReturnType<typeof getDashboardMonthBounds>,
) {
    return [
        // Totals read at most the plan's count cap + 1 index entries, never the
        // whole catalogue or customer list (Home loads them on every visit).
        cappedCountQuery(
            db,
            db.select(COUNT_PROBE_COLUMN).from(products)
                .where(sql`${products.deletedAt} is null AND ${products.isActive} = 1`)
                .$dynamic(),
        ),
        cappedCountQuery(
            db,
            db.select(COUNT_PROBE_COLUMN).from(customers)
                .where(sql`${customers.deletedAt} is null`)
                .$dynamic(),
        ),
        db
            .select({
                count: sql<number>`count(*)`,
                delivered: sql<number>`count(case when status = 'delivered' then 1 end)`,
                processing: sql<number>`count(case when status in ('pending', 'processing', 'confirmed') then 1 end)`,
                shipping: sql<number>`count(case when status = 'shipped' then 1 end)`,
                cancelled: sql<number>`count(case when status in ('cancelled', 'returned') then 1 end)`,
            })
            .from(orders)
            .where(
                sql`${orders.deletedAt} is null AND ${orders.createdAt} >= ${firstDayOfMonthTs}`,
            ),
        db
            .select({
                count: sql<number>`count(*)`,
            })
            .from(orders)
            .where(
                sql`${orders.deletedAt} is null AND ${orders.createdAt} >= ${firstDayOfLastMonthTs} AND ${orders.createdAt} < ${firstDayOfMonthTs}`,
            ),
    ] as const;
}

function getRecentOrdersQuery(db: Database, limit: number) {
    return db
        .select({
            id: orders.id,
            orderNumber: orders.orderNumber,
            customerName: orders.customerName,
            totalAmountMinor: orders.totalAmountMinor,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            status: orders.status,
            createdAt: orders.createdAt,
        })
        .from(orders)
        .where(sql`${orders.deletedAt} is null`)
        .orderBy(desc(orders.createdAt))
        .limit(limit);
}

function mapRecentOrders(recentOrders: RecentOrderRow[]) {
    return recentOrders.map(({ totalAmountMinor, currencyDecimalPlaces, ...order }) => ({
        ...order,
        totalAmount: fromMinor(totalAmountMinor, currencyDecimalPlaces),
        createdAt: new Date(order.createdAt),
    }));
}

function mapDashboardSummaryStats([
    totalProductsArr,
    totalCustomersArr,
    currentMonthArr,
    lastMonthArr,
]: [CountRow[], CountRow[], CurrentMonthRow[], MonthComparisonRow[]], currentRevenue: number, lastRevenue: number) {
    // Exact up to the plan's count cap; above it the cap, flagged.
    const { total: totalProducts, totalIsCapped: totalProductsIsCapped } = capTotal(totalProductsArr[0]?.count ?? 0);
    const { total: totalCustomers, totalIsCapped: totalCustomersIsCapped } = capTotal(totalCustomersArr[0]?.count ?? 0);
    const currentMonthStats = currentMonthArr[0];
    const lastMonthStats = lastMonthArr[0];

    const orderGrowth = calculateGrowth(
        currentMonthStats?.count ?? 0,
        lastMonthStats?.count ?? 0,
    );
    const revenueGrowth = calculateGrowth(currentRevenue, lastRevenue);

    return {
        totalProducts,
        totalProductsIsCapped,
        totalCustomers,
        totalCustomersIsCapped,
        currentMonth: {
            orders: currentMonthStats?.count ?? 0,
            revenue: currentRevenue,
            orderGrowth,
            revenueGrowth,
            orderStatus: {
                delivered: currentMonthStats?.delivered ?? 0,
                processing: currentMonthStats?.processing ?? 0,
                shipping: currentMonthStats?.shipping ?? 0,
                cancelled: currentMonthStats?.cancelled ?? 0,
            },
        },
        lastMonth: {
            orders: lastMonthStats?.count ?? 0,
            revenue: lastRevenue,
        },
    };
}

/**
 * Dashboard home projection in one provider batch. D1 executes batch statements
 * sequentially in a single call, avoiding a second connection and round trip;
 * the same provider-neutral batch contract is used by TursoDB and PostgreSQL.
 * `recentOrderLimit` 0 skips the order feed (and its customer names) entirely.
 */
export async function getDashboardHomeSummary(db: Database, recentOrderLimit: number, timeZone: string, now: Date = new Date()) {
    const monthBounds = getDashboardMonthBounds(timeZone, now);
    const today = commerceCalendarDateKey(timeZone, now);
    const currentMonthKey = `${today.slice(0, 7)}-01`;
    const lastMonthKey = `${shiftCommerceCalendarDateKey(currentMonthKey, -1).slice(0, 7)}-01`;
    const revenue = await runDashboardQuery("home_revenue", () =>
        readTotalSales(db, timeZone, { from: lastMonthKey, to: today }, "month", now));
    const queries = getDashboardSummaryQueries(db, monthBounds);
    const [
        totalProductsArr,
        totalCustomersArr,
        currentMonthArr,
        lastMonthArr,
        recentOrders = [],
    ] = await runDashboardQuery("home_summary", () =>
        safeBatch(db, recentOrderLimit > 0
            ? [...queries, getRecentOrdersQuery(db, recentOrderLimit)]
            : queries) as unknown as Promise<[
            CountRow[],
            CountRow[],
            CurrentMonthRow[],
            MonthComparisonRow[],
            RecentOrderRow[]?,
        ]>,
    );

    return {
        stats: mapDashboardSummaryStats([
            totalProductsArr,
            totalCustomersArr,
            currentMonthArr,
            lastMonthArr,
        ], revenue.get(analyticsEpochDay(currentMonthKey)) ?? 0, revenue.get(analyticsEpochDay(lastMonthKey)) ?? 0),
        recentOrders: mapRecentOrders(recentOrders),
    };
}

/**
 * Returns per-day order counts, order value, and new customer counts for the
 * last N days (filling in zero-rows for days with no data).
 */
export async function getDailyActivityData(db: Database, days: number, timeZone: string, now: Date = new Date()) {
    if (!Number.isInteger(days) || days < 1 || days > 90) {
        throw new RangeError("Dashboard activity days must be between 1 and 90.");
    }

    const endDateKey = commerceCalendarDateKey(timeZone, now);
    const startDateKey = shiftCommerceCalendarDateKey(endDateKey, -(days - 1));
    const startDateTs = commerceDayStart(timeZone, startDateKey);
    const endExclusive = commerceDayStart(timeZone, shiftCommerceCalendarDateKey(endDateKey, 1));
    // Integer epoch-day bucketing in the store's zone (each daylight saving
    // change a literal): identical on SQLite/Turso and PostgreSQL, never a
    // database session timezone.
    const offsets = zoneOffsetSchedule(timeZone, startDateTs, endExclusive);
    const orderDay = sql<number>`${merchantDaySql(`"orders"."created_at"`, offsets)}`;
    const customerDay = sql<number>`${merchantDaySql(`"customers"."created_at"`, offsets)}`;

    const revenue = await runDashboardQuery(`daily_revenue_${days}d`, () =>
        readTotalSales(db, timeZone, { from: startDateKey, to: endDateKey }, "day", now));
    const [dailyOrderData, dailyCustomerData] = await runDashboardQuery(
        `daily_activity_${days}d`,
        () => safeBatch(db, [
            db
                .select({
                    day: orderDay.mapWith(Number),
                    orderCount: sql<number>`count(*)`.mapWith(Number),
                })
                .from(orders)
                .where(
                    and(
                        sql`${orders.deletedAt} is null`,
                        sql`${orders.createdAt} >= ${startDateTs}`,
                    ),
                )
                .groupBy(orderDay)
                .orderBy(sql`${orderDay} asc`),
            db
                .select({
                    day: customerDay.mapWith(Number),
                    customerCount: sql<number>`count(*)`.mapWith(Number),
                })
                .from(customers)
                .where(
                    and(
                        sql`${customers.deletedAt} is null`,
                        sql`${customers.createdAt} >= ${startDateTs}`,
                    ),
                )
                .groupBy(customerDay)
                .orderBy(sql`${customerDay} asc`),
        ]) as Promise<[DailyOrderRow[], DailyCustomerRow[]]>,
    );

    const result = [];

    const dayKey = (day: number) =>
        new Date(day * 86_400_000).toISOString().slice(0, 10);
    const orderMap = new Map(dailyOrderData.map((item) => [dayKey(item.day), item]));
    const customerMap = new Map(
        dailyCustomerData.map((item) => [dayKey(item.day), item]),
    );

    for (let index = 0; index < days; index += 1) {
        const dateStr = shiftCommerceCalendarDateKey(startDateKey, index);
        const orderEntry = orderMap.get(dateStr);
        const customerEntry = customerMap.get(dateStr);
        result.push({
            date: dateStr,
            orders: orderEntry ? orderEntry.orderCount : 0,
            revenue: revenue.get(analyticsEpochDay(dateStr)) ?? 0,
            newCustomers: customerEntry ? customerEntry.customerCount : 0,
        });
    }

    return result;
}
