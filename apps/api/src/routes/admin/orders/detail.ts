// One order: detail, items, payments, timeline and comments, notifications, edits, restore, recovery links and form data.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { listGiftCardPaymentLinks } from "../../shared/gift-card-payment-links";
import { relatedObjectsProjection, withRelatedObjects } from "../related-objects";
import { relatedObjectRecordSchema } from "../../../schemas/related-objects";
import { protectedField as pii } from "../../../schemas/protected";
import { requestPaymentProviders } from "../../../plugins/providers/payment";
import {
    ORDER_COMMENT_MAX_LENGTH,
    ORDER_EVENT_KINDS,
    addOrderComment,
    deleteOrderComment,
    getOrderDetails,
    getOrderEditReadiness,
    listOrderTimelinePage,
    orderBillingAddressSelection,
    orderShippingAddressSelection,
    previewOrderPaymentRecoveryLink,
    releaseOrderHold,
    recordOrderEvent,
    restoreOrder,
    updateOrderDetails,
    type OrderPaymentRecoveryPreview,
    updateOrderDetailsSchema,
    restoreOrderSchema,
    setOrderFulfillmentLocation,
    setOrderFulfillmentLocationSchema,
} from "@scalius/core/modules/orders";
import {
    loadVariantSelectedOptions,
    presentCatalogPrice,
    readStoreDecimalPlaces,
    readStoredCustomization,
} from "@scalius/core/modules/products";
import { withoutSkuCost } from "@scalius/core/modules/inventory";
import { fromMinor } from "@scalius/shared/money";
import { presentOrderLineFulfilment } from "@scalius/core/modules/orders/browser";
import {
    orderPayments,
    paymentPlans,
    orderItems,
    products,
    productVariants,
    media,
    orderHolds,
    orders,
} from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { ForbiddenError, NotFoundError, ServiceUnavailableError } from "../../../utils/api-error";
import { ok, created, noContent } from "../../../utils/api-response";
import {
    successEnvelope,
    noContentResponse,
    errorResponses,
    serviceUnavailableResponse,
} from "../../../schemas/responses";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import { publishedMediaObjectKey } from "@scalius/core/modules/media-references";
import {
    activeRefundOperationSchema,
    orderDetailSchema,
    orderEditReadinessSchema,
    orderItemSchema,
    orderPaymentRecoverySchema,
    orderRefundAttemptSchema,
    orderShippingAddressShape,
    productVariantSchema,
    selectedProductOptionSchema,
} from "../../../schemas/entities";
import { nullableTimestampSchema, timestampSchema } from "../../../schemas/timestamps";
import { orderBillingAddressShape } from "../../../schemas/billing-address";
import { composeOrderLineExtras, orderLineExtrasShape, withOrderLineExtras } from "../../shared/order-line-extras";
import {
    customizationViewSchema,
    deliveryMethodKindSchema,
    fulfillmentTypeSchema,
    orderLinePropertySchema,
} from "../../../schemas/order-lines";
import {
    listOrderPaymentSessionAttempts,
    listOrderRefundAttempts,
    summarizeActiveRefundOperation,
} from "@scalius/core/modules/payments";
import {
    listPaymentWebhookIssuesForOrder,
    PAYMENT_WEBHOOK_ISSUE_REASONS,
} from "../../../utils/payment-webhook-issues";
import {
    listOrderNotificationOutboxForOrder,
    resendTerminalOrderNotificationOutboxById,
    retryFailedOrderNotificationOutboxById,
} from "@scalius/core/modules/notifications";
import { resolveCanonicalIdempotencyKey } from "../idempotency-key";
import {
    type AdminRouteContext,
    type AdminRouteHandler,
    bulkRequestKeySchema,
    adminOrderResourceMutationErrorResponses,
} from "./shared";
import { notificationSender } from "../../../background/notification-sender";

const app = new OpenAPIHono<{ Bindings: Env }>();

const recoveryLinkPaymentTypeSchema = z.enum(["full", "deposit", "balance"]);

function resolveStorefrontUrl(env: Env): URL {
    const configuredUrl = env.STOREFRONT_URL?.trim();
    if (!configuredUrl) {
        throw new ServiceUnavailableError("Storefront URL is not configured.");
    }

    try {
        const url = new URL(configuredUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            throw new Error("Unsupported storefront URL protocol");
        }
        return url;
    } catch {
        throw new ServiceUnavailableError("Storefront URL is invalid.");
    }
}

function buildPaymentRecoveryUrl(
    storefrontUrl: URL,
    result: OrderPaymentRecoveryPreview,
): string {
    const url = new URL("/payment-recovery", storefrontUrl);
    url.searchParams.set("orderId", result.orderId);
    url.searchParams.set("payment", result.gateway);
    url.searchParams.set("result", "failed");
    if (result.paymentType) url.searchParams.set("paymentType", result.paymentType);
    if (typeof result.depositAmount === "number" && Number.isFinite(result.depositAmount)) {
        url.searchParams.set("depositAmount", String(result.depositAmount));
    }
    return url.toString();
}

const orderPaymentSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
    paymentMethod: z.string(),
    paymentType: z.string(),
    status: z.string(),
    providerRef: z.string().nullable(),
    providerSecondaryRef: z.string().nullable(),
    codCollectedBy: z.string().nullable(),
    codCollectedAt: z.union([z.string(), z.number()]).nullable(),
    codReceiptUrl: z.string().nullable(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
    giftCard: z.object({
        id: z.string(),
        last4: z.string(),
        storeCredit: z.boolean(),
    }).nullable().openapi({
        description: "The gift card this row moved money on (last 4 only): a tender, a refund to that card, or (storeCredit) the card a store-credit refund issued.",
    }),
});

const paymentPlanSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    totalAmount: z.number(),
    depositAmount: z.number(),
    balanceDue: z.number(),
    paidAmount: z.number(),
    depositPaidAt: z.union([z.string(), z.number()]).nullable(),
    balancePaidAt: z.union([z.string(), z.number()]).nullable(),
    balanceDueDate: z.string().nullable(),
    status: z.string(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
}).nullable();

const paymentWebhookIssueSchema = z.object({
    id: z.string(),
    provider: z.string(),
    eventType: z.string(),
    status: z.enum(["failed", "manual_reconciliation"]),
    reason: z.enum(PAYMENT_WEBHOOK_ISSUE_REASONS),
    message: z.string(),
    error: z.string().nullable(),
    processedAt: timestampSchema,
});

const paymentSessionAttemptSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    gateway: z.string(),
    paymentType: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
    attempts: z.number(),
    providerSessionId: z.string().nullable(),
    providerCorrelationId: z.string().nullable(),
    lastError: z.string().nullable(),
    claimExpiresAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    activeProcessing: z.boolean(),
    staleProcessing: z.boolean(),
});

const paymentRecoveryLinkResponseSchema = successEnvelope(z.object({
    orderId: z.string(),
    url: z.string().url(),
    expiresAt: timestampSchema.nullable(),
    accessMode: z.literal("buyer_verified_receipt"),
    note: z.string(),
    gateway: z.string(),
    paymentType: recoveryLinkPaymentTypeSchema.nullable(),
    depositAmount: z.number().nullable(),
    paymentRecovery: orderPaymentRecoverySchema,
}));

const orderFormDataSchema = z.object({
    id: z.string(),
    orderNumber: z.number().int().nullable(),
    version: z.number().int().min(1),
    customerName: pii("name", z.string()),
    customerPhone: pii("phone", z.string().nullable().openapi({ description: "E.164; null for an order placed without a phone (only digital or service lines, Customer accounts opt-in)." })),
    customerEmail: pii("email", z.string().nullable()),
    /**
     * The shipping-address snapshot; null fields when nothing ships (pickup or
     * service-only orders). The saved place names label the City/Thana/Area
     * pickers before they load.
     */
    ...orderShippingAddressShape,
    /** The billing snapshot: an amendment or edit that sends none keeps it. */
    ...orderBillingAddressShape,
    /** An amendment keeps the order's delivery method; new physical lines take its kind. */
    requiresShipping: z.boolean(),
    shippingMethodId: z.string().nullable(),
    shippingMethodKind: deliveryMethodKindSchema.nullable(),
    notes: z.string().nullable(),
    discountAmount: z.number().nullable(),
    shippingCharge: z.number(),
    status: z.string(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
}).passthrough();

const formDataItemSchema = z.object({
    orderItemId: z.string(),
    productId: z.string(),
    variantId: z.string().nullable(),
    quantity: z.number(),
    price: z.number(),
    fulfillmentType: fulfillmentTypeSchema,
    /**
     * The line's frozen buyer inputs. An amendment line sent with its
     * `orderItemId` keeps them (and its agreed price) whatever it sends;
     * only new lines resolve `properties` against today's schema.
     */
    properties: z.array(orderLinePropertySchema),
});

const formDataProductSchema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    isActive: z.boolean(),
    deletedAt: nullableTimestampSchema,
    discountPercentage: z.number().nullable(),
    discountType: z.string().nullable(),
    discountAmount: z.number().nullable(),
    /** Buyer inputs the product asks for; null when none. */
    customizationSchema: customizationViewSchema.nullable(),
    requiresCustomization: z.boolean(),
    variants: z.array(productVariantSchema.extend({
        selectedOptions: z.array(selectedProductOptionSchema),
    })),
}).passthrough();

// ─── GET/POST /:id/timeline ──────────────────────────────────────────────────

const timelineEventSchema = z.object({
    id: z.string(),
    kind: z.enum(ORDER_EVENT_KINDS),
    body: z.string().nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
    actorName: z.string().nullable(),
    own: z.boolean().openapi({ description: "The viewer wrote this comment and may delete it." }),
    createdAt: timestampSchema,
});

const getTimelineRoute = createRoute({
    operationId: "dashboard.orders.timeline",
    method: "get",
    path: "/{id}/timeline",
    tags: ["Admin - Orders"],
    summary: "Order timeline: 50 events per page, newest first; placed marker only at the end",
    request: {
        params: z.object({ id: z.string() }),
        query: z.object({ cursor: z.string().max(1024).optional() }),
    },
    responses: {
        200: {
            description: "Timeline",
            content: { "application/json": { schema: successEnvelope(z.object({ events: z.array(timelineEventSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() })) } },
        },
        400: errorResponses[400],
        404: errorResponses[404],
    },
});

app.openapi(getTimelineRoute, (async (c: AdminRouteContext<typeof getTimelineRoute>) => {
    const user = c.get("user") as { id?: string } | undefined;
    const page = await listOrderTimelinePage(c.get("db"), c.req.valid("param").id, user?.id ?? null, c.req.valid("query").cursor);
    return ok(c, { ...page, events: page.events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })) });
}) as unknown as AdminRouteHandler<typeof getTimelineRoute>);

const addCommentRoute = createRoute({
    operationId: "dashboard.orders.comment_add",
    method: "post",
    path: "/{id}/timeline",
    tags: ["Admin - Orders"],
    summary: "Add a staff comment to the order timeline",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        body: z.string().trim().min(1, "Write a comment first.")
                            .max(ORDER_COMMENT_MAX_LENGTH),
                        requestKey: bulkRequestKeySchema.openapi({
                            description: "One key per comment draft. Posting it again returns the first comment.",
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        201: {
            description: "Comment added",
            content: { "application/json": { schema: successEnvelope(timelineEventSchema) } },
        },
        ...adminOrderResourceMutationErrorResponses,
    },
});

app.openapi(addCommentRoute, (async (c: AdminRouteContext<typeof addCommentRoute>) => {
    const user = c.get("user") as { id?: string } | undefined;
    const event = await addOrderComment(
        c.get("db"),
        c.req.valid("param").id,
        c.req.valid("json").body,
        user?.id ?? null,
        c.req.valid("json").requestKey,
    );
    return created(c, { ...event, createdAt: event.createdAt.toISOString() });
}) as unknown as AdminRouteHandler<typeof addCommentRoute>);

const deleteCommentRoute = createRoute({
    operationId: "dashboard.orders.comment_delete",
    method: "delete",
    path: "/{id}/timeline/{eventId}",
    tags: ["Admin - Orders"],
    summary: "Delete one of your own comments from the order timeline",
    request: { params: z.object({ id: z.string(), eventId: z.string() }) },
    responses: {
        200: {
            description: "Comment deleted (or already gone)",
            content: { "application/json": { schema: successEnvelope(z.object({ deleted: z.literal(true) })) } },
        },
        ...adminOrderResourceMutationErrorResponses,
    },
});

app.openapi(deleteCommentRoute, (async (c: AdminRouteContext<typeof deleteCommentRoute>) => {
    const user = c.get("user") as { id?: string } | undefined;
    const { id, eventId } = c.req.valid("param");
    await deleteOrderComment(c.get("db"), id, eventId, user?.id ?? null);
    return ok(c, { deleted: true as const });
}) as unknown as AdminRouteHandler<typeof deleteCommentRoute>);

// ─── POST /:id/holds/:holdId/release ─────────────────────────────────────────

const holdSchema = z.object({
    id: z.string(),
    appId: z.string(),
    appName: z.string(),
    reason: z.string(),
    placedAt: z.string(),
    releasedAt: z.string().nullable(),
});

const releaseHoldRoute = createRoute({
    operationId: "dashboard.orders.release_hold",
    method: "post",
    path: "/{id}/holds/{holdId}/release",
    tags: ["Admin - Orders"],
    summary: "Release an app's hold after staff review",
    description: "The order can be shipped, handed over and moved on again once no hold is open. Releasing a released hold changes nothing.",
    request: {
        params: z.object({ id: z.string(), holdId: z.string().max(64) }),
    },
    responses: {
        200: {
            description: "The released hold",
            content: { "application/json": { schema: successEnvelope(holdSchema) } },
        },
        ...adminOrderResourceMutationErrorResponses,
    },
});

app.openapi(releaseHoldRoute, async (c) => {
    const { id, holdId } = c.req.valid("param");
    // An app releases only the holds it placed; another app's review stays with staff.
    const plugin = c.get("pluginPrincipal");
    if (plugin) {
        const placed = await c.get("db").select({ pluginId: orderHolds.pluginId }).from(orderHolds)
            .where(and(eq(orderHolds.id, holdId), eq(orderHolds.orderId, id))).get();
        if (!placed) throw new NotFoundError("Hold not found");
        if (placed.pluginId !== plugin.pluginId) throw new ForbiddenError("An app can release only the holds it placed.");
    }
    const user = c.get("user") as { id?: string } | undefined;
    const hold = await releaseOrderHold(c.get("db"), id, holdId, user?.id ?? null);
    return ok(c, {
        id: hold.id,
        appId: hold.pluginId,
        appName: hold.appName,
        reason: hold.reason,
        placedAt: new Date(hold.createdAt * 1000).toISOString(),
        releasedAt: hold.releasedAt === null ? null : new Date(hold.releasedAt * 1000).toISOString(),
    });
});

// ─── POST /:id/payment-recovery-link ─────────────────────────────────────────

const createPaymentRecoveryLinkRoute = createRoute({
    operationId: "dashboard.orders.payment_recovery_link",
    method: "post",
    path: "/{id}/payment-recovery-link",
    tags: ["Admin - Orders"],
    summary: "Issue a hosted-payment receipt recovery link",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        201: {
            description: "Hosted-payment recovery link issued",
            content: { "application/json": { schema: paymentRecoveryLinkResponseSchema } },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(createPaymentRecoveryLinkRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const storefrontUrl = resolveStorefrontUrl(c.env);
    const recoveryLink = await previewOrderPaymentRecoveryLink(db, orderId, {
        // An app's hosted gateway can be recovered like a built-in one (read only when one is named).
        paymentProviders: () => requestPaymentProviders(c),
    });
    const url = buildPaymentRecoveryUrl(storefrontUrl, recoveryLink);

    return created(c, {
        orderId: recoveryLink.orderId,
        url,
        expiresAt: null,
        accessMode: "buyer_verified_receipt" as const,
        note: "This clean recovery URL contains no private receipt proof. The buyer must verify the order contact before this browser receives receipt access.",
        gateway: recoveryLink.gateway,
        paymentType: recoveryLink.paymentType,
        depositAmount: recoveryLink.depositAmount,
        paymentRecovery: recoveryLink.paymentRecovery,
    });
});

// ─── GET /:id ────────────────────────────────────────────────────────────────

/** Order detail whose items may carry per-line extras (downloads, gift cards, warranty, review). */
const orderDetailWithLineExtrasSchema = orderDetailSchema.extend({
    relatedObjects: z.array(relatedObjectRecordSchema),
    items: z.array(orderItemSchema.extend(orderLineExtrasShape)),
});

const getOrderRoute = createRoute({
    operationId: "dashboard.orders.get",
    method: "get",
    path: "/{id}",
    tags: ["Admin - Orders"],
    summary: "Get order details",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order details",
            content: { "application/json": { schema: successEnvelope(orderDetailWithLineExtrasSchema) } },
        },
        404: errorResponses[404],
    }
});

app.openapi(getOrderRoute, (async (c: AdminRouteContext<typeof getOrderRoute>) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const result = await getOrderDetails(db, orderId, relatedObjectsProjection(c, "order", orderId));
    if (!result) throw new NotFoundError("Order not found");
    const lineExtras = await composeOrderLineExtras(db, {
        orderId,
        orderItemIds: result.items.map((item) => item.id),
        audience: "staff",
        currencyDecimalPlaces: result.currencyDecimalPlaces ?? 2,
    });
    return ok(c, { ...withRelatedObjects(result), items: result.items.map((item) => withOrderLineExtras(item, lineExtras)) });
}) as unknown as AdminRouteHandler<typeof getOrderRoute>);

// ─── PUT /:id/details ───────────────────────────────────────────────────────

const updateOrderDetailsRoute = createRoute({
    operationId: "dashboard.orders.update_details",
    method: "put",
    path: "/{id}/details",
    tags: ["Admin - Orders"],
    summary: "Edit the customer and delivery details of an order that has not shipped",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateOrderDetailsSchema } } },
    },
    responses: {
        200: {
            description: "Details saved",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({ id: z.string(), version: z.number().int().min(1) })),
                },
            },
        },
        ...adminOrderResourceMutationErrorResponses,
    },
});

app.openapi(updateOrderDetailsRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const user = c.get("user") as { id?: string } | undefined;
    const result = await updateOrderDetails(db, orderId, c.req.valid("json"));
    if (result.changedFields.length > 0) {
        await recordOrderEvent(db, {
            orderId,
            kind: "details_edited",
            actorId: user?.id ?? null,
            data: { fields: result.changedFields },
        });
    }
    return ok(c, { id: result.id, version: result.version });
});

// ─── PUT /:id/fulfillment-location ──────────────────────────────────────────

const setFulfillmentLocationRoute = createRoute({
    operationId: "dashboard.orders.fulfillment_location_set",
    method: "put",
    path: "/{id}/fulfillment-location",
    tags: ["Admin - Orders"],
    summary: "Choose the location an unshipped order's stock leaves from",
    description: "An active location, or null for the store default. Allowed until anything has left: no stock deducted and no ship or pickup fulfilment.",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: setOrderFulfillmentLocationSchema } } },
    },
    responses: {
        200: {
            description: "Fulfilment location saved",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        id: z.string(),
                        version: z.number().int().min(1),
                        fulfillmentLocationId: z.string().nullable(),
                    })),
                },
            },
        },
        ...adminOrderResourceMutationErrorResponses,
    },
});

app.openapi(setFulfillmentLocationRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const user = c.get("user") as { id?: string } | undefined;
    // The timeline line is written in the same batch as the change.
    const result = await setOrderFulfillmentLocation(c.get("db"), orderId, c.req.valid("json"), user?.id ?? null);
    return ok(c, { id: result.id, version: result.version, fulfillmentLocationId: result.fulfillmentLocationId });
});

// ─── POST /:id/restore ──────────────────────────────────────────────────────

const restoreOrderRoute = createRoute({
    operationId: "dashboard.orders.restore",
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Orders"],
    summary: "Restore an archived order to the active workspace",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: restoreOrderSchema } } },
    },
    responses: {
        204: noContentResponse,
        ...adminOrderResourceMutationErrorResponses,
    }
});

app.openapi(restoreOrderRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const user = c.get("user") as { id?: string } | undefined;
    await restoreOrder(db, orderId, data.expectedVersion);
    await recordOrderEvent(db, { orderId, kind: "unarchived", actorId: user?.id ?? null });
    return noContent(c);
});

// ─── GET /:id/items ──────────────────────────────────────────────────────────

const getItemsRoute = createRoute({
    operationId: "dashboard.orders.items",
    method: "get",
    path: "/{id}/items",
    tags: ["Admin - Orders"],
    summary: "Get order items with product details",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order items",
            content: { "application/json": { schema: successEnvelope(z.array(orderItemSchema)) } },
        },
    }
});

app.openapi(getItemsRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");

    const items = await db
        .select({
            id: orderItems.id,
            productId: orderItems.productId,
            productName: orderItems.productName,
            productImageObjectKey: publishedMediaObjectKey(),
            productImageStatus: media.status,
            variantId: orderItems.variantId,
            variantLabel: orderItems.variantLabel,
            quantity: orderItems.quantity,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            inventoryTracked: orderItems.inventoryTracked,
            unitPriceMinor: orderItems.unitPriceMinor,
            lineSubtotalMinor: orderItems.lineSubtotalMinor,
            discountAmountMinor: orderItems.discountAmountMinor,
            taxableAmountMinor: orderItems.taxableAmountMinor,
            taxAmountMinor: orderItems.taxAmountMinor,
            fulfillmentType: orderItems.fulfillmentType,
            fulfilledQuantity: orderItems.fulfilledQuantity,
            properties: orderItems.properties,
            propertiesPriceMinor: orderItems.propertiesPriceMinor,
            baseUnitPriceMinor: orderItems.baseUnitPriceMinor,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(eq(orderItems.orderId, orderId))
        .leftJoin(media, eq(orderItems.productImageMediaId, media.id));

    return ok(c, items.map(({ productImageObjectKey, productImageStatus, currencyDecimalPlaces, ...item }) => ({
        ...item,
        ...presentOrderLineFulfilment(item, currencyDecimalPlaces),
        price: fromMinor(item.unitPriceMinor, currencyDecimalPlaces),
        productImage:
            productImageObjectKey &&
            (productImageStatus === "ready" || productImageStatus === "trashed")
                ? getCurrentPublicMediaUrl(productImageObjectKey)
                : null,
    })));
});

// ─── GET /:id/payments ───────────────────────────────────────────────────────

const getPaymentsRoute = createRoute({
    operationId: "dashboard.orders.payments",
    method: "get",
    path: "/{id}/payments",
    tags: ["Admin - Orders"],
    summary: "Get order payments and payment plan",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order payments",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        payments: z.array(orderPaymentSchema),
                        plan: paymentPlanSchema,
                        refundAttempts: z.array(orderRefundAttemptSchema),
                        activeRefundOperation: activeRefundOperationSchema.nullable(),
                        paymentWebhookIssues: z.array(paymentWebhookIssueSchema),
                        paymentSessionAttempts: z.array(paymentSessionAttemptSchema),
                    })),
                },
            },
        },
    }
});

app.openapi(getPaymentsRoute, (async (c: AdminRouteContext<typeof getPaymentsRoute>) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");

    const [order, payments, plan, refundAttemptViews, paymentWebhookIssues, paymentSessionAttemptViews] = await Promise.all([
        db.select({ currencyDecimalPlaces: orders.currencyDecimalPlaces }).from(orders)
            .where(eq(orders.id, orderId)).get(),
        db.select({
            id: orderPayments.id,
            orderId: orderPayments.orderId,
            amountMinor: orderPayments.amountMinor,
            currency: orderPayments.currency,
            paymentMethod: orderPayments.paymentMethod,
            paymentType: orderPayments.paymentType,
            status: orderPayments.status,
            providerRef: orderPayments.providerRef,
            providerSecondaryRef: orderPayments.providerSecondaryRef,
            codCollectedBy: orderPayments.codCollectedBy,
            codCollectedAt: orderPayments.codCollectedAt,
            codReceiptUrl: orderPayments.codReceiptUrl,
            createdAt: orderPayments.createdAt,
            updatedAt: orderPayments.updatedAt,
        }).from(orderPayments).where(eq(orderPayments.orderId, orderId)).all(),
        db.select().from(paymentPlans).where(eq(paymentPlans.orderId, orderId)).get(),
        listOrderRefundAttempts(db, orderId, { audience: "admin" }),
        listPaymentWebhookIssuesForOrder(db, orderId),
        listOrderPaymentSessionAttempts(db, orderId),
    ]);

    const amount = (minor: number) => fromMinor(minor, order?.currencyDecimalPlaces ?? 2);
    // After the parallel reads, so the handler never holds more than six D1 connections.
    const giftCardLinks = await listGiftCardPaymentLinks(db, orderId, payments);
    return ok(c, {
        payments: payments.map(({ amountMinor, ...payment }) => ({
            ...payment,
            amount: amount(amountMinor),
            giftCard: giftCardLinks.get(payment.id) ?? null,
        })),
        plan: plan
            ? (({ totalAmountMinor, depositAmountMinor, balanceDueMinor, ...facts }) => ({
                ...facts,
                totalAmount: amount(totalAmountMinor),
                depositAmount: amount(depositAmountMinor),
                balanceDue: amount(balanceDueMinor),
            }))(plan)
            : null,
        refundAttempts: refundAttemptViews,
        activeRefundOperation: summarizeActiveRefundOperation(refundAttemptViews, "admin"),
        paymentWebhookIssues,
        paymentSessionAttempts: paymentSessionAttemptViews,
    });
}) as unknown as AdminRouteHandler<typeof getPaymentsRoute>);

// ─── GET /:id/notifications ────────────────────────────────────────────────

const orderNotificationReceiptSchema = z.object({
    id: z.string(),
    receiptKey: z.string(),
    channel: z.string(),
    provider: z.string(),
    recipientMasked: z.string().nullable(),
    status: z.string(),
    providerMessageId: z.string().nullable(),
    providerStatus: z.string().nullable(),
    attempts: z.number(),
    nextAttemptAt: timestampSchema.nullable(),
    lastAttemptAt: timestampSchema.nullable(),
    lastError: z.string().nullable(),
    acceptedAt: timestampSchema.nullable(),
    deliveredAt: timestampSchema.nullable(),
    failedAt: timestampSchema.nullable(),
    skippedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});

const orderNotificationOutboxSchema = z.object({
    id: z.string(),
    dedupeKey: z.string(),
    orderId: z.string(),
    notificationType: z.string(),
    source: z.string(),
    status: z.string(),
    attempts: z.number(),
    nextAttemptAt: timestampSchema,
    lastError: z.string().nullable(),
    sentAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    receipts: z.array(orderNotificationReceiptSchema),
});

const getNotificationsRoute = createRoute({
    operationId: "dashboard.orders.notifications",
    method: "get",
    path: "/{id}/notifications",
    tags: ["Admin - Orders"],
    summary: "Get order notification delivery history",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order notification history",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        notifications: z.array(orderNotificationOutboxSchema),
                    })),
                },
            },
        },
    },
});

app.openapi(getNotificationsRoute, (async (c: AdminRouteContext<typeof getNotificationsRoute>) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");
    const notifications = await listOrderNotificationOutboxForOrder(db, orderId);
    return ok(c, { notifications });
}) as unknown as AdminRouteHandler<typeof getNotificationsRoute>);

// ─── POST /:id/notifications/:outboxId/retry ───────────────────────────────

const retryNotificationRoute = createRoute({
    operationId: "dashboard.orders.notification_retry",
    method: "post",
    path: "/{id}/notifications/{outboxId}/retry",
    tags: ["Admin - Orders"],
    summary: "Retry a failed order notification",
    request: {
        params: z.object({ id: z.string(), outboxId: z.string() }),
    },
    responses: {
        200: {
            description: "Retry result",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        outboxId: z.string(),
                        dedupeKey: z.string(),
                        created: z.boolean(),
                        enqueued: z.boolean(),
                        skippedReason: z.string().optional(),
                    })),
                },
            },
        },
    },
});

app.openapi(retryNotificationRoute, (async (c: AdminRouteContext<typeof retryNotificationRoute>) => {
    const { id: orderId, outboxId } = c.req.valid("param");
    const db = c.get("db");
    const result = await retryFailedOrderNotificationOutboxById({
        db,
        send: notificationSender(c),
        orderId,
        outboxId,
    });
    return ok(c, result);
}) as unknown as AdminRouteHandler<typeof retryNotificationRoute>);

// ─── POST /:id/notifications/:outboxId/resend ──────────────────────────────

const resendNotificationBodySchema = z.object({
    resendRequestId: z.string().trim().min(1).max(128).optional(),
});
const resendNotificationRequestIdSchema = z.string().trim().min(1).max(128);
const resendNotificationIdempotencyHeadersSchema = z.object({
    "idempotency-key": resendNotificationRequestIdSchema.optional().openapi({
        description: "Standard retry key. May replace body.resendRequestId; if both are sent they must match.",
    }),
});

const resendNotificationRoute = createRoute({
    operationId: "dashboard.orders.notification_resend",
    method: "post",
    path: "/{id}/notifications/{outboxId}/resend",
    tags: ["Admin - Orders"],
    summary: "Manually resend an already-sent order notification",
    request: {
        params: z.object({ id: z.string(), outboxId: z.string() }),
        headers: resendNotificationIdempotencyHeadersSchema,
        body: { required: true, content: { "application/json": { schema: resendNotificationBodySchema } } },
    },
    responses: {
        200: {
            description: "Manual resend result",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        outboxId: z.string(),
                        dedupeKey: z.string(),
                        created: z.boolean(),
                        enqueued: z.boolean(),
                        skippedReason: z.string().optional(),
                    })),
                },
            },
        },
    },
});

app.openapi(resendNotificationRoute, (async (c: AdminRouteContext<typeof resendNotificationRoute>) => {
    const { id: orderId, outboxId } = c.req.valid("param");
    const { resendRequestId: bodyResendRequestId } = c.req.valid("json");
    const resendRequestId = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyResendRequestId,
        "resendRequestId",
    );
    const db = c.get("db");
    const result = await resendTerminalOrderNotificationOutboxById({
        db,
        send: notificationSender(c),
        orderId,
        outboxId,
        resendRequestId,
    });
    return ok(c, result);
}) as unknown as AdminRouteHandler<typeof resendNotificationRoute>);

// ─── GET /:id/form-data ──────────────────────────────────────────────────────

const getFormDataRoute = createRoute({
    operationId: "dashboard.orders.form_data",
    method: "get",
    path: "/{id}/form-data",
    tags: ["Admin - Orders"],
    summary: "Get order data with products for the edit form",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order form data",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        order: orderFormDataSchema,
                        editReadiness: orderEditReadinessSchema,
                        productsWithVariants: z.array(formDataProductSchema),
                        defaultValues: orderFormDataSchema.extend({
                            discountAmount: z.number().nullable(),
                            items: z.array(formDataItemSchema),
                        }),
                    })),
                },
            },
        },
        404: errorResponses[404],
    }
});

app.openapi(getFormDataRoute, (async (c: AdminRouteContext<typeof getFormDataRoute>) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");

    const [[orderRow], storeDecimalPlaces] = await Promise.all([db
        .select({
            id: orders.id,
            orderNumber: orders.orderNumber,
            version: orders.version,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            ...orderShippingAddressSelection(orders),
            ...orderBillingAddressSelection(orders),
            requiresShipping: orders.requiresShipping,
            shippingMethodId: orders.shippingMethodId,
            shippingMethodKind: orders.shippingMethodKind,
            notes: orders.notes,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            discountAmountMinor: orders.discountAmountMinor,
            shippingAmountMinor: orders.shippingAmountMinor,
            status: orders.status,
            createdAt: orders.createdAt,
            updatedAt: orders.updatedAt,
        })
        .from(orders)
        .where(eq(orders.id, orderId)), readStoreDecimalPlaces(db)]);

    if (!orderRow) throw new NotFoundError("Order not found");
    const { currencyDecimalPlaces, discountAmountMinor, shippingAmountMinor, ...orderFacts } = orderRow;
    const orderAmount = (minor: number) => fromMinor(minor, currencyDecimalPlaces);
    const order = {
        ...orderFacts,
        discountAmount: orderAmount(discountAmountMinor),
        shippingCharge: orderAmount(shippingAmountMinor),
    };

    const editReadiness = await getOrderEditReadiness(db, orderId);
    if (!editReadiness) throw new NotFoundError("Order not found");

    const items = await db
        .select({
            id: orderItems.id,
            productId: orderItems.productId,
            variantId: orderItems.variantId,
            quantity: orderItems.quantity,
            unitPriceMinor: orderItems.unitPriceMinor,
            productName: orderItems.productName,
            variantLabel: orderItems.variantLabel,
            fulfillmentType: orderItems.fulfillmentType,
            properties: orderItems.properties,
            propertiesPriceMinor: orderItems.propertiesPriceMinor,
            fulfilledQuantity: orderItems.fulfilledQuantity,
            baseUnitPriceMinor: orderItems.baseUnitPriceMinor,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

    // The edit payload contains only the exact catalog identities already on
    // the order. New item discovery is independently paginated by
    // /catalog-products, so this read stays bounded by the order rather than
    // growing with the merchant's entire catalog.
    const orderProductIds = [...new Set(items.map((item) => item.productId).filter(Boolean))];
    const orderVariantIds = [...new Set(items.map((item) => item.variantId).filter((id): id is string => Boolean(id)))];
    const allProducts = orderProductIds.length > 0
        ? await db
            .select({
                id: products.id,
                name: products.name,
                priceMinor: products.priceMinor,
                isActive: products.isActive,
                deletedAt: products.deletedAt,
                discountBps: products.discountBps,
                discountType: products.discountType,
                discountAmountMinor: products.discountAmountMinor,
                customizationSchema: products.customizationSchema,
            })
            .from(products)
            .where(sql`${products.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(orderProductIds)})
            )`)
        : [];
    const allVariants = orderVariantIds.length > 0
        ? await db
            .select()
            .from(productVariants)
            .where(sql`${productVariants.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(orderVariantIds)})
            )`)
        : [];

    const selectedOptionsByVariant = await loadVariantSelectedOptions(
        db,
        allVariants.map((variant) => variant.id),
    );
    // An order editor never needs what a SKU cost (orders.view is not "View product costs").
    const variantsWithOptions = allVariants.map((variant) => ({
        ...withoutSkuCost(presentCatalogPrice(variant, storeDecimalPlaces)),
        selectedOptions: selectedOptionsByVariant.get(variant.id) ?? [],
    }));
    const variantsByProductId = new Map<
        string,
        Array<(typeof variantsWithOptions)[number]>
    >();
    for (const variant of variantsWithOptions) {
        const existing = variantsByProductId.get(variant.productId) ?? [];
        existing.push(variant);
        variantsByProductId.set(variant.productId, existing);
    }

    if (editReadiness.items.allowed) {
        const productById = new Map(allProducts.map((product) => [product.id, product]));
        const variantById = new Map(allVariants.map((variant) => [variant.id, variant]));
        const hasUnavailableOriginalLine = items.some((item) => {
            const product = productById.get(item.productId);
            const variant = item.variantId ? variantById.get(item.variantId) : null;
            return !product
                || !product.isActive
                || Boolean(product.deletedAt)
                || !variant
                || variant.productId !== item.productId
                || Boolean(variant.deletedAt);
        });
        if (hasUnavailableOriginalLine) {
            editReadiness.items = { allowed: false, reason: "unavailable" };
        }
    }

    const productsWithVariants = allProducts.map(({ customizationSchema, ...product }) => {
        const customization = readStoredCustomization(customizationSchema, storeDecimalPlaces);
        return {
            ...presentCatalogPrice(product, storeDecimalPlaces),
            customizationSchema: customization.customization,
            requiresCustomization: customization.requiresCustomization,
            variants: variantsByProductId.get(product.id) ?? [],
        };
    });

    return ok(c, {
        order,
        editReadiness,
        productsWithVariants,
        defaultValues: {
            ...order,
            discountAmount: order.discountAmount || null,
            items: items.map((item) => {
                const line = presentOrderLineFulfilment(item, currencyDecimalPlaces);
                return {
                    orderItemId: item.id,
                    productId: item.productId,
                    variantId: item.variantId,
                    quantity: item.quantity,
                    price: orderAmount(item.unitPriceMinor),
                    fulfillmentType: line.fulfillmentType,
                    properties: line.properties,
                };
            }),
        },
    });
}) as unknown as AdminRouteHandler<typeof getFormDataRoute>);

export { app as adminOrderDetailRoutes };
