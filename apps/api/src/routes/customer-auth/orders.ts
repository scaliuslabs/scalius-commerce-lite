// One signed-in customer order: claim a receipt, detail, support requests and payment sessions.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getCustomerOrderDetailForOrder,
    getCustomerOwnedOrderForDetail,
    getCustomerPaymentSessionOrderForDetail,
    claimGuestOrderToAccount,
} from "@scalius/core/modules/customers";
import { listOrderDiscountLines } from "@scalius/core/modules/promotions";
import { orderDiscountLineSchema, presentOrderDiscountLines } from "../../schemas/storefront-discounts";
import { buyerOrderProgressSchema, buyerOrderTimelineSchema } from "../../schemas/order-tracking";
import {
    CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES,
    getOrderSupportRequestStatusLabel,
} from "@scalius/core/modules/orders";
import { createCustomerOrderSupportRequest } from "@scalius/core/modules/conversations";
import { enforceBuyerWriteLimits } from "../../utils/conversation-http";
import { UnauthorizedError } from "../../utils/api-error";
import {
    conflictResponse,
    errorResponses,
    serviceUnavailableResponse,
    successEnvelope,
} from "../../schemas/responses";
import { nullableTimestampSchema } from "../../schemas/timestamps";
import { created, ok } from "../../utils/api-response";
import {
    createCustomerAccountPaymentSession,
    isPaymentSessionProcessingResult,
    resolveCustomerPaymentSessionRecovery,
} from "../payment/payment-session-create";
import {
    acceptedPaymentSessionProcessing,
    paymentSessionProcessingResponse,
} from "../payment/payment-session-response";
import { enqueueOrderSupportRequestNotificationForOrder } from "../../utils/order-notification-queue";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { setPrivateNoStoreHeaders, requireCustomerSession } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const customerPaymentRecoverySchema = z.object({
  eligible: z.boolean(),
  gateway: z.string().nullable(),
  paymentType: z.enum(["full", "deposit", "balance"]).nullable(),
  amountDue: z.number(),
  label: z.string().nullable(),
  reason: z.string().nullable(),
  blockType: z.enum(["validation", "unavailable"]).optional(),
  requiresCardForm: z.boolean(),
  hostedRedirect: z.boolean(),
});

const claimCustomerOrderReceiptRoute = createRoute({
  method: "post",
  path: "/orders/{id}/claim-receipt",
  tags: ["Customer Auth"],
  summary: "Save a receipt-proven guest order to the authenticated customer account",
  request: {
    params: z.object({ id: z.string().trim().min(1).max(128) }),
    headers: z.object({
      "x-receipt-token": z.string().optional(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({}).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Order saved to the authenticated customer account",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orderId: z.string(),
            alreadyClaimed: z.boolean(),
          })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(claimCustomerOrderReceiptRoute, async (c) => {
  setPrivateNoStoreHeaders(c);
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) {
    throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  }

  const orderId = c.req.valid("param").id;
  const receiptToken = c.req.valid("header")["x-receipt-token"];
  const db = c.get("db");
  await validateReceiptToken(c.env.CACHE, orderId, receiptToken, db);
  const result = await claimGuestOrderToAccount(db, {
    orderId,
    customerId: session.customerId,
    customerEmail: session.email,
    customerPhone: session.phone,
  });

  return ok(c, {
    orderId: result.orderId,
    alreadyClaimed: result.alreadyClaimed,
  });
});

const customerRefundAttemptSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  amount: z.number(),
  currency: z.string(),
  gateway: z.string(),
  status: z.string(),
  providerStatus: z.string().nullable(),
  active: z.boolean(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  message: z.string(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
  nextProbeAt: nullableTimestampSchema,
  lastProbeAt: nullableTimestampSchema,
  refundedAt: nullableTimestampSchema,
  failedAt: nullableTimestampSchema,
});

const customerActiveRefundOperationSchema = z.object({
  active: z.literal(true),
  status: z.string(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  message: z.string(),
  amount: z.number(),
  currency: z.string(),
  gateway: z.string(),
  attemptCount: z.number(),
  nextProbeAt: nullableTimestampSchema,
  lastProbeAt: nullableTimestampSchema,
  providerStatus: z.string().nullable(),
});

const customerOrderSupportRequestTypeSchema = z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES);

const customerOrderSupportRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string().nullable(),
  type: customerOrderSupportRequestTypeSchema,
  status: z.string(),
  active: z.boolean(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  actionLabel: z.string(),
  reason: z.string(),
  message: z.string().nullable(),
  submittedAt: nullableTimestampSchema,
  resolvedAt: nullableTimestampSchema,
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
});

const customerOrderSupportRequestActionSchema = z.object({
  type: customerOrderSupportRequestTypeSchema,
  label: z.string(),
  description: z.string(),
  eligible: z.boolean(),
  disabledReason: z.string().nullable(),
});

const customerOrderDetailSchema = z.object({
  order: z.object({
    id: z.string(),
    orderNumber: z.number().int().nullable(),
    invoiceNumber: z.number().nullable(),
    status: z.string(),
    totalAmount: z.number(),
    paidAmount: z.number(),
    balanceDue: z.number(),
    shippingCharge: z.number(),
    discountAmount: z.number().nullable(),
    currencyCode: z.string().nullable(),
    currencyDecimalPlaces: z.number().int().nullable(),
    subtotalAmountMinor: z.number().int().nullable(),
    shippingAmountMinor: z.number().int().nullable(),
    shippingMethodId: z.string().nullable(),
    shippingMethodName: z.string().nullable(),
    shippingMethodDescription: z.string().nullable(),
    shippingMethodBaseAmountMinor: z.number().int().nullable(),
    shippingFeeWaived: z.boolean().nullable(),
    discountAmountMinor: z.number().int().nullable(),
    taxAmountMinor: z.number().int(),
    totalAmountMinor: z.number().int().nullable(),
    taxLabel: z.string().nullable(),
    pricesIncludeTax: z.boolean(),
    paymentStatus: z.string(),
    paymentMethod: z.string(),
    fulfillmentStatus: z.string(),
    expectedDelivery: z.string().nullable(),
    shippingAddress: z.string(),
    city: z.string(),
    zone: z.string(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    notes: z.string().nullable(),
    statusLabel: z.string(),
    customerName: z.string(),
    customerPhone: z.string(),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
  }).passthrough(),
  items: z.array(z.object({
    id: z.string(),
    productId: z.string(),
    variantId: z.string().nullable(),
    quantity: z.number(),
    price: z.number(),
    productName: z.string().nullable(),
    productSlug: z.string().nullable(),
    productImage: z.string().nullable(),
    variantLabel: z.string().nullable(),
    unitPrice: z.number(),
    lineTotal: z.number(),
    unitPriceMinor: z.number().int().nullable(),
    lineSubtotalMinor: z.number().int().nullable(),
    discountAmountMinor: z.number().int().nullable(),
    taxableAmountMinor: z.number().int().nullable(),
    taxAmountMinor: z.number().int(),
    fulfillmentStatus: z.string(),
    createdAt: nullableTimestampSchema,
  }).passthrough()),
  shipments: z.array(z.object({
    id: z.string(),
    providerType: z.string(),
    providerName: z.string().nullable(),
    status: z.string(),
    rawStatus: z.string().nullable(),
    trackingId: z.string().nullable(),
    trackingUrl: z.string().nullable(),
    courierName: z.string().nullable(),
    note: z.string().nullable(),
    shipmentAmount: z.number().nullable(),
    isFinalShipment: z.boolean(),
    statusLabel: z.string(),
    lastChecked: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
    createdAt: nullableTimestampSchema,
  }).passthrough()),
  payments: z.array(z.object({
    id: z.string(),
    amount: z.number(),
    currency: z.string(),
    paymentMethod: z.string(),
    paymentType: z.string(),
    status: z.string(),
    codReceiptUrl: z.string().nullable(),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
  }).passthrough()),
  refundAttempts: z.array(customerRefundAttemptSchema),
  activeRefundOperation: customerActiveRefundOperationSchema.nullable(),
  supportRequests: z.array(customerOrderSupportRequestSchema),
  supportRequestActions: z.array(customerOrderSupportRequestActionSchema),
  supportRequestIntro: z.string(),
  paymentPlan: z.object({
    totalAmount: z.number(),
    depositAmount: z.number(),
    balanceDue: z.number(),
    balanceDueDate: z.string().nullable(),
    status: z.string(),
    depositPaidAt: nullableTimestampSchema,
    balancePaidAt: nullableTimestampSchema,
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
  }).passthrough().nullable(),
  cod: z.object({
    codStatus: z.string(),
    deliveryAttempts: z.number(),
    failureReason: z.string().nullable(),
    collectedAmount: z.number().nullable(),
    receiptUrl: z.string().nullable(),
    lastAttemptAt: nullableTimestampSchema,
    collectedAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
  }).passthrough().nullable(),
  progress: buyerOrderProgressSchema,
  timeline: buyerOrderTimelineSchema,
  /** Each discount the order used: `amount` off the items, `shippingAmount` off delivery. */
  discounts: z.array(orderDiscountLineSchema),
  paymentRecovery: customerPaymentRecoverySchema,
});

const getCustomerOrderDetailRoute = createRoute({
  method: "get",
  path: "/orders/{id}",
  tags: ["Customer Auth"],
  summary: "Get one authenticated customer order with timeline",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Customer order detail",
      content: {
        "application/json": {
          schema: successEnvelope(customerOrderDetailSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getCustomerOrderDetailRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const { session } = await requireCustomerSession(c);
  if (!session.customerId) {
    throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  }

  const orderId = c.req.valid("param").id;
  const order = await getCustomerOwnedOrderForDetail(c.get("db"), session.customerId, orderId);
  const [detail, discountLines, paymentRecovery] = await Promise.all([
    getCustomerOrderDetailForOrder(c.get("db"), order),
    listOrderDiscountLines(c.get("db"), orderId),
    resolveCustomerPaymentSessionRecovery(c, {
      orderId,
      expectedCustomerId: session.customerId,
      order: getCustomerPaymentSessionOrderForDetail(order),
    }),
  ]);

  return ok(c, {
    ...detail,
    discounts: presentOrderDiscountLines(discountLines, order.currencyDecimalPlaces),
    paymentRecovery,
  });
});

const createCustomerOrderSupportRequestRoute = createRoute({
  method: "post",
  path: "/orders/{id}/support-requests",
  tags: ["Customer Auth"],
  summary: "Create an authenticated customer support request for an owned order",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            type: customerOrderSupportRequestTypeSchema,
            reason: z.string().trim().min(3).max(500),
            message: z.string().trim().max(1000).nullable().optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Customer support request created",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            request: customerOrderSupportRequestSchema,
            supportRequests: z.array(customerOrderSupportRequestSchema),
            supportRequestActions: z.array(customerOrderSupportRequestActionSchema),
            supportRequestIntro: z.string(),
            conversationId: z.string(),
          })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createCustomerOrderSupportRequestRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const { session } = await requireCustomerSession(c);
  if (!session.customerId) {
    throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  }

  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  await enforceBuyerWriteLimits(c, "support-request", { customerId: session.customerId });
  const result = await createCustomerOrderSupportRequest(db, session.customerId, orderId, body);
  await enqueueOrderSupportRequestNotificationForOrder({
    db,
    queue: c.env.JOBS_QUEUE,
    orderId,
    requestId: result.request.id,
    notificationType: "support_request_submitted",
    source: "customer-support-request",
    status: result.request.status,
    data: {
      supportRequestType: result.request.type,
      supportRequestTypeLabel: result.request.label,
      supportRequestStatus: result.request.status,
      supportRequestStatusLabel: getOrderSupportRequestStatusLabel(result.request.status),
    },
  });

  return created(c, result);
});

/** Card gateways return `stripe` (browser confirmation); hosted gateways return `hosted` (redirect). */
const customerPaymentSessionSchema = z.object({
  gateway: z.string(),
  paymentType: z.enum(["full", "deposit", "balance"]),
  amount: z.number(),
  currency: z.string(),
  stripe: z.object({
    clientSecret: z.string().optional(),
    paymentIntentId: z.string().optional(),
    publishableKey: z.string(),
    amount: z.number(),
    currency: z.string(),
  }).optional(),
  hosted: z.object({
    gatewayUrl: z.string().optional(),
    sessionKey: z.string().optional(),
  }).optional(),
});

const createCustomerOrderPaymentSessionRoute = createRoute({
  method: "post",
  path: "/orders/{id}/payment-session",
  tags: ["Customer Auth"],
  summary: "Create an authenticated customer payment session for an owned order",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            gateway: z.string().max(64).optional(),
            replaceExistingAttempt: z.boolean().optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Customer payment session created",
      content: {
        "application/json": {
          schema: successEnvelope(customerPaymentSessionSchema),
        },
      },
    },
    202: paymentSessionProcessingResponse,
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createCustomerOrderPaymentSessionRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const { session } = await requireCustomerSession(c);
  if (!session.customerId) {
    throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  }

  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  const result = await createCustomerAccountPaymentSession(c, {
    orderId,
    customerId: session.customerId,
    ...(body.gateway ? { gateway: body.gateway } : {}),
    ...(body.replaceExistingAttempt !== undefined
      ? { replaceExistingAttempt: body.replaceExistingAttempt }
      : {}),
  });
  if (isPaymentSessionProcessingResult(result)) {
    return acceptedPaymentSessionProcessing(c, result);
  }

  return ok(c, result);
});

export { app as customerOrderRoutes };
