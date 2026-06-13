// src/server/routes/admin/system-utils.ts
// Admin OpenAPI routes for system utilities (abandoned checkouts, FCM tokens).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import { sql, inArray, desc, asc, and, count, eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { abandonedCheckouts, orders, OrderStatus, adminFcmTokens } from "@scalius/database/schema";
import { applyInventoryForStatusChange } from "@scalius/core/modules/inventory";
import { hasActiveShipmentClaim } from "@scalius/core/modules/orders/shipment-claim";
import { ftsMatch } from "@scalius/core/search";

import { ok, noContent } from "../../utils/api-response";
import { UnauthorizedError, ForbiddenError } from "../../utils/api-error";
import { successEnvelope, messageResponse, noContentResponse, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

// --- Abandoned Checkouts ---
type AbandonedCheckoutCleanupResult = {
    archived: number;
    failed: number;
    errors: Array<{ orderId: string; error: string }>;
};

const isCheckoutEmpty = (checkout: { checkoutData: string; customerPhone: string | null }): boolean => {
    if (checkout.customerPhone) return false;
    try {
        const data = JSON.parse(checkout.checkoutData);
        const items = data.items || [];
        const customerInfo = data.customerInfo || {};

        const hasItems = Array.isArray(items) && items.length > 0;
        const hasCustomerInfo = Object.values(customerInfo).some((val) => !!val);

        return !hasItems && !hasCustomerInfo;
    } catch {
        return true;
    }
};

export async function archiveStaleIncompleteOrders(
    db: Database,
    cutoffTimestamp: number,
): Promise<AbandonedCheckoutCleanupResult> {
    const result: AbandonedCheckoutCleanupResult = {
        archived: 0,
        failed: 0,
        errors: [],
    };

    const incompleteOrders = await db.select().from(orders).where(
        and(
            eq(orders.status, OrderStatus.INCOMPLETE),
            sql`${orders.createdAt} <= ${cutoffTimestamp}`,
            sql`${orders.deletedAt} IS NULL`,
        ),
    );

    for (const order of incompleteOrders) {
        try {
            if (hasActiveShipmentClaim(order)) {
                continue;
            }

            if (order.inventoryAction === "reserved" || order.inventoryAction === "deducted") {
                await applyInventoryForStatusChange(db, order.id, OrderStatus.CANCELLED);
            }

            await db.insert(abandonedCheckouts).values({
                id: `ab_ch_sys_${order.id}`,
                checkoutId: order.id,
                customerPhone: order.customerPhone,
                checkoutData: JSON.stringify(order),
                createdAt: order.createdAt || new Date(),
                updatedAt: order.updatedAt || new Date()
            }).onConflictDoNothing();

            await db.update(orders)
                .set({
                    status: OrderStatus.CANCELLED,
                    deletedAt: sql`unixepoch()`,
                    inventoryAction: "restored",
                    version: sql`${orders.version} + 1`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(orders.id, order.id));

            result.archived++;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.failed++;
            result.errors.push({ orderId: order.id, error: message });
            console.error(`Failed to archive stale incomplete order ${order.id}:`, error);
        }
    }

    return result;
}

// ── List Abandoned Checkouts ──

const listAbandonedCheckoutsRoute = createRoute({
    method: "get",
    path: "/abandoned-checkouts",
    tags: ["Admin - System Utils"],
    summary: "List abandoned checkouts with cleanup",
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

    // --- Perform Cleanup (best-effort, don't fail the request) ---
    try {
        const thirtyDaysAgoTimestamp = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
        await db.delete(abandonedCheckouts).where(sql`${abandonedCheckouts.createdAt} <= ${thirtyDaysAgoTimestamp}`);

        const oneHourAgoTimestamp = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
        const staleOrderCleanup = await archiveStaleIncompleteOrders(db, oneHourAgoTimestamp);
        if (staleOrderCleanup.failed > 0) {
            console.error("Some stale incomplete orders could not be archived:", staleOrderCleanup.errors);
        }

        const candidatesForDeletion = await db.select().from(abandonedCheckouts).where(sql`${abandonedCheckouts.updatedAt} <= ${oneHourAgoTimestamp}`);

        const emptyCheckoutIds = candidatesForDeletion
            .filter((c) => isCheckoutEmpty({ checkoutData: c.checkoutData, customerPhone: c.customerPhone }))
            .map((c) => c.id);

        if (emptyCheckoutIds.length > 0) {
            await db.delete(abandonedCheckouts).where(inArray(abandonedCheckouts.id, emptyCheckoutIds));
        }
    } catch (cleanupErr) {
        console.error("Abandoned checkout cleanup failed (non-fatal):", cleanupErr);
    }

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
            const ftsCondition = ftsMatch("abandoned_checkouts_fts", "abandoned_checkouts", search);

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

// ── Bulk Delete Abandoned Checkouts (POST) ──

const bulkDeleteSchema = z.object({
    ids: z.array(z.string()).min(1, "No IDs provided")
});

const bulkDeleteCheckoutsRoute = createRoute({
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
    token: z.string().min(1, "FCM token is required"),
    userId: z.string().min(1, "User ID is required"),
    deviceInfo: z.string().optional()
});

const registerFcmTokenRoute = createRoute({
    method: "post",
    path: "/fcm-token",
    tags: ["Admin - System Utils"],
    summary: "Register an FCM push notification token",
    request: {
        body: { content: { "application/json": { schema: fcmTokenSchema } } }
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
    invalidTokens: z.array(z.string()).min(1)
});

const cleanupFcmTokensRoute = createRoute({
    method: "post",
    path: "/fcm-token-cleanup",
    tags: ["Admin - System Utils"],
    summary: "Clean up invalid FCM tokens",
    request: {
        body: { content: { "application/json": { schema: cleanupSchema } } }
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
