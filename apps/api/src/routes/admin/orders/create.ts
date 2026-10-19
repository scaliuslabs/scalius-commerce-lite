// Manual order quotes, creation and COD amendments.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    confirmManualOrderAmendment,
    createManualOrder,
    previewManualOrderAmendment,
    quoteManualOrder,
    createOrderObjectSchema,
    quoteManualOrderSchema,
    previewManualOrderAmendmentSchema,
    confirmManualOrderAmendmentObjectSchema,
    refineDeliveryLine,
} from "@scalius/core/modules/orders";
import { ok, created } from "../../../utils/api-response";
import {
    successEnvelope,
    idResponse,
    errorResponses,
    serviceUnavailableResponse,
} from "../../../schemas/responses";

import { listActiveFunctionRegistrations } from "@scalius/core/modules/plugins";
import { createManualOrderAppFunctions } from "@scalius/core/modules/checkout";
import type { Database } from "@scalius/database/client";
import { resolveCanonicalIdempotencyKey } from "../idempotency-key";
import { adminOrderResourceMutationErrorResponses, adminWriteErrorResponses } from "./shared";
import { createCheckoutAppFunctions } from "../../../plugins/checkout-functions";
import { getOptionalExecutionContext } from "../../../utils/execution-context";
import { requestAppProviders } from "../../../plugins/providers/app-providers";

const app = new OpenAPIHono<{ Bindings: Env }>();

/**
 * The apps' checkout functions for a staff order (channel "admin"): one
 * indexed registration read; none active means no app work.
 */
async function manualOrderApps(env: Env, ctx: ExecutionContext | undefined, db: Database) {
    return createCheckoutAppFunctions({ env, ctx, db, registrations: await listActiveFunctionRegistrations(db) });
}

const manualOrderRequestKeySchema = z.uuid("A valid manual-order request key is required");
const manualOrderIdempotencyHeadersSchema = z.object({
    "idempotency-key": manualOrderRequestKeySchema.optional().openapi({
        description: "Standard retry key. May replace body.requestKey; if both are sent they must match.",
    }),
});
const createOrderRequestSchema = createOrderObjectSchema.extend({
    requestKey: manualOrderRequestKeySchema.optional(),
}).superRefine(refineDeliveryLine);

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
    appDiscounts: z.array(z.object({
        appId: z.string(),
        appName: z.string(),
        title: z.string(),
        /** Off the items. */
        amount: z.number().nonnegative(),
        /** Off delivery. */
        shippingAmount: z.number().nonnegative(),
    })).optional().openapi({
        description: "Installed apps' discounts (checkout functions), applied after the staff discount and included in discountAmount. Amendment previews carry none.",
    }),
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
    const db = c.get("db");
    const apps = await manualOrderApps(c.env, getOptionalExecutionContext(c) as ExecutionContext | undefined, db);
    const quote = await quoteManualOrder(db, c.req.valid("json"), {
        apps: createManualOrderAppFunctions(db, apps),
        appProviders: requestAppProviders(c),
    });
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
        { appProviders: requestAppProviders(c) },
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
        body: { content: { "application/json": { schema: confirmManualOrderAmendmentObjectSchema.partial({ requestKey: true }).superRefine(refineDeliveryLine) } } },
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
        { appProviders: requestAppProviders(c) },
    );

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
    const ctx = getOptionalExecutionContext(c) as ExecutionContext | undefined;
    const apps = await manualOrderApps(c.env, ctx, db);
    const { response } = await createManualOrder(db, data, user?.id ?? null, {
        apps: createManualOrderAppFunctions(db, apps),
        appProviders: requestAppProviders(c),
    });
    return created(c, response);
});

export { app as adminOrderCreateRoutes };
