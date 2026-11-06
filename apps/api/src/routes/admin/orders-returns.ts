import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { adminRouter } from "./admin-router";
import { nullableIsoTimestampSchema } from "../../schemas/timestamps";
import {
    recordOrderEvent,
    approveOrderReturn,
    approveOrderReturnSchema,
    cancelOrderReturn,
    cancelOrderReturnSchema,
    createOrderReturn,
    createOrderReturnSchema,
    getOrderReturn,
    listOrderReturns,
    receiveOrderReturn,
    receiveOrderReturnSchema,
    reconcileOrderReturnReceipt,
    type ApproveOrderReturnInput,
    type CancelOrderReturnInput,
    type CreateOrderReturnInput,
    type ReceiveOrderReturnInput,
} from "@scalius/core/modules/orders";
import { created, ok } from "../../utils/api-response";
import {
    conflictResponse,
    errorResponses,
    serviceUnavailableResponse,
    successEnvelope,
} from "../../schemas/responses";

import { sendOrderNotification, sendOrderNotificationsForStatus } from "../../utils/order-notifications";
import { resolveCanonicalIdempotencyKey } from "./idempotency-key";
import { notificationSender } from "../../background/notification-sender";

const app = adminRouter();

const returnCommandKeySchema = z.string().trim().min(8).max(200);
const returnIdempotencyHeadersSchema = z.object({
    "idempotency-key": returnCommandKeySchema.optional().openapi({
        description: "Standard retry key. May replace body.commandKey; if both are sent they must match.",
    }),
});
const createOrderReturnRequestSchema = createOrderReturnSchema.extend({
    commandKey: returnCommandKeySchema.optional(),
});
const approveOrderReturnRequestSchema = approveOrderReturnSchema.extend({
    commandKey: returnCommandKeySchema.optional(),
});
const receiveOrderReturnRequestSchema = receiveOrderReturnSchema.extend({
    commandKey: returnCommandKeySchema.optional(),
});
const cancelOrderReturnRequestSchema = cancelOrderReturnSchema.extend({
    commandKey: returnCommandKeySchema.optional(),
});

const returnLineSchema = z.object({
    id: z.string(),
    orderItemId: z.string(),
    variantId: z.string().nullable(),
    inventoryTracked: z.boolean(),
    requestedQuantity: z.number().int(),
    approvedQuantity: z.number().int(),
    receivedQuantity: z.number().int(),
    restockQuantity: z.number().int(),
    damagedQuantity: z.number().int(),
    untrackedQuantity: z.number().int().openapi({ description: "Received units of an item whose stock isn't tracked: neither restocked nor damaged." }),
    rejectedQuantity: z.number().int(),
    remainingReturnableQuantity: z.number().int().min(0),
    reason: z.string().nullable(),
    notes: z.string().nullable(),
});

const returnReceiptSchema = z.object({
    id: z.string(),
    returnLineId: z.string(),
    receivedQuantity: z.number().int(),
    restockQuantity: z.number().int(),
    damagedQuantity: z.number().int(),
    untrackedQuantity: z.number().int().openapi({ description: "Received units of an item whose stock isn't tracked: neither restocked nor damaged." }),
    actorType: z.string(),
    actorId: z.string().nullable(),
    inventoryMovementId: z.string().nullable(),
    restockLocationId: z.string().nullable().openapi({ description: "Location the restocked units went to; null when nothing was restocked." }),
    notes: z.string().nullable(),
    createdAt: z.coerce.date(),
});

const orderReturnSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    status: z.enum(["requested", "approved", "receiving", "completed", "rejected", "cancelled"]),
    reason: z.string(),
    notes: z.string().nullable(),
    actorType: z.string(),
    actorId: z.string().nullable(),
    source: z.enum(["admin", "support_request", "cod_return_to_sender"]),
    sourceReferenceId: z.string().nullable(),
    version: z.number().int(),
    requestedAt: z.coerce.date(),
    approvedAt: z.coerce.date().nullable(),
    receivingStartedAt: z.coerce.date().nullable(),
    completedAt: z.coerce.date().nullable(),
    rejectedAt: z.coerce.date().nullable(),
    cancelledAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    receiptRecovery: z.object({
        required: z.literal(true),
        startedAt: nullableIsoTimestampSchema,
    }).nullable(),
    receipts: z.array(returnReceiptSchema),
    lines: z.array(returnLineSchema),
});

const commandResultSchema = z.object({
    orderId: z.string(),
    returnId: z.string(),
    status: z.enum(["requested", "approved", "receiving", "completed", "rejected", "cancelled"]),
    version: z.number().int(),
    restockedQuantity: z.number().int(),
    wholeOrderReturned: z.boolean(),
});

const mutationResponses = {
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
    503: serviceUnavailableResponse,
} as const;

const listRoute = createRoute({
    operationId: "dashboard.orders.returns",
    method: "get",
    path: "/{id}/returns",
    tags: ["Admin - Orders"],
    summary: "List item-level returns for an order",
    request: { params: z.object({ id: z.string() }) },
    responses: {
        200: { description: "Returns", content: { "application/json": { schema: successEnvelope(z.object({ returns: z.array(orderReturnSchema) })) } } },
        ...errorResponses,
    },
});

const getRoute = createRoute({
    operationId: "dashboard.orders.return_get",
    method: "get",
    path: "/{id}/returns/{returnId}",
    tags: ["Admin - Orders"],
    summary: "Get an item-level return",
    request: { params: z.object({ id: z.string(), returnId: z.string() }) },
    responses: {
        200: { description: "Return", content: { "application/json": { schema: successEnvelope(z.object({ return: orderReturnSchema })) } } },
        ...errorResponses,
    },
});

const createRouteDefinition = createRoute({
    operationId: "dashboard.orders.return_create",
    method: "post",
    path: "/{id}/returns",
    tags: ["Admin - Orders"],
    summary: "Request an item-level return without changing stock",
    request: {
        params: z.object({ id: z.string() }),
        headers: returnIdempotencyHeadersSchema,
        body: { required: true, content: { "application/json": { schema: createOrderReturnRequestSchema } } },
    },
    responses: {
        201: { description: "Return requested", content: { "application/json": { schema: successEnvelope(commandResultSchema) } } },
        ...mutationResponses,
    },
});

function mutationRoute(
    action: "approve" | "receive" | "cancel",
    schema: typeof approveOrderReturnRequestSchema | typeof receiveOrderReturnRequestSchema | typeof cancelOrderReturnRequestSchema,
) {
    return createRoute({
        operationId: `dashboard.orders.return_${action}`,
        method: "post",
        path: `/{id}/returns/{returnId}/${action}`,
        tags: ["Admin - Orders"],
        summary: `${action[0]!.toUpperCase()}${action.slice(1)} an item-level return`,
        request: {
            params: z.object({ id: z.string(), returnId: z.string() }),
            headers: returnIdempotencyHeadersSchema,
            body: { required: true, content: { "application/json": { schema } } },
        },
        responses: {
            200: { description: "Return updated", content: { "application/json": { schema: successEnvelope(commandResultSchema) } } },
            ...mutationResponses,
        },
    });
}

const approveRoute = mutationRoute("approve", approveOrderReturnRequestSchema);
const receiveRoute = mutationRoute("receive", receiveOrderReturnRequestSchema);
const cancelRoute = mutationRoute("cancel", cancelOrderReturnRequestSchema);

const reconcileRoute = createRoute({
    operationId: "dashboard.orders.return_reconcile",
    method: "post",
    path: "/{id}/returns/{returnId}/reconcile",
    tags: ["Admin - Orders"],
    summary: "Resume a claimed return receipt from durable server state",
    request: { params: z.object({ id: z.string(), returnId: z.string() }) },
    responses: {
        200: { description: "Receipt reconciled", content: { "application/json": { schema: successEnvelope(commandResultSchema) } } },
        ...mutationResponses,
    },
});

// ── The return commands, one implementation for every surface ─────────
// The dashboard's routes here and the stable app API's
// (resources-returns.ts) run these: the core command, then its order
// timeline line and the customer's notification, each once per return.

/** A request the return commands run in: its database, its caller and its background work. */
export type ReturnCommandContext = Context<{ Bindings: Env }>;

function actor(c: { get(name: "user"): unknown }) {
    const user = c.get("user") as { id?: string } | undefined;
    return { type: "admin" as const, id: user?.id ?? null };
}

async function postReceiptSideEffects(
    c: ReturnCommandContext,
    result: Awaited<ReturnType<typeof receiveOrderReturn>>,
) {

    if (result.wholeOrderReturned) {
        await sendOrderNotificationsForStatus({
            db: c.get("db"),
            send: notificationSender(c),
            orderIds: [result.orderId],
            newStatus: "returned",
            dedupeKeyByOrderId: { [result.orderId]: `return:${result.returnId}:fully-received` },
            source: "admin-order-return-receipt",
        });
    }
}

/** Requests a return of an order's lines (no stock moves) and notes it on the order timeline. */
export async function runCreateOrderReturn(c: ReturnCommandContext, orderId: string, input: CreateOrderReturnInput) {
    const result = await createOrderReturn(c.get("db"), orderId, input, actor(c));
    await recordOrderEvent(c.get("db"), {
        orderId,
        kind: "return_created",
        actorId: actor(c).id,
        requestKey: input.commandKey,
        body: input.reason?.trim() || null,
        data: { quantity: input.lines.reduce((sum, line) => sum + line.quantity, 0) },
    });
    return result;
}

/** Approves (or rejects) a return's quantities; the customer hears an approval once. */
export async function runApproveOrderReturn(c: ReturnCommandContext, orderId: string, returnId: string, input: ApproveOrderReturnInput) {
    const result = await approveOrderReturn(c.get("db"), orderId, returnId, input, actor(c));
    // The review is its own step on the timeline (R3-ORD-14).
    await recordOrderEvent(c.get("db"), {
        orderId,
        kind: "return_approved",
        actorId: actor(c).id,
        requestKey: input.commandKey,
        data: {
            approved: input.lines.reduce((sum, line) => sum + line.approvedQuantity, 0),
            rejected: input.lines.reduce((sum, line) => sum + line.rejectedQuantity, 0),
        },
    });
    // The customer hears it was approved (and to send the items), once per return.
    if (input.lines.some((line) => line.approvedQuantity > 0)) {
        await sendOrderNotification({
            db: c.get("db"),
            send: notificationSender(c),
            orderId,
            notificationType: "return_approved",
            dedupeKey: `return:${returnId}:approved`,
            source: "orders-return-approve",
        });
    }
    return result;
}

/** Receives returned units (restocking or writing them off); the customer hears they arrived once. */
export async function runReceiveOrderReturn(c: ReturnCommandContext, orderId: string, returnId: string, input: ReceiveOrderReturnInput) {
    const result = await receiveOrderReturn(c.get("db"), orderId, returnId, input, actor(c));
    await postReceiptSideEffects(c, result);
    await recordOrderEvent(c.get("db"), {
        orderId,
        kind: "return_received",
        actorId: actor(c).id,
        requestKey: input.commandKey,
        data: {
            received: input.lines.reduce((sum, line) => sum + line.receivedQuantity, 0),
            restocked: result.restockedQuantity,
            damaged: input.lines.reduce((sum, line) => sum + line.damagedQuantity, 0),
        },
    });
    // The customer hears the items arrived, once per return.
    await sendOrderNotification({
        db: c.get("db"),
        send: notificationSender(c),
        orderId,
        notificationType: "return_received",
        dedupeKey: `return:${returnId}:received`,
        source: "orders-return-receive",
    });
    const { availabilityTransitionVariantIds: _cacheSignal, ...response } = result;
    return response;
}

/** Cancels a return that has not been received. */
export function runCancelOrderReturn(c: ReturnCommandContext, orderId: string, returnId: string, input: CancelOrderReturnInput) {
    return cancelOrderReturn(c.get("db"), orderId, returnId, input, actor(c));
}

app.openapi(listRoute, async (c) => ok(c, { returns: await listOrderReturns(c.get("db"), c.req.valid("param").id) }));
app.openapi(getRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    return ok(c, { return: await getOrderReturn(c.get("db"), id, returnId) });
});
app.openapi(createRouteDefinition, async (c) => {
    const { commandKey: bodyCommandKey, ...payload } = c.req.valid("json");
    const commandKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyCommandKey,
        "commandKey",
    );
    return created(c, await runCreateOrderReturn(c, c.req.valid("param").id, { ...payload, commandKey }));
});
app.openapi(approveRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    const { commandKey: bodyCommandKey, ...payload } = c.req.valid("json");
    const commandKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyCommandKey,
        "commandKey",
    );
    return ok(c, await runApproveOrderReturn(c, id, returnId, { ...payload, commandKey } as ApproveOrderReturnInput));
});
app.openapi(receiveRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    const { commandKey: bodyCommandKey, ...payload } = c.req.valid("json");
    const commandKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyCommandKey,
        "commandKey",
    );
    return ok(c, await runReceiveOrderReturn(c, id, returnId, { ...payload, commandKey } as ReceiveOrderReturnInput));
});
app.openapi(cancelRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    const { commandKey: bodyCommandKey, ...payload } = c.req.valid("json");
    const commandKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyCommandKey,
        "commandKey",
    );
    return ok(c, await runCancelOrderReturn(c, id, returnId, { ...payload, commandKey } as CancelOrderReturnInput));
});
app.openapi(reconcileRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    const result = await reconcileOrderReturnReceipt(c.get("db"), id, returnId);
    await postReceiptSideEffects(c, result);
    const { availabilityTransitionVariantIds: _cacheSignal, ...response } = result;
    return ok(c, response);
});

export { app as adminOrdersReturnRoutes };
