// Manual order quotes, creation and COD amendments.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    confirmManualOrderAmendment,
    createOrder,
    previewManualOrderAmendment,
    quoteManualOrder,
    createOrderSchema,
    quoteManualOrderSchema,
    previewManualOrderAmendmentSchema,
    confirmManualOrderAmendmentSchema,
} from "@scalius/core/modules/orders";
import { ok, created } from "../../../utils/api-response";
import {
    successEnvelope,
    idResponse,
    errorResponses,
    serviceUnavailableResponse,
} from "../../../schemas/responses";
import { bumpCacheGeneration } from "../../../utils/cache-generation";
import { findCheckoutReservationAvailabilityTransitions } from "../../../utils/availability-transitions";
import { resolveCanonicalIdempotencyKey } from "../idempotency-key";
import { adminOrderResourceMutationErrorResponses, adminWriteErrorResponses } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const manualOrderRequestKeySchema = z.uuid("A valid manual-order request key is required");
const manualOrderIdempotencyHeadersSchema = z.object({
    "idempotency-key": manualOrderRequestKeySchema.optional().openapi({
        description: "Standard retry key. May replace body.requestKey; if both are sent they must match.",
    }),
});
const createOrderRequestSchema = createOrderSchema.extend({
    requestKey: manualOrderRequestKeySchema.optional(),
});

// ─── POST / (Create) ────────────────────────────────────────────────────────

const manualOrderQuoteSchema = z.object({
    currencyCode: z.string(),
    decimalPlaces: z.number().int().min(0).max(3),
    subtotalAmount: z.number().nonnegative(),
    shippingAmount: z.number().nonnegative(),
    discountAmount: z.number().nonnegative(),
    taxAmount: z.number().nonnegative(),
    totalAmount: z.number().nonnegative(),
    taxLabel: z.string(),
    pricesIncludeTax: z.boolean(),
    taxEnabled: z.boolean(),
    settingsVersion: z.number().int().nonnegative(),
    lines: z.array(z.object({
        index: z.number().int().nonnegative(),
        productId: z.string(),
        variantId: z.string(),
        quantity: z.number().int().positive(),
        unitPrice: z.number().nonnegative(),
        lineSubtotal: z.number().nonnegative(),
    })),
});

const manualOrderAmendmentPreviewSchema = manualOrderQuoteSchema.extend({
    orderId: z.string(),
    expectedVersion: z.number().int().min(1),
    resultingVersion: z.number().int().min(2),
    balanceDue: z.number().nonnegative(),
    quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

const manualOrderAmendmentResultSchema = z.object({
    id: z.string(),
    version: z.number().int().min(2),
    totalAmount: z.number().nonnegative(),
    balanceDue: z.number().nonnegative(),
});

const quoteManualOrderRoute = createRoute({
    operationId: "dashboard.orders.quote",
    method: "post",
    path: "/quote",
    tags: ["Admin - Orders"],
    summary: "Preview authoritative money and tax for a manual order",
    request: {
        body: { content: { "application/json": { schema: quoteManualOrderSchema } } },
    },
    responses: {
        200: {
            description: "Authoritative manual-order quote",
            content: { "application/json": { schema: successEnvelope(manualOrderQuoteSchema) } },
        },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(quoteManualOrderRoute, async (c) => {
    const quote = await quoteManualOrder(c.get("db"), c.req.valid("json"));
    return ok(c, quote);
});

const previewManualOrderAmendmentRoute = createRoute({
    operationId: "dashboard.orders.amendment_preview",
    method: "post",
    path: "/{id}/amendments/preview",
    tags: ["Admin - Orders"],
    summary: "Preview a guarded manual COD order amendment",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: previewManualOrderAmendmentSchema } } },
    },
    responses: {
        200: {
            description: "Authoritative amended money and tax preview",
            content: { "application/json": { schema: successEnvelope(manualOrderAmendmentPreviewSchema) } },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(previewManualOrderAmendmentRoute, async (c) => {
    const result = await previewManualOrderAmendment(
        c.get("db"),
        c.req.valid("param").id,
        c.req.valid("json"),
    );
    return ok(c, result);
});

const confirmManualOrderAmendmentRoute = createRoute({
    operationId: "dashboard.orders.amendment_confirm",
    method: "post",
    path: "/{id}/amendments",
    tags: ["Admin - Orders"],
    summary: "Confirm an idempotent guarded manual COD order amendment",
    request: {
        params: z.object({ id: z.string() }),
        headers: manualOrderIdempotencyHeadersSchema,
        body: { content: { "application/json": { schema: confirmManualOrderAmendmentSchema.partial({ requestKey: true }) } } },
    },
    responses: {
        200: {
            description: "Amendment committed or exact idempotent replay",
            content: { "application/json": { schema: successEnvelope(manualOrderAmendmentResultSchema) } },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(confirmManualOrderAmendmentRoute, async (c) => {
    const { requestKey: bodyRequestKey, ...payload } = c.req.valid("json");
    const requestKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyRequestKey,
        "requestKey",
    );
    const user = c.get("user") as { id?: string } | undefined;
    const result = await confirmManualOrderAmendment(
        c.get("db"),
        c.req.valid("param").id,
        { ...payload, requestKey },
        user?.id ?? null,
    );
    if (result.inventoryMutationVariantIds.length > 0) await bumpCacheGeneration(c);
    return ok(c, {
        id: result.id,
        version: result.version,
        totalAmount: result.totalAmount,
        balanceDue: result.balanceDue,
    });
});

const createOrderRoute = createRoute({
    operationId: "dashboard.orders.create",
    method: "post",
    path: "/",
    tags: ["Admin - Orders"],
    summary: "Create a new order (admin)",
    request: {
        headers: manualOrderIdempotencyHeadersSchema,
        body: { required: true, content: { "application/json": { schema: createOrderRequestSchema } } }
    },
    responses: {
        201: {
            description: "Order created",
            content: { "application/json": { schema: idResponse } },
        },
        ...adminWriteErrorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(createOrderRoute, async (c) => {
    const db = c.get("db");
    const { requestKey: bodyRequestKey, ...payload } = c.req.valid("json");
    const requestKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyRequestKey,
        "requestKey",
    );
    const data = { ...payload, requestKey };
    const user = c.get("user") as { id?: string } | undefined;
    const result = await createOrder(db, data, user?.id ?? null);
    const availabilityTransitionVariantIds =
        await findCheckoutReservationAvailabilityTransitions(
            db,
            data.items.flatMap((item) =>
                item.variantId && item.quantity > 0
                    ? [{ variantId: item.variantId, quantity: item.quantity }]
                    : [],
            ),
        );
    if (availabilityTransitionVariantIds.length > 0) {
        await bumpCacheGeneration(c);
    }
    return created(c, result);
});

export { app as adminOrderCreateRoutes };
