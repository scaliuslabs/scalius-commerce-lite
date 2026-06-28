import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import {
    PartialRefundProcessedError,
    processReturn,
    processRefund,
    type RefundNotificationFact,
} from "@scalius/core/modules/payments/refund-service";
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ForbiddenError, ValidationError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope } from "../../schemas/responses";
import { invalidateProductAvailabilityCaches } from "../../utils/cache-invalidation";
import {
    enqueueOrderRefundNotificationForOrder,
    enqueueOrderStatusChangeNotification,
} from "../../utils/order-notification-queue";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── Inline response schemas ────────────────────────────────────────────────

const refundResultSchema = z.object({
    success: z.boolean(),
    gateway: z.string(),
    refundId: z.string().optional(),
    amount: z.number(),
    isFullRefund: z.boolean(),
    error: z.string().optional(),
}).passthrough();

const returnResultSchema = successEnvelope(z.object({
    refundResult: refundResultSchema.optional(),
}));

async function enqueueRefundNotification(options: {
    db: Database;
    queue: Env["ORDER_NOTIFICATIONS_QUEUE"] | undefined;
    orderId: string;
    result: {
        gateway: string;
        refundId?: string;
        refundNotification?: {
            notificationType: "order_refunded" | "order_partially_refunded";
            dedupeKey: string;
            amount: number;
            refundId?: string;
        };
    };
    source: string;
}) {
    const notification = options.result.refundNotification;
    if (!notification) return;
    await enqueueRefundNotificationFact({
        db: options.db,
        queue: options.queue,
        orderId: options.orderId,
        gateway: options.result.gateway,
        notification,
        source: options.source,
    });
}

async function enqueueRefundNotificationFact(options: {
    db: Database;
    queue: Env["ORDER_NOTIFICATIONS_QUEUE"] | undefined;
    orderId: string;
    gateway?: string;
    notification: RefundNotificationFact | {
        notificationType: "order_refunded" | "order_partially_refunded";
        dedupeKey: string;
        amount: number;
        refundId?: string;
    };
    source: string;
}) {
    await enqueueOrderRefundNotificationForOrder({
        db: options.db,
        queue: options.queue,
        orderId: options.orderId,
        notificationType: options.notification.notificationType,
        dedupeKey: options.notification.dedupeKey,
        source: options.source,
        data: {
            amount: options.notification.amount,
            ...(options.gateway ? { gateway: options.gateway } : {}),
            ...(options.notification.refundId ? { refundId: options.notification.refundId } : {}),
        },
    });
}

async function recordPartialRefundProcessedSideEffects(options: {
    db: Database;
    queue: Env["ORDER_NOTIFICATIONS_QUEUE"] | undefined;
    error: PartialRefundProcessedError;
    context: Parameters<typeof invalidateProductAvailabilityCaches>[2];
    source: string;
    statusSource?: string;
}) {
    try {
        await invalidateProductAvailabilityCaches(
            options.db,
            { orderIds: options.error.affectedOrderIds },
            options.context,
        );
        if (options.error.statusChange && options.statusSource) {
            await enqueueOrderStatusChangeNotification({
                db: options.db,
                queue: options.queue,
                statusChange: options.error.statusChange,
                source: options.statusSource,
            });
        }
        for (const notification of options.error.refundNotifications) {
            await enqueueRefundNotificationFact({
                db: options.db,
                queue: options.queue,
                orderId: notification.orderId,
                gateway: options.error.gateway,
                notification,
                source: options.source,
            });
        }
    } catch (sideEffectError: unknown) {
        console.error("[orders-refund] Partial refund side effects failed after local commit:", sideEffectError);
    }
}

function publicRefundResult<T extends { refundNotification?: unknown }>(result: T): Omit<T, "refundNotification"> {
    const { refundNotification: _refundNotification, ...publicResult } = result;
    return publicResult;
}

// ─── POST /:id/return ────────────────────────────────────────────────────────

const returnOrderRoute = createRoute({
    method: "post",
    path: "/{id}/return",
    tags: ["Admin - Orders"],
    summary: "Process order return",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: z.object({ reason: z.string().optional(), autoRefund: z.boolean().optional() }) } } }
    },
    responses: {
        200: {
            description: "Return processed",
            content: { "application/json": { schema: returnResultSchema } },
        },
    }
});

app.openapi(returnOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db");
    if (data.autoRefund) {
        const user = c.get("user") as { id?: string } | undefined;
        const userPerms = user?.id ? await getUserPermissions(db, user.id) : new Set<string>();
        if (!userPerms.has(PERMISSIONS.ORDERS_REFUND)) {
            throw new ForbiddenError("Refund permission is required to auto-refund a returned order");
        }
    }
    const envCache = c.env?.CACHE;
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    let result: Awaited<ReturnType<typeof processReturn>>;
    try {
        result = await processReturn(
            db,
            envCache,
            { orderId, reason: data.reason ?? "Customer return", autoRefund: data.autoRefund ?? false },
            encryptionKey,
        );
    } catch (error: unknown) {
        if (error instanceof PartialRefundProcessedError) {
            await recordPartialRefundProcessedSideEffects({
                db,
                queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
                error,
                context: c,
                source: "orders-return-refund-partial-failure",
                statusSource: "orders-return",
            });
        }
        throw error;
    }
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);
    if (result.statusChange) {
        await enqueueOrderStatusChangeNotification({
            db,
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
            statusChange: result.statusChange,
            source: "orders-return",
        });
    }
    if (result.refundResult?.success) {
        await enqueueRefundNotification({
            db,
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
            orderId,
            result: result.refundResult,
            source: "orders-return-refund",
        });
    }
    return ok(c, {
        ...(result.refundResult ? { refundResult: publicRefundResult(result.refundResult) } : {}),
    });
});

// ─── POST /:id/refund ────────────────────────────────────────────────────────

const refundOrderRoute = createRoute({
    method: "post",
    path: "/{id}/refund",
    tags: ["Admin - Orders"],
    summary: "Process order refund",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        amount: z.number().optional(),
                        reason: z.string().optional(),
                        gateway: z.enum(["stripe", "sslcommerz", "polar", "cod"]).optional()
                    })
                }
            }
        }
    },
    responses: {
        200: {
            description: "Refund processed",
            content: { "application/json": { schema: successEnvelope(refundResultSchema) } },
        },
    }
});

app.openapi(refundOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db");
    const envCache = c.env?.CACHE;
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    let result: Awaited<ReturnType<typeof processRefund>>;
    try {
        result = await processRefund(
            db,
            envCache,
            { orderId, amount: data.amount, reason: data.reason ?? "Refund requested", gateway: data.gateway },
            encryptionKey,
        );
    } catch (error: unknown) {
        if (error instanceof PartialRefundProcessedError) {
            await recordPartialRefundProcessedSideEffects({
                db,
                queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
                error,
                context: c,
                source: "orders-refund-partial-failure",
            });
        }
        throw error;
    }
    if (!result.success) throw new ValidationError(result.error || "Refund processing failed");
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);
    await enqueueRefundNotification({
        db,
        queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
        orderId,
        result,
        source: "orders-refund",
    });
    return ok(c, publicRefundResult(result));
});

export { app as adminOrdersRefundRoutes };
