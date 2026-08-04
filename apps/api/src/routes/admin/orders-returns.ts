import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import {
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
    type ReceiveOrderReturnInput,
} from "@scalius/core/modules/orders";
import { created, ok } from "../../utils/api-response";
import {
    conflictResponse,
    errorResponses,
    serviceUnavailableResponse,
    successEnvelope,
} from "../../schemas/responses";
import { invalidateProductAvailabilityCaches } from "../../utils/cache-invalidation";
import { enqueueOrderNotificationsForStatus } from "../../utils/order-notification-queue";

const app = new OpenAPIHono<{ Bindings: Env }>();
type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;

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
    actorType: z.string(),
    actorId: z.string().nullable(),
    inventoryMovementId: z.string().nullable(),
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
        startedAt: z.number().int().nullable(),
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
    method: "post",
    path: "/{id}/returns",
    tags: ["Admin - Orders"],
    summary: "Request an item-level return without changing stock",
    request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: createOrderReturnSchema } } },
    },
    responses: {
        201: { description: "Return requested", content: { "application/json": { schema: successEnvelope(commandResultSchema) } } },
        ...mutationResponses,
    },
});

function mutationRoute(
    action: "approve" | "receive" | "cancel",
    schema: typeof approveOrderReturnSchema | typeof receiveOrderReturnSchema | typeof cancelOrderReturnSchema,
) {
    return createRoute({
        method: "post",
        path: `/{id}/returns/{returnId}/${action}`,
        tags: ["Admin - Orders"],
        summary: `${action[0]!.toUpperCase()}${action.slice(1)} an item-level return`,
        request: {
            params: z.object({ id: z.string(), returnId: z.string() }),
            body: { required: true, content: { "application/json": { schema } } },
        },
        responses: {
            200: { description: "Return updated", content: { "application/json": { schema: successEnvelope(commandResultSchema) } } },
            ...mutationResponses,
        },
    });
}

const approveRoute = mutationRoute("approve", approveOrderReturnSchema);
const receiveRoute = mutationRoute("receive", receiveOrderReturnSchema);
const cancelRoute = mutationRoute("cancel", cancelOrderReturnSchema);

const reconcileRoute = createRoute({
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

function actor(c: { get(name: "user"): unknown }) {
    const user = c.get("user") as { id?: string } | undefined;
    return { type: "admin" as const, id: user?.id ?? null };
}

async function postReceiptSideEffects(
    c: Parameters<AdminRouteHandler<typeof receiveRoute>>[0],
    result: Awaited<ReturnType<typeof receiveOrderReturn>>,
) {
    if (result.availabilityTransitionVariantIds?.length) {
        await invalidateProductAvailabilityCaches(
            c.get("db"),
            { variantIds: result.availabilityTransitionVariantIds },
            c,
        );
    } else if (
        result.restockedQuantity > 0
        && result.availabilityTransitionVariantIds === undefined
    ) {
        await invalidateProductAvailabilityCaches(
            c.get("db"),
            { orderIds: [result.orderId] },
            c,
        );
    }
    if (result.wholeOrderReturned) {
        await enqueueOrderNotificationsForStatus({
            db: c.get("db"),
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
            orderIds: [result.orderId],
            newStatus: "returned",
            dedupeKeyByOrderId: { [result.orderId]: `return:${result.returnId}:fully-received` },
            source: "admin-order-return-receipt",
        });
    }
}

app.openapi(listRoute, async (c) => ok(c, { returns: await listOrderReturns(c.get("db"), c.req.valid("param").id) }));
app.openapi(getRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    return ok(c, { return: await getOrderReturn(c.get("db"), id, returnId) });
});
app.openapi(createRouteDefinition, async (c) => created(c, await createOrderReturn(
    c.get("db"),
    c.req.valid("param").id,
    c.req.valid("json"),
    actor(c),
)));
app.openapi(approveRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    return ok(c, await approveOrderReturn(
        c.get("db"), id, returnId, c.req.valid("json") as ApproveOrderReturnInput, actor(c),
    ));
});
app.openapi(receiveRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    const result = await receiveOrderReturn(
        c.get("db"), id, returnId, c.req.valid("json") as ReceiveOrderReturnInput, actor(c),
    );
    await postReceiptSideEffects(c, result);
    const { availabilityTransitionVariantIds: _cacheSignal, ...response } = result;
    return ok(c, response);
});
app.openapi(cancelRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    return ok(c, await cancelOrderReturn(
        c.get("db"), id, returnId, c.req.valid("json") as CancelOrderReturnInput, actor(c),
    ));
});
app.openapi(reconcileRoute, async (c) => {
    const { id, returnId } = c.req.valid("param");
    const result = await reconcileOrderReturnReceipt(c.get("db"), id, returnId);
    await postReceiptSideEffects(c as Parameters<AdminRouteHandler<typeof receiveRoute>>[0], result);
    const { availabilityTransitionVariantIds: _cacheSignal, ...response } = result;
    return ok(c, response);
});

export { app as adminOrdersReturnRoutes };
