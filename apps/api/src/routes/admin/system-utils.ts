// src/server/routes/admin/system-utils.ts
// Admin OpenAPI routes for system utilities (abandoned checkouts, FCM tokens).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import { sql, inArray, desc, asc, and, count } from "drizzle-orm";
import { abandonedCheckouts, adminFcmTokens } from "@scalius/database/schema";
import { ftsMatch } from "@scalius/core/search";
import { projectAbandonedCheckoutAgentSummary } from "@scalius/core/modules/orders";

import { ok, noContent } from "../../utils/api-response";
import { UnauthorizedError, ForbiddenError } from "../../utils/api-error";
import { successEnvelope, messageResponse, noContentResponse, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

// --- Abandoned Checkouts ---
// ── List Abandoned Checkouts ──

const listAbandonedCheckoutsRoute = createRoute({
    operationId: "dashboard.abandoned_checkouts.list",
    method: "get",
    path: "/abandoned-checkouts",
    tags: ["Admin - System Utils"],
    summary: "List abandoned checkouts",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(20).openapi({ description: "Items per page" }),
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: { description: "Abandoned checkout list", content: { "application/json": { schema: successEnvelope(z.object({ checkouts: z.array(z.object({ id: z.string(), checkoutId: z.string().nullable(), customerPhone: z.string().nullable(), checkoutData: z.string(), createdAt: z.union([z.string(), z.number()]), updatedAt: z.union([z.string(), z.number()]) }).passthrough()), pagination: z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() }) })) } } },
        ...errorResponses,
    }
});

app.openapi(listAbandonedCheckoutsRoute, async (c) => {
    const db = c.get("db");

    // --- Fetch Data for UI ---
    try {
        const query = c.req.valid("query");
        const page = query.page;
        const limit = query.limit;
        const search = query.search || "";
        const sortField = (query.sort || "updatedAt") as string;
        const orderStr = query.order || "desc";
        const offset = (page - 1) * limit;

        const whereConditions = [];
        if (search) {
            const digitsOnly = search.replace(/[^0-9]/g, "");
            const looksLikePhone = digitsOnly.length >= 4 && digitsOnly.length / search.replace(/\s/g, "").length > 0.5;
            const ftsCondition = ftsMatch(db, "abandoned_checkouts_fts", "abandoned_checkouts", search);

            if (looksLikePhone && ftsCondition) {
                whereConditions.push(sql`(${ftsCondition} OR ${abandonedCheckouts.customerPhone} LIKE ${"%" + digitsOnly + "%"})`);
            } else if (looksLikePhone) {
                whereConditions.push(sql`${abandonedCheckouts.customerPhone} LIKE ${"%" + digitsOnly + "%"}`);
            } else if (ftsCondition) {
                whereConditions.push(ftsCondition);
            }
        }

        const combinedWhere = whereConditions.length > 0 ? and(...whereConditions) : undefined;

        // Safe column access — fall back to updatedAt if sort field doesn't exist
        const sortColumn = (sortField in abandonedCheckouts)
            ? abandonedCheckouts[sortField as keyof typeof abandonedCheckouts._.columns]
            : abandonedCheckouts.updatedAt;

        const results = await db.select().from(abandonedCheckouts).where(combinedWhere).orderBy(
            orderStr === 'asc' ? asc(sortColumn) : desc(sortColumn)
        ).limit(limit).offset(offset);

        const totalResult = await db.select({ total: count() }).from(abandonedCheckouts).where(combinedWhere);
        const total = totalResult[0]?.total ?? 0;

        return ok(c, {
            checkouts: results,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
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
    paymentMethod: z.enum(["stripe", "sslcommerz", "polar"]).nullable(),
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
                pagination: z.object({
                    page: z.number().int(),
                    limit: z.number().int(),
                    total: z.number().int(),
                    totalPages: z.number().int(),
                }),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(listAbandonedCheckoutSummariesRoute, async (c) => {
    const db = c.get("db");
    const { page, limit, search, order } = c.req.valid("query");
    const offset = (page - 1) * limit;
    const whereConditions = [];
    if (search) {
        const digitsOnly = search.replace(/[^0-9]/g, "");
        const compactSearch = search.replace(/\s/g, "");
        const looksLikePhone = digitsOnly.length >= 4
            && compactSearch.length > 0
            && digitsOnly.length / compactSearch.length > 0.5;
        const ftsCondition = ftsMatch(db, "abandoned_checkouts_fts", "abandoned_checkouts", search);
        if (looksLikePhone && ftsCondition) {
            whereConditions.push(sql`(${ftsCondition} OR ${abandonedCheckouts.customerPhone} LIKE ${"%" + digitsOnly + "%"})`);
        } else if (looksLikePhone) {
            whereConditions.push(sql`${abandonedCheckouts.customerPhone} LIKE ${"%" + digitsOnly + "%"}`);
        } else if (ftsCondition) {
            whereConditions.push(ftsCondition);
        }
    }
    const combinedWhere = whereConditions.length > 0 ? and(...whereConditions) : undefined;
    const rows = await db.select({
        id: abandonedCheckouts.id,
        customerPhone: abandonedCheckouts.customerPhone,
        checkoutData: abandonedCheckouts.checkoutData,
        createdAt: abandonedCheckouts.createdAt,
        updatedAt: abandonedCheckouts.updatedAt,
    }).from(abandonedCheckouts).where(combinedWhere)
        .orderBy(order === "asc" ? asc(abandonedCheckouts.updatedAt) : desc(abandonedCheckouts.updatedAt))
        .limit(limit).offset(offset);
    const totalResult = await db.select({ total: count() }).from(abandonedCheckouts).where(combinedWhere);
    const total = totalResult[0]?.total ?? 0;

    return ok(c, {
        checkouts: rows.map(({ checkoutData, customerPhone, ...row }) => ({
            ...row,
            ...projectAbandonedCheckoutAgentSummary(checkoutData, customerPhone),
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
});

// ── Bulk Delete Abandoned Checkouts (POST) ──

const bulkDeleteSchema = z.object({
    ids: z.array(z.string()).min(1, "No IDs provided")
});

const bulkDeleteCheckoutsRoute = createRoute({
    operationId: "dashboard.abandoned_checkouts.bulk_delete_legacy",
    method: "post",
    path: "/abandoned-checkouts/bulk-delete",
    tags: ["Admin - System Utils"],
    summary: "Bulk delete abandoned checkouts",
    request: {
        body: { content: { "application/json": { schema: bulkDeleteSchema } } }
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(bulkDeleteCheckoutsRoute, async (c) => {
    const db = c.get("db");
    try {
        const { ids } = c.req.valid("json");
        await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.id, ids));
        return noContent(c);
    } catch (error: unknown) {
        console.error("Error bulk deleting checkouts:", error);
        throw error;
    }
});

// ── Bulk Delete Abandoned Checkouts (DELETE) ──

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
        await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.id, ids));
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
