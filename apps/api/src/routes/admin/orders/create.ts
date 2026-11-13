// Manual order quotes, creation and COD amendments.
import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "../admin-router";
import type { Context } from "hono";
import {
    buildAppPaymentReviewHoldInsert,
    buildOrderEventInsert,
    orderEventIdForRequest,
    confirmManualOrderAmendment,
    createManualOrder,
    previewManualOrderAmendment,
    quoteManualOrder,
    quoteManualOrderPlacement,
    type ManualOrderPlacementQuoteInput,
    createOrderObjectSchema,
    quoteManualOrderSchema,
    previewManualOrderAmendmentSchema,
    confirmManualOrderAmendmentObjectSchema,
    refineDeliveryLine,
    listOrderHolds,
    planPointOfSaleTenders,
    type CreateOrderInput,
} from "@scalius/core/modules/orders";
import { ok, created } from "../../../utils/api-response";
import {
    successEnvelope,
    idResponse,
    errorResponses,
    conflictResponse,
    serviceUnavailableResponse,
} from "../../../schemas/responses";

import { listActiveCheckoutRegistrations } from "@scalius/core/modules/plugins";
import { createManualOrderAppFunctions, validateCheckoutAttributes } from "@scalius/core/modules/checkout";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { CHECKOUT_ATTRIBUTE_TYPES, checkoutAttributeFields } from "@scalius/shared/plugins/buyer-ui";
import { offeredChoices } from "@scalius/shared/plugins/checkout-attribute-values";
import { localizedAppName, pluginTextChain } from "@scalius/shared/plugins/manifest-text";
import { storefrontUiSlotsOn } from "@scalius/shared/plugins/storefront-protocol";
import type { Database } from "@scalius/database/client";
import { orderItems, orders } from "@scalius/database/schema";
import type { RecordedPaymentVia } from "@scalius/shared/payment-terms";
import { recordOrderPayment } from "@scalius/core/modules/payments";
import { fromMinor } from "@scalius/shared/money";
import { eq } from "drizzle-orm";
import { autoFulfilAfterResponse } from "../../../background/auto-fulfil";
import { notificationSender } from "../../../background/notification-sender";
import { sendOrderNotification } from "../../../utils/order-notifications";
import { resolveCanonicalIdempotencyKey } from "../idempotency-key";
import { adminOrderResourceMutationErrorResponses } from "./shared";
import { createCheckoutAppFunctions } from "../../../plugins/checkout-functions";
import { getOptionalExecutionContext } from "../../../utils/execution-context";
import { requestAppProviders } from "../../../plugins/providers/app-providers";
import { requestActorId, requestStaffId, requireActorId } from "../request-actor";
import { handOverOrderLines } from "./fulfilments";
import { ValidationError } from "../../../utils/api-error";

const app = adminRouter();

/**
 * The apps' checkout functions for a staff order (channel "admin"): one
 * indexed registration read (functions and payment providers, so a payment
 * app's purchase options are offered as at checkout); none active means no
 * app work.
 */
async function manualOrderApps(env: Env, ctx: ExecutionContext | undefined, db: Database, language?: string | null, registrations?: Awaited<ReturnType<typeof listActiveCheckoutRegistrations>>) {
    return createCheckoutAppFunctions({ env, ctx, db, registrations: registrations ?? await listActiveCheckoutRegistrations(db), buyerRequest: null, ...(language ? { language } : {}) });
}

const manualOrderRequestKeySchema = z.uuid("A valid manual-order request key is required");
const manualOrderIdempotencyHeadersSchema = z.object({
    "idempotency-key": manualOrderRequestKeySchema.optional().openapi({
        description: "Standard retry key. May replace body.requestKey; if both are sent they must match.",
    }),
});
// Staff orders are channel "admin"; only the app API attributes an order to an app.
const createOrderRequestSchema = createOrderObjectSchema.omit({ channel: true }).extend({
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
    const data = c.req.valid("json");
    // The apps' answers staff gave, checked against their declarations; the apps' functions see them.
    const attributes = data.attributes ? validateCheckoutAttributes(apps, data.attributes) : undefined;
    const quote = await quoteManualOrder(db, { ...data, ...(attributes ? { attributes } : {}) }, {
        apps: createManualOrderAppFunctions(db, apps),
        appProviders: requestAppProviders(c),
    });
    return ok(c, quote);
});

const appFieldsRoute = createRoute({
    operationId: "dashboard.orders.app_fields",
    method: "post",
    path: "/app-fields",
    tags: ["Admin - Orders"],
    summary: "The active apps' checkout questions for a staff order",
    description: "What the order form asks so the apps' checkout rules can pass on a staff order (their `cart.validate` runs on it, as at checkout): every question an app's checkout block draws, with the choices it computes now (open delivery days and windows), then every required one it declares. Labels in `language`. Reads only.",
    request: {
        body: { content: { "application/json": { schema: z.object({
            attributes: z.record(z.string().max(160), z.string().max(500)).optional().openapi({ description: "The answers so far (`<app id>.<key>`): a later question's choices may follow an earlier answer." }),
            language: z.enum(["en", "bn"]).optional().openapi({ description: "The staff member's dashboard language." }),
        }).strict() } } },
    },
    responses: {
        200: {
            description: "The apps' questions, in the order checkout draws them",
            content: { "application/json": { schema: successEnvelope(z.object({
                fields: z.array(z.object({
                    appId: z.string(),
                    appName: z.string(),
                    key: z.string().openapi({ description: "`<app id>.<key>`: the answer's name in `attributes`." }),
                    label: z.string(),
                    help: z.string().nullable(),
                    type: z.enum(CHECKOUT_ATTRIBUTE_TYPES),
                    required: z.boolean(),
                    maxLength: z.number().int().nullable(),
                    choices: z.array(z.object({ value: z.string(), label: z.string() })).openapi({ description: "Declared choices, or those the app computed now; empty for free text." }),
                })),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(appFieldsRoute, async (c) => {
    const db = c.get("db");
    const { attributes = {}, language } = c.req.valid("json");
    const registrations = await listActiveCheckoutRegistrations(db);
    const apps = await manualOrderApps(c.env, getOptionalExecutionContext(c) as ExecutionContext | undefined, db, language ?? null, registrations);
    const declared = apps.attributes ?? [];
    if (declared.every((app) => app.fields.length === 0)) return ok(c, { fields: [] });
    const store = await readStoreCurrency(db);
    // The checkout slots' blocks, run as the buyer's checkout runs them, without a cart: the app computes its choices.
    const blocks = await apps.buyerUi?.({ targets: storefrontUiSlotsOn("checkout"), currency: store.code, cart: null, attributes, ...(language ? { language } : {}) }) ?? [];
    // Each app's name in the staff member's language, as its questions are.
    const words = { locale: apps.language ?? language ?? "en", defaultLocale: registrations[0]?.storeLocale ?? "en" };
    const names = new Map(registrations.map(({ installation }) => [
        installation.pluginId,
        localizedAppName(installation.manifest.name, pluginTextChain(installation.manifest.translations, words)),
    ]));
    const fields = checkoutAttributeFields(blocks, declared).map(({ appId, key, attribute, choices }) => ({
        appId,
        appName: names.get(appId) ?? appId,
        key,
        label: attribute.label,
        help: attribute.help ?? null,
        type: attribute.type,
        required: attribute.required === true,
        maxLength: attribute.maxLength ?? null,
        // Computed days in the staff member's language, a computed choice under its declared label (as at checkout).
        choices: offeredChoices(attribute, choices, apps.language ?? language ?? "en") ?? [...(attribute.choices ?? [])],
    }));
    return ok(c, { fields });
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
        body: { content: { "application/json": { schema: confirmManualOrderAmendmentObjectSchema.partial({ requestKey: true }).extend({
            notifyCustomer: z.boolean().optional().openapi({ description: "Send the customer the updated order (order_updated). Default false." }),
        }).superRefine(refineDeliveryLine) } } },
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
    const { requestKey: bodyRequestKey, notifyCustomer, ...payload } = c.req.valid("json");
    const requestKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyRequestKey,
        "requestKey",
    );
    const result = await confirmManualOrderAmendment(
        c.get("db"),
        c.req.valid("param").id,
        { ...payload, requestKey },
        requireActorId(c, "Sign in again to change the order."),
        { appProviders: requestAppProviders(c) },
    );

    // The customer gets the updated order when staff chose to tell them (once per amendment).
    if (notifyCustomer) {
        await sendOrderNotification({
            db: c.get("db"),
            send: notificationSender(c),
            orderId: result.id,
            notificationType: "order_updated",
            dedupeKey: `order_updated:${result.id}:${result.version}`,
            source: "orders-amendment",
        });
    }
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
        ...errorResponses,
        // Another request owns this creation, or the customer record changed while the order was placed.
        409: conflictResponse,
        503: serviceUnavailableResponse,
    }
});

app.openapi(createOrderRoute, async (c) => {
    const { requestKey: bodyRequestKey, ...payload } = c.req.valid("json");
    const requestKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyRequestKey,
        "requestKey",
    );
    const { response } = await placeManualOrder(c, { ...payload, requestKey });
    return created(c, response);
});

/**
 * Places a staff or app order with the apps' checkout functions, then runs
 * their advisory risk checks after the commit (never on a replay). Shared by
 * `dashboard.orders.create` and `dashboard.resources.orders.create`.
 * `attributes` are checked against the apps' declared checkout fields.
 */
export async function placeManualOrder(c: Context<{ Bindings: Env }>, data: CreateOrderInput) {
    const db = c.get("db");
    const actor = requireActorId(c, "Sign in again to place the order.");
    const ctx = getOptionalExecutionContext(c) as ExecutionContext | undefined;
    const apps = await manualOrderApps(c.env, ctx, db);
    const attributes = data.attributes ? validateCheckoutAttributes(apps, data.attributes) : undefined;
    if (data.paid && data.pointOfSale) throw new ValidationError("An in-person sale is paid by its tenders: send pointOfSale without paid.");
    // Mark as paid, or an in-person sale: placed with the payment method
    // `manual` (no invoice, no terms), its payments recorded right after.
    const placed = data.pointOfSale ? { ...data, channel: "pos" as const } : data;
    const { response, committed } = await createManualOrder(db, { ...placed, ...(attributes ? { attributes } : {}) }, actor, {
        apps: createManualOrderAppFunctions(db, apps),
        appProviders: requestAppProviders(c),
        // Apps and agents invoice only while the store offers invoices; staff always may.
        automated: Boolean(c.get("pluginPrincipal") || c.get("agentPrincipal")),
    });
    // A replay records it too: the payment's own key makes a second record a no-op.
    if (data.paid) await recordPaidOnPlacement(c, db, response.id, data.requestKey, data.paid);
    // A replay completes a sale a lost response left part-done: every step is keyed.
    if (data.pointOfSale) await completePointOfSale(c, db, response.id, data.requestKey, data.pointOfSale);
    // Apps' risk checks run from the order.created event (ctx.orders), never on this request.
    return { response, committed };
}

/**
 * Prices an order as `placeManualOrder` would place it now, with the same
 * apps and providers, and writes nothing (the stable `orders.quote`).
 */
export async function quoteManualOrderPlacementOfRequest(c: Context<{ Bindings: Env }>, data: ManualOrderPlacementQuoteInput) {
    const db = c.get("db");
    const apps = await manualOrderApps(c.env, getOptionalExecutionContext(c) as ExecutionContext | undefined, db);
    const attributes = data.attributes ? validateCheckoutAttributes(apps, data.attributes) : undefined;
    return quoteManualOrderPlacement(db, { ...data, ...(attributes ? { attributes } : {}) }, {
        apps: createManualOrderAppFunctions(db, apps),
        appProviders: requestAppProviders(c),
    });
}

/** Records one payment received as the order was placed, with its timeline line (and an app's review hold) in its batch. */
async function recordPlacementPayment(
    c: Context<{ Bindings: Env }>,
    db: Database,
    orderId: string,
    payment: { requestKey: string; amountMinor: number; via: RecordedPaymentVia; reference: string | null },
) {
    const appPrincipal = c.get("pluginPrincipal");
    const actingStaffId = requestStaffId(c);
    return recordOrderPayment(db, {
        orderId,
        amountMinor: payment.amountMinor,
        via: payment.via,
        reference: payment.reference,
        note: null,
        recordedBy: appPrincipal ? `app:${appPrincipal.pluginId}` : `staff:${actingStaffId ?? "unknown"}`,
        requestKey: payment.requestKey,
        timelineLine: async ({ paymentId, currency, landed }) => ({ statement: buildOrderEventInsert(db, {
            id: await orderEventIdForRequest(orderId, "payment_recorded", paymentId),
            orderId,
            kind: "payment_recorded",
            // An app's line names the app (app:<id>), never its approving admin.
            actorId: requestActorId(c),
            data: {
                amount: fromMinor(payment.amountMinor, currency.decimalPlaces),
                via: payment.via,
                reference: payment.reference,
                ...(appPrincipal ? { appId: appPrincipal.pluginId } : {}),
            },
        }, landed) }),
        ...(appPrincipal ? {
            reviewHold: ({ paymentId, landed }) => buildAppPaymentReviewHoldInsert(db, {
                orderId,
                paymentId,
                pluginId: appPrincipal.pluginId,
                appName: appPrincipal.pluginName,
                landed,
            }),
        } : {}),
    });
}

/**
 * Records the payment of an order placed as paid: its whole balance, keyed by
 * the order's request key, with its timeline line in the same batch; then
 * hands over its downloads and gift cards. An app's word moves no money, so
 * an app-placed order waits for staff review before they go out.
 */
async function recordPaidOnPlacement(
    c: Context<{ Bindings: Env }>,
    db: Database,
    orderId: string,
    requestKey: string,
    paid: NonNullable<CreateOrderInput["paid"]>,
): Promise<void> {
    const order = await db.select({ balanceDueMinor: orders.balanceDueMinor }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return;
    const result = await recordPlacementPayment(c, db, orderId, {
        requestKey: `${requestKey}:paid`,
        // A replay after the payment landed: the key returns the first record, whatever is due now.
        amountMinor: Math.max(order.balanceDueMinor, 1),
        via: paid.via,
        reference: paid.reference ?? null,
    }).catch((error: unknown) => {
        // Already paid (a replay whose first payment used another amount): nothing more to record.
        if (order.balanceDueMinor <= 0) return null;
        throw error;
    });
    if (result && !result.replayed && result.paymentStatus === "paid") await autoFulfilAfterResponse(c, db, orderId, "paid-manual-order");
}

/**
 * Completes an in-person sale its create committed: records each tender (less
 * the change) as a payment of its `via`, keyed by the sale's request key and
 * the tender's position, then hands every picked-up and performed line over
 * at the sale's counter, which delivers the order and deducts its stock at
 * that location (ledger v2). Every step is keyed, so a replay after a lost
 * response finishes what is left and repeats nothing. An order an app's
 * payment put on review (gift cards or downloads still owed) waits for staff
 * before anything is handed over.
 */
async function completePointOfSale(
    c: Context<{ Bindings: Env }>,
    db: Database,
    orderId: string,
    requestKey: string,
    sale: NonNullable<CreateOrderInput["pointOfSale"]>,
): Promise<void> {
    const order = await db.select({ totalAmountMinor: orders.totalAmountMinor }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return;
    // The plan the create checked, from the order's committed total.
    for (const payment of planPointOfSaleTenders(sale, order.totalAmountMinor).payments) {
        await recordPlacementPayment(c, db, orderId, {
            requestKey: `${requestKey}:pos:tender:${payment.index}`,
            amountMinor: payment.amountMinor,
            via: payment.via,
            reference: payment.reference,
        });
    }
    const holds = (await listOrderHolds(db, [orderId])).get(orderId) ?? [];
    if (holds.some((hold) => hold.releasedAt === null)) return;
    const lines = await db.select({ type: orderItems.fulfillmentType, quantity: orderItems.quantity, fulfilled: orderItems.fulfilledQuantity })
        .from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    for (const kind of ["pickup", "service"] as const) {
        if (!lines.some((line) => line.type === kind && line.fulfilled < line.quantity)) continue;
        await handOverOrderLines(c, orderId, { requestKey: `${requestKey}:pos:${kind}`, kind });
    }
    // Gift cards and downloads of a settled sale go out now.
    await autoFulfilAfterResponse(c, db, orderId, "pos-sale");
}

export { app as adminOrderCreateRoutes };
