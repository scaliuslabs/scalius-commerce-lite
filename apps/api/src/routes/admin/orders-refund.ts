import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { recordOrderEvent } from "@scalius/core/modules/orders";
import type { Database } from "@scalius/database/client";
import {
    PartialRefundProcessedError,
    processRefund,
    type RefundNotificationFact,
    type RefundRequest,
    reconcileRefundAttemptForOrder,
    listPaymentMethodIds,
} from "@scalius/core/modules/payments";
import { GIFT_CARD_PAYMENT_METHOD } from "@scalius/core/modules/gift-cards";
import { enqueueNotificationOutboxById } from "@scalius/core/modules/notifications";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
    conflictResponse,
    errorResponses,
    serviceUnavailableResponse,
    successEnvelope,
} from "../../schemas/responses";

import {
    enqueueOrderRefundNotificationForOrder,
    enqueueOrderStatusChangeNotification,
} from "../../utils/order-notification-queue";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── Inline response schemas ────────────────────────────────────────────────

/** Where a refund goes: back to the original payments, or one new gift card. */
const REFUND_SETTLEMENTS = ["original", "store_credit"] as const satisfies ReadonlyArray<NonNullable<RefundRequest["settlement"]>>;

const refundResultSchema = z.object({
    success: z.boolean(),
    gateway: z.string(),
    refundId: z.string().optional(),
    amount: z.number(),
    isFullRefund: z.boolean(),
    manualSettlementRecorded: z.boolean().optional(),
    replayed: z.boolean().optional(),
    settlement: z.enum(REFUND_SETTLEMENTS).optional(),
    storeCredit: z.object({
        giftCardId: z.string(),
        last4: z.string(),
        amount: z.number(),
        amountMinor: z.number().int(),
    }).optional().openapi({
        description: "The store-credit gift card this refund issued (last 4 only; the code is sent to the customer).",
    }),
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
        storeCredit?: { last4: string };
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
        storeCreditLast4: options.result.storeCredit?.last4,
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
    /** Store credit: the message says so, with the new card's last 4 (never its code). */
    storeCreditLast4?: string;
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
            ...(options.storeCreditLast4 ? { settlement: "store_credit", storeCreditLast4: options.storeCreditLast4 } : {}),
        },
    });
}

async function recordPartialRefundProcessedSideEffects(options: {
    db: Database;
    queue: Env["JOBS_QUEUE"] | undefined;
    error: PartialRefundProcessedError;
    source: string;
    statusSource?: string;
}) {
    try {

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
    notifications: RefundNotificationFact[];
}): Promise<{ notificationCount: number; sideEffectErrors: number }> {
    let notificationCount = 0;
    let sideEffectErrors = 0;

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
}): Promise<{ notificationCount: number; sideEffectErrors: number }> {
    let notificationCount = 0;
    let sideEffectErrors = 0;

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

/**
 * Hands the store-credit card's `gift_card_issued` row (committed with the
 * refund) to the queue. A failure leaves it for the scheduled outbox flush.
 */
async function enqueueStoreCreditNotification(options: {
    db: Database;
    queue: Env["JOBS_QUEUE"] | undefined;
    outboxId: string | undefined;
}): Promise<{ notificationCount: number; sideEffectErrors: number }> {
    if (!options.outboxId || !options.queue) return { notificationCount: 0, sideEffectErrors: 0 };
    try {
        await enqueueNotificationOutboxById({ db: options.db, queue: options.queue, outboxId: options.outboxId });
        return { notificationCount: 1, sideEffectErrors: 0 };
    } catch (error: unknown) {
        console.error(
            "[orders-refund] Store-credit notification not enqueued yet; the outbox flush will retry:",
            error instanceof Error ? error.message : "unknown error",
        );
        return { notificationCount: 0, sideEffectErrors: 1 };
    }
}

function publicRefundResult<T extends {
    refundNotification?: unknown;
    availabilityTransitionVariantIds?: unknown;
    storeCredit?: { giftCardId: string; last4: string; amount: number; amountMinor: number; notificationOutboxId?: string };
}>(result: T): Omit<T, "refundNotification" | "availabilityTransitionVariantIds"> {
    const {
        refundNotification: _refundNotification,
        availabilityTransitionVariantIds: _cacheSignal,
        ...publicResult
    } = result;
    if (!publicResult.storeCredit) return publicResult;
    const { notificationOutboxId: _outboxId, ...storeCredit } = publicResult.storeCredit;
    return { ...publicResult, storeCredit };
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
                        gateway: z.enum([GIFT_CARD_PAYMENT_METHOD, ...listPaymentMethodIds()] as [string, ...string[]]).optional().openapi({
                            description: "Refund only payments taken by this method (gift_card: only the gift-card tenders).",
                        }),
                        manualSettlementConfirmed: z.boolean().optional(),
                        settlement: z.enum(REFUND_SETTLEMENTS).optional().openapi({
                            description: "original (default): back to the payments it came from. store_credit: one new gift card for the whole amount, sent to the order contact; no cash or provider refund.",
                        }),
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
    // The durable key also seals a store-credit card's code (fails closed when missing).
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const actorId = (c.get("user") as { id?: string } | undefined)?.id ?? null;
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
                settlement: data.settlement,
                actorUserId: actorId,
            },
            encryptionKey,
        );
    } catch (error: unknown) {
        if (error instanceof PartialRefundProcessedError) {
            await recordPartialRefundProcessedSideEffects({
                db,
                queue: c.env.JOBS_QUEUE,
                error,
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
            actorId,
            body: data.reason?.trim() || null,
            requestKey: data.requestKey,
            data: {
                amount: result.amount,
                full: result.isFullRefund,
                // Ids and last 4 only: the code never enters the timeline.
                ...(result.storeCredit ? {
                    settlement: "store_credit",
                    giftCardId: result.storeCredit.giftCardId,
                    giftCardLast4: result.storeCredit.last4,
                } : {}),
            },
        });
    }
    const sideEffects = await recordDirectRefundSideEffects({
        db,
        queue: c.env.JOBS_QUEUE,
        orderId,
        result,
    });
    const storeCreditSideEffects = await enqueueStoreCreditNotification({
        db,
        queue: c.env.JOBS_QUEUE,
        outboxId: result.storeCredit?.notificationOutboxId,
    });
    return ok(c, {
        ...publicRefundResult(result),
        notificationCount: sideEffects.notificationCount + storeCreditSideEffects.notificationCount,
        sideEffectErrors: sideEffects.sideEffectErrors + storeCreditSideEffects.sideEffectErrors,
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
        notifications: result.refundNotifications,
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
