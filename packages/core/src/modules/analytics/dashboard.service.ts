// src/modules/analytics/dashboard.service.ts
// Dashboard statistics and activity data queries.
// Extracted from src/lib/admin.ts.

import { safeBatch, type Database } from "@scalius/database/client";
import { products, customers, orders } from "@scalius/database/schema";
import { and, sql, desc } from "drizzle-orm";
import { retryTransientD1 } from "../../utils/transient-d1";

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
    revenue: number | null;
    delivered: number;
    processing: number;
    shipping: number;
    cancelled: number;
};
type MonthComparisonRow = { count: number; revenue: number | null };
type TotalRevenueRow = { total: number | null };
type DailyOrderRow = {
    date: string;
    orderCount: number;
    totalRevenue: number;
};
type DailyCustomerRow = {
    date: string;
    customerCount: number;
};
type RecentOrderRow = {
    id: string;
    customerName: string;
    totalAmount: number;
    status: string;
    createdAt: string;
};

function getDashboardMonthBounds() {
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const firstDayOfLastMonth = new Date(
        now.getFullYear(),
        now.getMonth() - 1,
        1,
    );

    const firstDayOfMonthTs = Math.floor(firstDayOfMonth.getTime() / 1000);
    const firstDayOfLastMonthTs = Math.floor(
        firstDayOfLastMonth.getTime() / 1000,
    );

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
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(sql`${products.deletedAt} is null AND ${products.isActive} = 1`),
        db
            .select({ count: sql<number>`count(*)` })
            .from(customers)
            .where(sql`${customers.deletedAt} is null`),
        db
            .select({
                count: sql<number>`count(*)`,
                revenue: sql<number>`sum(case when status NOT IN ('cancelled', 'returned') then total_amount else 0 end)`,
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
                revenue: sql<number>`sum(total_amount)`,
            })
            .from(orders)
            .where(
                sql`${orders.deletedAt} is null AND ${orders.createdAt} >= ${firstDayOfLastMonthTs} AND ${orders.createdAt} < ${firstDayOfMonthTs} AND ${orders.status} NOT IN ('cancelled', 'returned')`,
            ),
    ] as const;
}

function getDashboardTotalRevenueQuery(db: Database) {
    return db
        .select({
            total: sql<number>`sum(total_amount)`,
        })
        .from(orders)
        .where(
            sql`${orders.deletedAt} is null AND ${orders.status} NOT IN ('cancelled', 'returned')`,
        );
}

function getRecentOrdersQuery(db: Database, limit: number) {
    return db
        .select({
            id: orders.id,
            customerName: orders.customerName,
            totalAmount: orders.totalAmount,
            status: orders.status,
            createdAt: sql<string>`datetime(${orders.createdAt}, 'unixepoch')`,
        })
        .from(orders)
        .where(sql`${orders.deletedAt} is null`)
        .orderBy(desc(orders.createdAt))
        .limit(limit);
}

function mapRecentOrders(recentOrders: RecentOrderRow[]) {
    return recentOrders.map((order) => ({
        ...order,
        createdAt: new Date(order.createdAt),
    }));
}

function mapDashboardSummaryStats([
    totalProductsArr,
    totalCustomersArr,
    currentMonthArr,
    lastMonthArr,
]: [CountRow[], CountRow[], CurrentMonthRow[], MonthComparisonRow[]]) {
    const totalProducts = totalProductsArr[0]?.count ?? 0;
    const totalCustomers = totalCustomersArr[0]?.count ?? 0;
    const currentMonthStats = currentMonthArr[0];
    const lastMonthStats = lastMonthArr[0];

    const orderGrowth = lastMonthStats?.count
        ? Math.round(
            (((currentMonthStats?.count ?? 0) - lastMonthStats.count) /
                lastMonthStats.count) *
            100,
        )
        : 0;

    const revenueGrowth = lastMonthStats?.revenue
        ? Math.round(
            (((currentMonthStats?.revenue ?? 0) - lastMonthStats.revenue) /
                lastMonthStats.revenue) *
            100,
        )
        : 0;

    return {
        totalProducts,
        totalCustomers,
        currentMonth: {
            orders: currentMonthStats?.count ?? 0,
            revenue: currentMonthStats?.revenue ?? 0,
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
            revenue: lastMonthStats?.revenue ?? 0,
        },
    };
}

/** Aggregated dashboard metrics needed by the admin home SSR summary. */
export async function getDashboardSummaryStats(db: Database) {
    const monthBounds = getDashboardMonthBounds();

    const rows = await runDashboardQuery("summary_stats", () =>
        safeBatch(db, getDashboardSummaryQueries(db, monthBounds)) as Promise<[
            CountRow[],
            CountRow[],
            CurrentMonthRow[],
            MonthComparisonRow[],
        ]>,
    );

    return mapDashboardSummaryStats(rows);
}

/**
 * Dashboard home projection in one provider batch. D1 executes batch statements
 * sequentially in a single call, avoiding a second connection and round trip;
 * the same provider-neutral batch contract is used by TursoDB and PostgreSQL.
 */
export async function getDashboardHomeSummary(db: Database, recentOrderLimit = 5) {
    const monthBounds = getDashboardMonthBounds();
    const [
        totalProductsArr,
        totalCustomersArr,
        currentMonthArr,
        lastMonthArr,
        recentOrders,
    ] = await runDashboardQuery("home_summary", () =>
        safeBatch(db, [
            ...getDashboardSummaryQueries(db, monthBounds),
            getRecentOrdersQuery(db, recentOrderLimit),
        ]) as Promise<[
            CountRow[],
            CountRow[],
            CurrentMonthRow[],
            MonthComparisonRow[],
            RecentOrderRow[],
        ]>,
    );

    return {
        stats: mapDashboardSummaryStats([
            totalProductsArr,
            totalCustomersArr,
            currentMonthArr,
            lastMonthArr,
        ]),
        recentOrders: mapRecentOrders(recentOrders),
    };
}

/** Full dashboard metrics for legacy callers that still need lifetime revenue. */
export async function getDashboardStats(db: Database) {
    const monthBounds = getDashboardMonthBounds();

    const [
        totalProductsArr,
        totalCustomersArr,
        currentMonthArr,
        lastMonthArr,
        totalRevenueArr,
    ] = await runDashboardQuery("full_stats", () =>
        safeBatch(db, [
            ...getDashboardSummaryQueries(db, monthBounds),
            getDashboardTotalRevenueQuery(db),
        ]) as Promise<[
            CountRow[],
            CountRow[],
            CurrentMonthRow[],
            MonthComparisonRow[],
            TotalRevenueRow[],
        ]>,
    );

    const summaryStats = mapDashboardSummaryStats([
        totalProductsArr,
        totalCustomersArr,
        currentMonthArr,
        lastMonthArr,
    ]);
    const totalRevenue = totalRevenueArr[0]?.total ?? 0;

    return {
        ...summaryStats,
        totalRevenue: totalRevenue || 0,
    };
}

/** Returns the N most recent orders for the dashboard feed. */
export async function getRecentOrders(db: Database, limit = 5) {
    const recentOrders = await runDashboardQuery(
        "recent_orders",
        () => getRecentOrdersQuery(db, limit),
    );

    return mapRecentOrders(recentOrders);
}

/**
 * Returns per-day order counts, revenue, and new customer counts for the
 * last N days (filling in zero-rows for days with no data).
 */
export async function getDailyActivityData(db: Database, days: number) {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - days);
    const startDateTs = Math.floor(startDate.getTime() / 1000);

    const [dailyOrderData, dailyCustomerData] = await runDashboardQuery(
        `daily_activity_${days}d`,
        () => safeBatch(db, [
            db
                .select({
                    date: sql<string>`strftime('%Y-%m-%d', datetime(${orders.createdAt}, 'unixepoch'))`,
                    orderCount: sql<number>`count(*)`.mapWith(Number),
                    totalRevenue: sql<number>`sum(${orders.totalAmount})`.mapWith(Number),
                })
                .from(orders)
                .where(
                    and(
                        sql`${orders.deletedAt} is null`,
                        sql`${orders.createdAt} >= ${startDateTs}`,
                        sql`${orders.status} NOT IN ('cancelled', 'returned')`,
                    ),
                )
                .groupBy(
                    sql`strftime('%Y-%m-%d', datetime(${orders.createdAt}, 'unixepoch'))`,
                )
                .orderBy(
                    sql`strftime('%Y-%m-%d', datetime(${orders.createdAt}, 'unixepoch')) asc`,
                ),
            db
                .select({
                    date: sql<string>`strftime('%Y-%m-%d', datetime(${customers.createdAt}, 'unixepoch'))`,
                    customerCount: sql<number>`count(*)`.mapWith(Number),
                })
                .from(customers)
                .where(
                    and(
                        sql`${customers.deletedAt} is null`,
                        sql`${customers.createdAt} >= ${startDateTs}`,
                    ),
                )
                .groupBy(
                    sql`strftime('%Y-%m-%d', datetime(${customers.createdAt}, 'unixepoch'))`,
                )
                .orderBy(
                    sql`strftime('%Y-%m-%d', datetime(${customers.createdAt}, 'unixepoch')) asc`,
                ),
        ]) as Promise<[DailyOrderRow[], DailyCustomerRow[]]>,
    );

    const result = [];
    const currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);

    const endDate = new Date(now);
    endDate.setHours(0, 0, 0, 0);

    const orderMap = new Map(dailyOrderData.map((item) => [item.date, item]));
    const customerMap = new Map(
        dailyCustomerData.map((item) => [item.date, item]),
    );

    while (currentDate <= endDate) {
        const dateStr = currentDate.toISOString().split("T")[0] ?? "";
        const orderEntry = orderMap.get(dateStr);
        const customerEntry = customerMap.get(dateStr);
        result.push({
            date: dateStr,
            orders: orderEntry ? orderEntry.orderCount : 0,
            revenue: orderEntry ? orderEntry.totalRevenue : 0,
            newCustomers: customerEntry ? customerEntry.customerCount : 0,
        });
        currentDate.setDate(currentDate.getDate() + 1);
    }

    return result;
}
