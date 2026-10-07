// src/server/routes/admin/dashboard.ts
// Admin OpenAPI routes for the Home summary and daily activity.
//
// Home is open to `dashboard.view`, but money is not: every revenue value is
// null unless the caller also holds `dashboard.analytics` ("View sales
// numbers"), and the recent-order feed (customer names and order totals) is
// empty unless they hold `orders.view`. The projection happens here, at the
// boundary, so no client can read what the role excludes.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
    getDashboardHomeSummary,
    getDailyActivityData,
} from "@scalius/core/modules/analytics";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { BANGLADESH_PACK_ID } from "@scalius/core/integrations/retired-providers";
import { getSetupGuideFacts, getStoreSetupStatus } from "@scalius/core/modules/onboarding";
import { getPaymentGatewaySettingsSnapshot } from "@scalius/core/modules/payments";
import { getPluginInstallation, pluginNeedsApproval } from "@scalius/core/modules/plugins";
import { getPlatformSettings } from "@scalius/core/modules/platform";
import { dismissSetupGuide, getCurrencySettings, readSetupGuideDismissed } from "@scalius/core/modules/settings";

import { BUNDLED_PLUGINS } from "../../plugins/bundled.gen";
import { PLUGIN_CATALOG } from "../../plugins/catalog.gen";
import { requestPaymentProviders } from "../../plugins/providers/payment";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { ok } from "../../utils/api-response";
import { successEnvelope } from "../../schemas/responses";
import { timestampSchema } from "../../schemas/timestamps";
import { storeTimeZoneOf } from "../../utils/store-time-zone";

const app = new OpenAPIHono<{ Bindings: Env }>();
const DASHBOARD_RECENT_ORDER_LIMIT = 11;
const DASHBOARD_ORDER_ID_MAX_LENGTH = 128;
const DASHBOARD_CUSTOMER_NAME_MAX_LENGTH = 256;
const DASHBOARD_ORDER_STATUS_MAX_LENGTH = 64;

function boundedText(value: unknown, maximumLength: number): string {
    return typeof value === "string" ? value.slice(0, maximumLength) : "";
}

/** What this caller may see on Home beyond counts. */
function homeAccess(c: Context) {
    const permissions: ReadonlySet<string> = c.get("adminPermissions") ?? new Set();
    return {
        sales: permissions.has(PERMISSIONS.DASHBOARD_ANALYTICS),
        orders: permissions.has(PERMISSIONS.ORDERS_VIEW),
    };
}

/** Revenue only for callers who may see sales numbers. */
const money = (value: number, sales: boolean) => (sales ? value : null);

// ─── Response schemas ──

const dashboardStatsSchema = z.object({
    totalProducts: z.number(),
    totalCustomers: z.number(),
    currentMonth: z.object({
        orders: z.number(),
        /** Null without the "View sales numbers" permission. */
        revenue: z.number().nullable(),
        orderGrowth: z.number().nullable(),
        revenueGrowth: z.number().nullable(),
        orderStatus: z.object({
            delivered: z.number(),
            processing: z.number(),
            shipping: z.number(),
            cancelled: z.number(),
        }),
    }),
    lastMonth: z.object({
        orders: z.number(),
        revenue: z.number().nullable(),
    }),
});

const recentOrderSchema = z.object({
    id: z.string().max(DASHBOARD_ORDER_ID_MAX_LENGTH),
    orderNumber: z.number().int().nullable(),
    customerName: z.string().max(DASHBOARD_CUSTOMER_NAME_MAX_LENGTH),
    totalAmount: z.number(),
    status: z.string().max(DASHBOARD_ORDER_STATUS_MAX_LENGTH),
    createdAt: timestampSchema,
});

const dailyActivitySchema = z.object({
    date: z.string().max(10),
    orders: z.number(),
    /** Null without the "View sales numbers" permission. */
    revenue: z.number().nullable(),
    newCustomers: z.number(),
});

const dashboardHomeSummaryResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema,
    recentOrders: z.array(recentOrderSchema).max(DASHBOARD_RECENT_ORDER_LIMIT),
}));

const dashboardActivityResponseSchema = successEnvelope(z.object({
    dailyActivityData: z.array(dailyActivitySchema).max(90),
}));

// ── Home summary ──

const dashboardHomeSummaryRoute = createRoute({
    method: "get",
    path: "/home-summary",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard home metrics and recent orders",
    description: "Answer current-month order-count, customer and recent-order questions. Revenue values are null unless the caller may view sales numbers; recent orders are empty unless the caller may view orders.",
    operationId: "dashboard.home.summary",
    responses: {
        200: {
            description: "Dashboard home summary data",
            content: { "application/json": { schema: dashboardHomeSummaryResponseSchema } },
        },
    },
});

app.openapi(dashboardHomeSummaryRoute, async (c) => {
    const access = homeAccess(c);
    const { stats, recentOrders } = await getDashboardHomeSummary(
        c.get("db"),
        access.orders ? DASHBOARD_RECENT_ORDER_LIMIT : 0,
        storeTimeZoneOf(c.env),
    );
    return ok(c, {
        stats: {
            ...stats,
            currentMonth: {
                ...stats.currentMonth,
                revenue: money(stats.currentMonth.revenue, access.sales),
                revenueGrowth: access.sales ? stats.currentMonth.revenueGrowth : null,
            },
            lastMonth: {
                ...stats.lastMonth,
                revenue: money(stats.lastMonth.revenue, access.sales),
            },
        },
        recentOrders: recentOrders.slice(0, DASHBOARD_RECENT_ORDER_LIMIT).map((order) => ({
            id: boundedText(order.id, DASHBOARD_ORDER_ID_MAX_LENGTH),
            orderNumber: order.orderNumber ?? null,
            customerName: boundedText(order.customerName, DASHBOARD_CUSTOMER_NAME_MAX_LENGTH),
            totalAmount: order.totalAmount,
            status: boundedText(order.status, DASHBOARD_ORDER_STATUS_MAX_LENGTH),
            createdAt: order.createdAt,
        })),
    });
});

// ── Daily activity ──

const dashboardActivityRoute = createRoute({
    method: "get",
    path: "/activity",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard daily activity chart data",
    description: "Answer daily or today's sales, revenue, order-count, and new-customer questions. Request days=1 for a minimal current-day result; the dashboard defaults to 90 days. Revenue is null unless the caller may view sales numbers.",
    operationId: "dashboard.home.activity",
    request: {
        query: z.object({
            days: z.coerce.number().int().min(1).max(90).optional().default(90)
                .openapi({ description: "Merchant-calendar days ending today; use 1 for today's summary" }),
        }),
    },
    responses: {
        200: {
            description: "Dashboard daily activity data",
            content: { "application/json": { schema: dashboardActivityResponseSchema } },
        },
    },
});

app.openapi(dashboardActivityRoute, async (c) => {
    const { days } = c.req.valid("query");
    const { sales } = homeAccess(c);
    const activity = await getDailyActivityData(c.get("db"), days, storeTimeZoneOf(c.env));

    return ok(c, {
        dailyActivityData: activity.slice(0, 90).map((entry) => ({
            date: boundedText(entry.date, 10),
            orders: entry.orders,
            revenue: money(entry.revenue, sales),
            newCustomers: entry.newCustomers,
        })),
    });
});

// ── Setup guide ──

const setupGuideSchema = z.object({
    dismissed: z.boolean().openapi({ description: "This staff member dismissed the guide." }),
    countryCode: z.string().length(2).openapi({ description: "The store's country; the guide shows country-specific steps for it." }),
    setupNeeded: z.boolean().openapi({ description: "The new-store setup step (name, country, currency, time zone) still applies." }),
    steps: z.object({
        product: z.boolean().openapi({ description: "A product exists outside the trash." }),
        details: z.boolean().openapi({ description: "The store has a name." }),
        theme: z.boolean().openapi({ description: "The theme was published from the editor." }),
        payments: z.boolean().openapi({ description: "Checkout offers a payment method that is ready, in the store's currency and for its country." }),
        shipping: z.boolean().openapi({ description: "A live delivery rate serves a place, or local pickup is on." }),
        domain: z.boolean().openapi({ description: "The storefront web address is set." }),
        order: z.boolean().openapi({ description: "An order exists." }),
    }),
    bangladeshPack: z.object({ active: z.boolean() }).nullable().openapi({
        description: "The Bangladesh pack, for a Bangladesh store whose deployment includes it; null otherwise.",
    }),
});

const setupGuideRoute = createRoute({
    method: "get",
    path: "/setup-guide",
    tags: ["Admin - Dashboard"],
    summary: "Get Home's setup guide",
    description: "Which of the store's first steps are done (each read from the store's own data) and whether this staff member dismissed the guide.",
    operationId: "dashboard.home.setup_guide",
    responses: {
        200: { description: "Setup guide", content: { "application/json": { schema: successEnvelope(setupGuideSchema) } } },
    },
});

app.openapi(setupGuideRoute, async (c) => {
    const db = c.get("db");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const [facts, setup, dismissed, platform, currency, providers, pack] = await Promise.all([
        getSetupGuideFacts(db),
        getStoreSetupStatus(db),
        readSetupGuideDismissed(db, c.get("user").id),
        getPlatformSettings(db),
        getCurrencySettings(db),
        requestPaymentProviders(c),
        getPluginInstallation(db, BANGLADESH_PACK_ID),
    ]);
    const countryCode = setup.current.countryCode;
    const snapshot = await getPaymentGatewaySettingsSnapshot(db, encryptionKey, providers);
    const offered = providers
        .filterForCurrency(snapshot.activePaymentMethods.enabledMethods, currency.currencyCode)
        .filter((method) => providers.countryIssue(method, countryCode) === null);
    c.header("Cache-Control", "private, no-store");
    return ok(c, {
        dismissed,
        countryCode,
        setupNeeded: setup.needed,
        steps: {
            product: facts.hasProducts,
            details: setup.current.storeName.trim() !== "",
            theme: facts.themePublished,
            payments: offered.length > 0,
            shipping: facts.shippingReady,
            domain: platform.storefrontUrl.trim() !== "",
            order: facts.hasOrders,
        },
        bangladeshPack: countryCode !== "BD" || (!pack && !(BANGLADESH_PACK_ID in BUNDLED_PLUGINS) && !PLUGIN_CATALOG.some((entry) => entry.id === BANGLADESH_PACK_ID))
            ? null
            : { active: pack?.status === "active" && !pluginNeedsApproval(pack) },
    });
});

const dismissSetupGuideRoute = createRoute({
    method: "post",
    path: "/setup-guide/dismiss",
    tags: ["Admin - Dashboard"],
    summary: "Dismiss Home's setup guide",
    description: "Hides the setup guide for the signed-in staff member only. Saying it again changes nothing.",
    operationId: "dashboard.home.setup_guide_dismiss",
    responses: {
        200: { description: "Setup guide dismissed", content: { "application/json": { schema: successEnvelope(z.object({ dismissed: z.literal(true) })) } } },
    },
});

app.openapi(dismissSetupGuideRoute, async (c) => {
    await dismissSetupGuide(c.get("db"), c.get("user").id);
    c.header("Cache-Control", "private, no-store");
    return ok(c, { dismissed: true as const });
});

export { app as adminDashboardRoutes };
