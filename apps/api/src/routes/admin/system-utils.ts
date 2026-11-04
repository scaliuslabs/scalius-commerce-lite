// src/server/routes/admin/system-utils.ts
// Admin OpenAPI routes for system utilities (abandoned checkouts, FCM tokens).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { assertContactSearchAllowed } from "./contact-access";
import { createId } from "@paralleldrive/cuid2";
import { sql, inArray, desc, asc, eq } from "drizzle-orm";
import { containsText } from "@scalius/core/utils/text-match";
import { COUNT_PROBE_COLUMN, cappedCountQuery } from "@scalius/core/utils/keyset";
import { AppError } from "@scalius/core/errors";
import { formatNumber } from "@scalius/shared/locale-format";
import { LIST_OFFSET_ERROR_CODE, capTotal } from "@scalius/shared/pagination";
import { planLimits } from "@scalius/shared/plan-limits";
import { inJsonArray } from "@scalius/core/utils/in-json-array";
import { abandonedCheckouts, adminFcmTokens } from "@scalius/database/schema";
import { searchMatch } from "@scalius/core/search";
import { projectAbandonedCheckoutAgentSummary } from "@scalius/core/modules/checkout";

import { ok, noContent } from "../../utils/api-response";
import { UnauthorizedError, ForbiddenError, NotFoundError } from "../../utils/api-error";
import { successEnvelope, messageResponse, noContentResponse, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

// --- Abandoned Checkouts ---
// ── List Abandoned Checkouts ──

/**
 * The sorts the dashboard offers, each one an index read in order:
 * updatedAt on abandoned_checkouts_updated_idx, customerPhone on
 * abandoned_checkouts_empty_candidate_idx and checkoutId on the unique
 * ab_checkout_id_unique. Any other column name is refused by validation.
 */
const ABANDONED_CHECKOUT_SORTS = ["updatedAt", "customerPhone", "checkoutId"] as const;

/** Same direction for every term, ending in the id so equal values keep one order. */
function abandonedCheckoutOrderBy(sort: (typeof ABANDONED_CHECKOUT_SORTS)[number], order: "asc" | "desc") {
    const direction = order === "asc" ? asc : desc;
    switch (sort) {
        case "customerPhone":
            return [direction(abandonedCheckouts.customerPhone), direction(abandonedCheckouts.updatedAt), direction(abandonedCheckouts.id)];
        case "checkoutId":
            return [direction(abandonedCheckouts.checkoutId)];
        default:
            return [direction(abandonedCheckouts.updatedAt), direction(abandonedCheckouts.id)];
    }
}

/**
 * Numbered pages reach the plan's first maxOffset rows only; deeper is a typed
 * 400. These lists have no cursor: a search narrows them instead.
 */
function assertPageReachable(offset: number) {
    const { maxOffset } = planLimits().lists;
    if (offset < maxOffset) return;
    throw new AppError(
        400,
        LIST_OFFSET_ERROR_CODE,
        `Abandoned checkout pages reach the first ${formatNumber(maxOffset, "en")} rows of a sort only (this page starts at row ${formatNumber(offset + 1, "en")}). Search by phone or name, or reverse the sort, to reach the others.`,
        { maxOffset, hint: "Start again from page 1, or search to narrow the list." },
    );
}

/** The search box: the checkout search index, or the phone digits when the term looks like a phone. */
function abandonedCheckoutSearchCondition(db: Parameters<typeof searchMatch>[0], search: string) {
    if (!search) return undefined;
    const digitsOnly = search.replace(/[^0-9]/g, "");
    const compactSearch = search.replace(/\s/g, "");
    const looksLikePhone = digitsOnly.length >= 4
        && compactSearch.length > 0
        && digitsOnly.length / compactSearch.length > 0.5;
    const ftsCondition = searchMatch(db, "abandoned_checkouts", search);
    if (looksLikePhone && ftsCondition) {
        return sql`(${ftsCondition} OR ${containsText(abandonedCheckouts.customerPhone, digitsOnly)})`;
    }
    if (looksLikePhone) return containsText(abandonedCheckouts.customerPhone, digitsOnly);
    return ftsCondition ?? undefined;
}

const abandonedCheckoutPaginationSchema = z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    /** `total` is a lower bound ("1,000+"): more rows match than the count reads. */
    totalIsCapped: z.boolean(),
    totalPages: z.number().int(),
});

const abandonedCheckoutSchema = z.object({ id: z.string(), checkoutId: z.string().nullable(), customerPhone: z.string().nullable(), checkoutData: z.string(), createdAt: z.union([z.string(), z.number()]), updatedAt: z.union([z.string(), z.number()]) });

const abandonedCheckoutColumns = {
    id: abandonedCheckouts.id,
    checkoutId: abandonedCheckouts.checkoutId,
    customerPhone: abandonedCheckouts.customerPhone,
    checkoutData: abandonedCheckouts.checkoutData,
    createdAt: abandonedCheckouts.createdAt,
    updatedAt: abandonedCheckouts.updatedAt,
};

const listAbandonedCheckoutsRoute = createRoute({
    operationId: "dashboard.abandoned_checkouts.list",
    method: "get",
    path: "/abandoned-checkouts",
    tags: ["Admin - System Utils"],
    summary: "List abandoned checkouts",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            sort: z.enum(ABANDONED_CHECKOUT_SORTS).default("updatedAt").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: { description: "Abandoned checkout list", content: { "application/json": { schema: successEnvelope(z.object({ checkouts: z.array(abandonedCheckoutSchema), pagination: abandonedCheckoutPaginationSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(listAbandonedCheckoutsRoute, async (c) => {
    const db = c.get("db");

    try {
        const { page, limit, search, sort, order } = c.req.valid("query");
        // Searching by a buyer's phone or name needs the contact permission, as on the summaries list.
        assertContactSearchAllowed(c, "search", search);
        const offset = (page - 1) * limit;
        assertPageReachable(offset);

        const combinedWhere = abandonedCheckoutSearchCondition(db, search);

        // The count reads at most the plan's count cap + 1 index rows, never the table.
        const [counted, results] = await db.batch([
            cappedCountQuery(db, db.select(COUNT_PROBE_COLUMN).from(abandonedCheckouts).where(combinedWhere).$dynamic()),
            db.select(abandonedCheckoutColumns).from(abandonedCheckouts).where(combinedWhere)
                .orderBy(...abandonedCheckoutOrderBy(sort, order))
                .limit(limit).offset(offset),
        ]);
        const { total, totalIsCapped } = capTotal(Number(counted[0]?.count ?? 0));

        return ok(c, {
            checkouts: results,
            pagination: { page, limit, total, totalIsCapped, totalPages: Math.ceil(total / limit) },
        });

    } catch (error: unknown) {
        console.error("Error fetching abandoned checkouts:", error);
        throw error;
    }
});

const abandonedCheckoutAgentSummarySchema = z.object({
    id: z.string().max(160),
    kind: z.enum(["cart", "stale_hosted_payment_order", "unknown"]),
    stage: z.enum(["session_created", "cart_started", "info_captured", "archived_hosted_payment", "unreadable"]),
    itemCount: z.number().int().min(0).max(100),
    total: z.number().min(0),
    hasCustomerContact: z.boolean(),
    orderId: z.string().max(160).nullable(),
    paymentMethod: z.string().max(64).nullable(),
    paymentStatus: z.enum(["unpaid", "failed"]).nullable(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
});

const listAbandonedCheckoutSummariesRoute = createRoute({
    operationId: "dashboard.abandoned_checkouts.summaries_list",
    method: "get",
    path: "/abandoned-checkouts/summaries",
    tags: ["Admin - System Utils"],
    summary: "List compact abandoned checkout summaries for agent workflows",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(100).default(20),
            search: z.string().max(160).optional().default(""),
            order: z.enum(["asc", "desc"]).default("desc"),
        }),
    },
    responses: {
        200: {
            description: "PII-minimized abandoned checkout summaries",
            content: { "application/json": { schema: successEnvelope(z.object({
                checkouts: z.array(abandonedCheckoutAgentSummarySchema).max(100),
                pagination: abandonedCheckoutPaginationSchema,
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(listAbandonedCheckoutSummariesRoute, async (c) => {
    const db = c.get("db");
    const { page, limit, search, order } = c.req.valid("query");
    assertContactSearchAllowed(c, "search", search);
    const offset = (page - 1) * limit;
    assertPageReachable(offset);
    const combinedWhere = abandonedCheckoutSearchCondition(db, search);
    const [counted, rows] = await db.batch([
        cappedCountQuery(db, db.select(COUNT_PROBE_COLUMN).from(abandonedCheckouts).where(combinedWhere).$dynamic()),
        db.select({
            id: abandonedCheckouts.id,
            customerPhone: abandonedCheckouts.customerPhone,
            checkoutData: abandonedCheckouts.checkoutData,
            createdAt: abandonedCheckouts.createdAt,
            updatedAt: abandonedCheckouts.updatedAt,
        }).from(abandonedCheckouts).where(combinedWhere)
            .orderBy(...abandonedCheckoutOrderBy("updatedAt", order))
            .limit(limit).offset(offset),
    ]);
    const { total, totalIsCapped } = capTotal(Number(counted[0]?.count ?? 0));

    return ok(c, {
        checkouts: rows.map(({ checkoutData, customerPhone, ...row }) => ({
            ...row,
            ...projectAbandonedCheckoutAgentSummary(checkoutData, customerPhone),
        })),
        pagination: { page, limit, total, totalIsCapped, totalPages: Math.ceil(total / limit) },
    });
});

// ── Delete Abandoned Checkouts ──

// A checkout opened from a link (`/orders/abandoned/<id>`) that is not on the list's loaded page.
// Registered after `/abandoned-checkouts/summaries`, which keeps its own route.
const getAbandonedCheckoutRoute = createRoute({
    operationId: "dashboard.abandoned_checkouts.get",
    method: "get",
    path: "/abandoned-checkouts/{id}",
    tags: ["Admin - System Utils"],
    summary: "Get one abandoned checkout",
    request: { params: z.object({ id: z.string().min(1).max(160) }) },
    responses: {
        200: { description: "Abandoned checkout", content: { "application/json": { schema: successEnvelope(z.object({ checkout: abandonedCheckoutSchema })) } } },
        ...errorResponses,
    },
});

app.openapi(getAbandonedCheckoutRoute, async (c) => {
    const { id } = c.req.valid("param");
    const [checkout] = await c.get("db").select(abandonedCheckoutColumns).from(abandonedCheckouts)
        .where(eq(abandonedCheckouts.id, id)).limit(1);
    if (!checkout) throw new NotFoundError("Abandoned checkout not found");
    return ok(c, { checkout });
});

const bulkDeleteSchema = z.object({
    ids: z.array(z.string()).min(1, "No IDs provided")
});


const deleteCheckoutsRoute = createRoute({
    operationId: "dashboard.abandoned_checkouts.delete",
    method: "delete",
    path: "/abandoned-checkouts",
    tags: ["Admin - System Utils"],
    summary: "Delete abandoned checkouts by IDs",
    request: {
        body: { content: { "application/json": { schema: bulkDeleteSchema } } }
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(deleteCheckoutsRoute, async (c) => {
    const db = c.get("db");
    try {
        const { ids } = c.req.valid("json");
        await db.delete(abandonedCheckouts).where(inJsonArray(abandonedCheckouts.id, ids));
        return noContent(c);
    } catch (error: unknown) {
        console.error("Error bulk deleting checkouts:", error);
        throw error;
    }
});

// --- FCM Tokens ---

const fcmTokenSchema = z.object({
    token: z.string().min(1, "FCM token is required").max(4_096),
    userId: z.string().min(1, "User ID is required").max(128),
    deviceInfo: z.string().max(2_048).optional()
});

const registerFcmTokenRoute = createRoute({
    operationId: "dashboard.notifications.fcm_device_register",
    method: "post",
    path: "/fcm-token",
    tags: ["Admin - System Utils"],
    summary: "Register an FCM push notification token",
    request: {
        body: { required: true, content: { "application/json": { schema: fcmTokenSchema } } }
    },
    responses: {
        200: { description: "Token registered", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(registerFcmTokenRoute, async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    if (!user || !user.id) throw new UnauthorizedError("Unauthorized");

    const { token, userId, deviceInfo } = c.req.valid("json");

    if (userId !== user.id) {
        throw new ForbiddenError("User ID mismatch");
    }

    try {
        await db
            .insert(adminFcmTokens)
            .values({
                id: createId(),
                userId,
                token,
                deviceInfo: deviceInfo || null,
                isActive: true,
                lastUsed: sql`(cast(strftime('%s','now') as int))`,
                createdAt: sql`(cast(strftime('%s','now') as int))`,
                updatedAt: sql`(cast(strftime('%s','now') as int))`
            })
            .onConflictDoUpdate({
                target: adminFcmTokens.token,
                set: {
                    userId,
                    deviceInfo: deviceInfo || null,
                    isActive: true,
                    lastUsed: sql`(cast(strftime('%s','now') as int))`,
                    updatedAt: sql`(cast(strftime('%s','now') as int))`
                }
            });

        return ok(c, { message: "FCM token registered successfully" });
    } catch (error: unknown) {
        console.error("Error saving FCM token:", error);
        throw error;
    }
});

const cleanupSchema = z.object({
    invalidTokens: z.array(z.string().min(1).max(4_096)).min(1).max(10)
});

const cleanupFcmTokensRoute = createRoute({
    operationId: "dashboard.notifications.fcm_token_cleanup",
    method: "post",
    path: "/fcm-token-cleanup",
    tags: ["Admin - System Utils"],
    summary: "Clean up invalid FCM tokens",
    request: {
        body: { required: true, content: { "application/json": { schema: cleanupSchema } } }
    },
    responses: {
        200: { description: "Cleanup result", content: { "application/json": { schema: successEnvelope(z.object({ message: z.string(), cleanedCount: z.number() })) } } },
        ...errorResponses,
    }
});

app.openapi(cleanupFcmTokensRoute, async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    if (!user || !user.id) throw new UnauthorizedError("Unauthorized");

    try {
        const { invalidTokens } = c.req.valid("json");

        if (invalidTokens.length > 0) {
            await db
                .update(adminFcmTokens)
                .set({
                    isActive: false,
                    updatedAt: sql`(cast(strftime('%s','now') as int))`
                })
                .where(inArray(adminFcmTokens.token, invalidTokens));
        }

        const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
        await db
            .update(adminFcmTokens)
            .set({
                isActive: false,
                updatedAt: sql`(cast(strftime('%s','now') as int))`
            })
            .where(
                sql`${adminFcmTokens.lastUsed} < ${thirtyDaysAgo} OR ${adminFcmTokens.lastUsed} IS NULL`
            );

        return ok(c, {
            message: "Token cleanup completed successfully.",
            cleanedCount: invalidTokens.length
        });
    } catch (error: unknown) {
        console.error("Error cleaning up FCM tokens:", error);
        throw error;
    }
});

export { app as adminSystemUtilsRoutes };
