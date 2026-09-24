// Bulk archive, ship, confirm and fulfil.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { archiveOrders, bulkConfirmOrders, recordOrderEvent } from "@scalius/core/modules/orders";
import { bulkFulfillOrders, bulkShipOrders } from "@scalius/core/modules/fulfilment";
import { archiveOrdersSchema, bulkShipOrderSchema } from "@scalius/core/modules/orders/validation";
import { ok, noContent } from "../../../utils/api-response";
import { successEnvelope, noContentResponse, conflictResponse } from "../../../schemas/responses";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { bumpCacheGeneration } from "../../../utils/cache-generation";
import {
    enqueueOrderNotificationMessage,
    enqueueOrderNotificationsForStatus,
} from "../../../utils/order-notification-queue";
import {
    adminWriteErrorResponses,
    type AdminRouteContext,
    type AdminRouteHandler,
    bulkRequestKeySchema,
} from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

function isSuccessfulOrderResult(result: unknown): result is { success: true; orderId: string } {
    return typeof result === "object"
        && result !== null
        && (result as Record<string, unknown>).success === true
        && typeof (result as Record<string, unknown>).orderId === "string";
}

function isNewShipmentResult(result: unknown): result is {
    success: true;
    orderId: string;
    shipment: { shipmentId?: string | null; data?: { trackingId?: string | null } };
} {
    return isSuccessfulOrderResult(result)
        && typeof (result as Record<string, unknown>).shipment === "object"
        && (result as Record<string, unknown>).shipment !== null;
}

// ─── Inline response schemas (route-specific, not reusable enough for entities) ──

const bulkShipResultItemSchema = z.object({
    orderId: z.string(),
    success: z.boolean(),
    shipment: z.object({ id: z.string(), status: z.string() }).passthrough().optional(),
    error: z.string().optional(),
}).passthrough();

const bulkShipResponseSchema = successEnvelope(z.object({
    totalProcessed: z.number(),
    successCount: z.number(),
    failureCount: z.number(),
    results: z.array(bulkShipResultItemSchema),
}));

// ─── POST /archive ───────────────────────────────────────────────────────────

const archiveOrdersRoute = createRoute({
    operationId: "dashboard.orders.archive",
    method: "post",
    path: "/archive",
    tags: ["Admin - Orders"],
    summary: "Archive completed orders without changing commerce state",
    request: {
        body: { content: { "application/json": { schema: archiveOrdersSchema } } }
    },
    responses: {
        204: noContentResponse,
        ...adminWriteErrorResponses,
        409: conflictResponse,
    }
});

app.openapi(archiveOrdersRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const user = c.get("user") as { id?: string } | undefined;
    await archiveOrders(db, data.orders);
    for (const order of data.orders) {
        await recordOrderEvent(db, { orderId: order.id, kind: "archived", actorId: user?.id ?? null });
    }
    return noContent(c);
});

// ─── POST /bulk-ship ─────────────────────────────────────────────────────────

const bulkShipRoute = createRoute({
    operationId: "dashboard.orders.bulk_ship",
    method: "post",
    path: "/bulk-ship",
    tags: ["Admin - Orders"],
    summary: "Bulk ship orders",
    request: {
        body: { content: { "application/json": { schema: bulkShipOrderSchema } } }
    },
    responses: {
        200: {
            description: "Bulk ship results",
            content: { "application/json": { schema: bulkShipResponseSchema } },
        },
        ...adminWriteErrorResponses,
    }
});

app.openapi(bulkShipRoute, (async (c: AdminRouteContext<typeof bulkShipRoute>) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const results = await bulkShipOrders(db, data.orderIds, data.providerId, data.options, encryptionKey);
    const successCount = results.filter((r) => r.success).length;
    const newlyShippedResults = results.filter(isNewShipmentResult);
    const availabilityTransitionVariantIds = results.flatMap((result) =>
        "availabilityTransitionVariantIds" in result
        && Array.isArray(result.availabilityTransitionVariantIds)
            ? result.availabilityTransitionVariantIds
            : [],
    );
    if (availabilityTransitionVariantIds.length > 0) {
        await bumpCacheGeneration(c);
    }
    const responseResults = results.map((result) => {
        const {
            availabilityTransitionVariantIds: _internalCacheSignal,
            ...responseResult
        } = result as typeof result & { availabilityTransitionVariantIds?: string[] };
        return responseResult;
    });

    const shipUser = c.get("user") as { id?: string } | undefined;
    for (const result of newlyShippedResults) {
        await recordOrderEvent(db, {
            orderId: result.orderId,
            kind: "shipment_created",
            actorId: shipUser?.id ?? null,
            data: { courierName: null, trackingId: result.shipment.data?.trackingId ?? null, final: true },
        });
    }

    await enqueueOrderNotificationsForStatus({
        db,
        queue: c.env.JOBS_QUEUE,
        orderIds: newlyShippedResults.map((result) => result.orderId),
        newStatus: "shipped",
        trackingByOrderId: Object.fromEntries(
            newlyShippedResults
                .map((result) => [result.orderId, result.shipment.data?.trackingId] as const)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
        ),
        dedupeKeyByOrderId: Object.fromEntries(
            newlyShippedResults.map((result) => [
                result.orderId,
                result.shipment.shipmentId
                    ? `shipment:${result.shipment.shipmentId}:order_shipped`
                    : `shipment:${result.orderId}:${result.shipment.data?.trackingId ?? "unknown"}:order_shipped`,
            ] as const),
        ),
        source: "bulk-ship",
    });

    return ok(c, {
        totalProcessed: results.length,
        successCount,
        failureCount: results.length - successCount,
        results: responseResults,
    });
}) as unknown as AdminRouteHandler<typeof bulkShipRoute>);

// ─── POST /bulk-confirm, /bulk-fulfill ────────────────────────────────────────

const bulkOrderIdsSchema = z.array(z.string().trim().min(1).max(180))
    .min(1, "Select at least one order")
    .max(90, "Select at most 90 orders at a time")
    .refine((ids) => new Set(ids).size === ids.length, "Each order can appear only once");

const bulkActionResponseSchema = successEnvelope(z.object({
    results: z.array(z.object({
        orderId: z.string(),
        success: z.boolean(),
        error: z.string().optional(),
    })),
}));

const bulkConfirmRoute = createRoute({
    operationId: "dashboard.orders.bulk_confirm",
    method: "post",
    path: "/bulk-confirm",
    tags: ["Admin - Orders"],
    summary: "Confirm several new orders",
    request: {
        body: { content: { "application/json": { schema: z.object({ orderIds: bulkOrderIdsSchema, requestKey: bulkRequestKeySchema }) } } },
    },
    responses: {
        200: { description: "Per-order results", content: { "application/json": { schema: bulkActionResponseSchema } } },
        ...adminWriteErrorResponses,
    },
});

app.openapi(bulkConfirmRoute, async (c) => {
    const db = c.get("db");
    const { orderIds, requestKey } = c.req.valid("json");
    const user = c.get("user") as { id?: string } | undefined;
    const results = await bulkConfirmOrders(db, orderIds, { requestKey, actorId: user?.id ?? null });
    let bumped = false;
    for (const result of results) {
        if (!result.success || !result.update) continue;
        if (!bumped && result.update.availabilityTransitionVariantIds.length > 0) {
            await bumpCacheGeneration(c);
            bumped = true;
        }
        const notification = result.update.notification;
        if (notification) {
            await enqueueOrderNotificationMessage({
                db,
                queue: c.env.JOBS_QUEUE,
                message: {
                    type: "order.notification",
                    orderId: notification.orderId,
                    customerEmail: notification.customerEmail,
                    customerName: notification.customerName,
                    notificationType: notification.notificationType,
                },
                dedupeKey: notification.dedupeKey ?? `order_status:${result.orderId}:${notification.notificationType}`,
                source: "orders-bulk-confirm",
            });
        }
    }
    return ok(c, { results: results.map(({ orderId, success, error }) => ({ orderId, success, ...(error ? { error } : {}) })) });
});

const bulkFulfillRoute = createRoute({
    operationId: "dashboard.orders.bulk_fulfill",
    method: "post",
    path: "/bulk-fulfill",
    tags: ["Admin - Orders"],
    summary: "Mark several confirmed orders as sent with your own courier",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        orderIds: bulkOrderIdsSchema,
                        courierName: z.string().trim().max(120).optional(),
                        note: z.string().trim().max(500).optional(),
                        requestKey: bulkRequestKeySchema,
                    }),
                },
            },
        },
    },
    responses: {
        200: { description: "Per-order results", content: { "application/json": { schema: bulkActionResponseSchema } } },
        ...adminWriteErrorResponses,
    },
});

app.openapi(bulkFulfillRoute, async (c) => {
    const db = c.get("db");
    const { orderIds, courierName, note, requestKey } = c.req.valid("json");
    const user = c.get("user") as { id?: string } | undefined;
    const results = await bulkFulfillOrders(db, orderIds, { courierName, note, requestKey });
    if (results.some((result) => (result.shipment?.availabilityTransitionVariantIds.length ?? 0) > 0)) {
        await bumpCacheGeneration(c);
    }
    for (const result of results) {
        if (!result.success || !result.shipment) continue;
        await recordOrderEvent(db, {
            orderId: result.orderId,
            kind: "shipment_created",
            actorId: user?.id ?? null,
            requestKey: result.shipment.shipmentId,
            data: {
                courierName: courierName || null,
                trackingId: null,
                final: true,
                quantity: result.shipment.lines.reduce((sum, line) => sum + line.quantity, 0),
                items: result.shipment.lines,
            },
        });
    }
    await enqueueOrderNotificationsForStatus({
        db,
        queue: c.env.JOBS_QUEUE,
        orderIds: results.filter((result) => result.shipment?.statusChange).map((result) => result.orderId),
        newStatus: "shipped",
        dedupeKeyByOrderId: Object.fromEntries(results
            .filter((result) => result.shipment?.statusChange)
            .map((result) => [result.orderId, `shipment:${result.shipment!.shipmentId}:order_shipped`])),
        source: "orders-bulk-fulfill",
    });
    return ok(c, { results: results.map(({ orderId, success, error }) => ({ orderId, success, ...(error ? { error } : {}) })) });
});

export { app as adminOrderBulkRoutes };
