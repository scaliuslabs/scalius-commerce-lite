import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { recordOrderEvent } from "@scalius/core/modules/orders";
import type { Database } from "@scalius/database/client";
import {
    PartialRefundProcessedError,
    processRefund,
    type RefundNotificationFact,
    reconcileRefundAttemptForOrder,
    listPaymentMethodIds,
} from "@scalius/core/modules/payments";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
    conflictResponse,
    errorResponses,
    serviceUnavailableResponse,
    successEnvelope,
} from "../../schemas/responses";
import { bumpCacheGeneration, type CacheWriteContext } from "../../utils/cache-generation";
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
    manualSettlementRecorded: z.boolean().optional(),
    replayed: z.boolean().optional(),
    notificationCount: z.number(),
    sideEffectErrors: z.number(),
    error: z.string().optional(),
}).passthrough();

const reconcileRefundAttemptResultSchema = successEnvelope(z.object({
    attemptId: z.string(),
    status: z.enum(["finalized", "failed", "deferred"]),
    reason: z.enum([
        "not_recoverable",
        "leased",
        "pending_not_due",
        "claim_unavailable",
        "reconciliation_error",
    ]).optional(),
    orderIds: z.array(z.string()),
    notificationCount: z.number(),
    sideEffectErrors: z.number(),
}));

const adminRefundMutationErrorResponses = {
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
    503: serviceUnavailableResponse,
} as const;

const adminRefundRecoveryErrorResponses = {
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
} as const;

async function enqueueRefundNotification(options: {
    db: Database;
    queue: Env["JOBS_QUEUE"] | undefined;
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
    queue: Env["JOBS_QUEUE"] | undefined;
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
    queue: Env["JOBS_QUEUE"] | undefined;
    error: PartialRefundProcessedError;
    context: CacheWriteContext;
    source: string;
    statusSource?: string;
}) {
    try {
        if (options.error.availabilityTransitionVariantIds.length > 0) {
            await bumpCacheGeneration(options.context);
        }
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

async function recordReconciledRefundAttemptSideEffects(options: {
    db: Database;
    queue: Env["JOBS_QUEUE"] | undefined;
    orderIds: string[];
    notifications: RefundNotificationFact[];
    context: CacheWriteContext;
}): Promise<{ notificationCount: number; sideEffectErrors: number }> {
    let notificationCount = 0;
    let sideEffectErrors = 0;

    if (options.orderIds.length > 0) {
        try {
            await bumpCacheGeneration(options.context);
        } catch (error: unknown) {
            sideEffectErrors += 1;
            console.error("[orders-refund] Refund reconciliation cache invalidation failed after local commit:", error);
        }
    }

    for (const notification of options.notifications) {
        try {
            await enqueueRefundNotificationFact({
                db: options.db,
                queue: options.queue,
                orderId: notification.orderId,
                notification,
                source: "orders-refund-reconciliation",
            });
            notificationCount += 1;
        } catch (error: unknown) {
            sideEffectErrors += 1;
            console.error("[orders-refund] Refund reconciliation notification enqueue failed after local commit:", error);
        }
    }

    return { notificationCount, sideEffectErrors };
}

async function recordDirectRefundSideEffects(options: {
    db: Database;
    queue: Env["JOBS_QUEUE"] | undefined;
    orderId: string;
    result: Awaited<ReturnType<typeof processRefund>>;
    context: CacheWriteContext;
}): Promise<{ notificationCount: number; sideEffectErrors: number }> {
    let notificationCount = 0;
    let sideEffectErrors = 0;

    if (
        Array.isArray(options.result.availabilityTransitionVariantIds)
        && options.result.availabilityTransitionVariantIds.length > 0
    ) {
        try {
            await bumpCacheGeneration(options.context);
        } catch (error: unknown) {
            sideEffectErrors += 1;
            console.error("[orders-refund] Direct refund cache invalidation failed after local commit:", error);
        }
    }

    if (options.result.refundNotification) {
        try {
            await enqueueRefundNotification({
                db: options.db,
                queue: options.queue,
                orderId: options.orderId,
                result: options.result,
                source: "orders-refund",
            });
            notificationCount += 1;
        } catch (error: unknown) {
            sideEffectErrors += 1;
            console.error("[orders-refund] Direct refund notification enqueue failed after local commit:", error);
        }
    }

    return { notificationCount, sideEffectErrors };
}

function publicRefundResult<T extends {
    refundNotification?: unknown;
    availabilityTransitionVariantIds?: unknown;
}>(result: T): Omit<T, "refundNotification" | "availabilityTransitionVariantIds"> {
    const {
        refundNotification: _refundNotification,
        availabilityTransitionVariantIds: _cacheSignal,
        ...publicResult
    } = result;
    return publicResult;
}

// ─── POST /:id/refund ────────────────────────────────────────────────────────

const refundOrderRoute = createRoute({
    operationId: "dashboard.orders.refund",
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
                        gateway: z.enum(listPaymentMethodIds() as [string, ...string[]]).optional(),
                        manualSettlementConfirmed: z.boolean().optional(),
                        requestKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional().openapi({
                            description: "One key per refund (per dialog opening). Repeating it returns the first refund.",
                        }),
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
        ...adminRefundMutationErrorResponses,
    }
});

app.openapi(refundOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    let result: Awaited<ReturnType<typeof processRefund>>;
    try {
        result = await processRefund(
            db,
            {
                orderId,
                amount: data.amount,
                reason: data.reason ?? "Refund requested",
                gateway: data.gateway,
                manualSettlementConfirmed: data.manualSettlementConfirmed,
                requestKey: data.requestKey,
            },
            encryptionKey,
        );
    } catch (error: unknown) {
        if (error instanceof PartialRefundProcessedError) {
            await recordPartialRefundProcessedSideEffects({
                db,
                queue: c.env.JOBS_QUEUE,
                error,
                context: c,
                source: "orders-refund-partial-failure",
            });
        }
        throw error;
    }
    if (!result.success) throw new ValidationError(result.error || "Refund processing failed");
    if (result.replayed) {
        // A repeated click: the first request already logged, notified and refreshed.
        return ok(c, { ...publicRefundResult(result), notificationCount: 0, sideEffectErrors: 0 });
    }
    if (result.amount > 0) {
        await recordOrderEvent(db, {
            orderId,
            kind: "refund_recorded",
            actorId: (c.get("user") as { id?: string } | undefined)?.id ?? null,
            body: data.reason?.trim() || null,
            requestKey: data.requestKey,
            data: { amount: result.amount, full: result.isFullRefund },
        });
    }
    const sideEffects = await recordDirectRefundSideEffects({
        db,
        queue: c.env.JOBS_QUEUE,
        orderId,
        result,
        context: c,
    });
    return ok(c, {
        ...publicRefundResult(result),
        notificationCount: sideEffects.notificationCount,
        sideEffectErrors: sideEffects.sideEffectErrors,
    });
});

// ─── POST /:id/refund-attempts/:attemptId/reconcile ─────────────────────────

const reconcileRefundAttemptRoute = createRoute({
    operationId: "dashboard.orders.refund_reconcile",
    method: "post",
    path: "/{id}/refund-attempts/{attemptId}/reconcile",
    tags: ["Admin - Orders"],
    summary: "Check refund recovery",
    request: {
        params: z.object({
            id: z.string(),
            attemptId: z.string(),
        }),
    },
    responses: {
        200: {
            description: "Refund recovery check completed",
            content: { "application/json": { schema: reconcileRefundAttemptResultSchema } },
        },
        ...adminRefundRecoveryErrorResponses,
    },
});

app.openapi(reconcileRefundAttemptRoute, async (c) => {
    const { id: orderId, attemptId } = c.req.valid("param");
    const db = c.get("db");
    const result = await reconcileRefundAttemptForOrder(
        db,
        orderId,
        attemptId,
        {
            encryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
        },
    );
    if (!result.found) {
        throw new NotFoundError("Refund attempt not found");
    }

    const sideEffects = await recordReconciledRefundAttemptSideEffects({
        db,
        queue: c.env.JOBS_QUEUE,
        orderIds: result.orderIds,
        notifications: result.refundNotifications,
        context: c,
    });

    return ok(c, {
        attemptId,
        status: result.status,
        ...(result.reason && result.reason !== "not_found" ? { reason: result.reason } : {}),
        orderIds: result.orderIds,
        notificationCount: sideEffects.notificationCount,
        sideEffectErrors: sideEffects.sideEffectErrors,
    });
});

export { app as adminOrdersRefundRoutes };
