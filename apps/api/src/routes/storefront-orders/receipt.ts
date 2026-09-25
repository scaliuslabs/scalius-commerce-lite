// Order lookup OTP, the guest receipt, and the account-owner receipt proof.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { orders, orderItems, media } from "@scalius/database/schema";
import { listOrderDiscountLines } from "@scalius/core/modules/promotions";
import { orderDiscountLineSchema, presentOrderDiscountLines } from "../../schemas/storefront-discounts";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  getCustomerBySession,
  getBuyerOrderTracking,
  getCustomerVisibleBalanceDueMinor,
  issueAccountOwnerReceipt,
  listOrderCodeOptions,
  readCustomerIdentity,
} from "@scalius/core/modules/customers";
import { buyerOrderTrackingSchema } from "../../schemas/order-tracking";
import {
  findOrderByReference,
  ORDER_LOOKUP_NOT_FOUND_MESSAGE,
  sendOrderLookupOtp,
  verifyOrderLookupOtp,
  deleteOrderPaymentRecoveryChallenge,
  getReceiptOrderSupportRequestStateForOrder,
  findOrderConversationId,
  listBuyerOrderFulfilments,
} from "@scalius/core/modules/orders";
import {
  orderMoneyAmounts,
  orderMoneySelection,
  presentOrderLineFulfilment,
  presentOrderPickup,
  presentShippingMethodKind,
} from "@scalius/core/modules/orders/browser";
import {
  buyerOrderFulfilmentSchema,
  orderFulfilmentShape,
  orderLineFulfilmentShape,
} from "../../schemas/order-lines";
import { fromMinor } from "@scalius/shared/money";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import { publishedMediaObjectKey } from "@scalius/core/modules/media";
import { CUSTOMER_AUTH_OTP_CHANNELS } from "@scalius/shared/customer-auth-policy";
import { NotFoundError, RateLimitError, UnauthorizedError, ServiceUnavailableError } from "../../utils/api-error";
import { isWithinRateLimit } from "../../utils/rate-limit";
import { getCredentialEncryptionKey, getCustomerSessionHashKey } from "../../utils/encryption-key";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { ok } from "../../utils/api-response";
import {
  successEnvelope,
  errorResponses,
  serviceUnavailableResponse,
  conflictResponse,
} from "../../schemas/responses";
import { authMiddleware } from "../../middleware/auth";
import { getTrustedClientIp } from "../../utils/client-ip";
import {
  composeOrderLineExtras,
  orderGiftCardTenderSchema,
  orderLineExtrasShape,
  presentOrderGiftCardTenders,
  withOrderLineExtras,
} from "../shared/order-line-extras";
import {
  receiptSupportRequestSchema,
  receiptSupportRequestActionSchema,
  CUSTOMER_SESSION_HEADER,
  getCustomerSessionTokenFromRequest,
} from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";

function getReceiptTokenFromHeader(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const token = c.req.header(RECEIPT_TOKEN_HEADER)?.trim();
  return token || undefined;
}

const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

const orderReceiptSchema = z.object({
  id: z.string(),
  /** Short per-store order number shown as "#1001"; null only for orders placed before numbering. */
  orderNumber: z.number().int().nullable(),
  customerName: z.string(),
  /** The phone the courier calls. The receipt is proof-gated, so the buyer sees their own contact. */
  customerPhone: z.string(),
  customerEmail: z.string().nullable(),
  /** True when the order is saved to a customer account. */
  accountLinked: z.boolean(),
  /** Null when nothing ships (pickup, service-only or digital orders). */
  shippingAddress: z.string().nullable(),
  ...orderFulfilmentShape,
  /** Each handed-over action: a parcel sent, a pickup, a performed service. */
  fulfillments: z.array(buyerOrderFulfilmentSchema),
  /** The order thread, once the buyer or the store has written on it. */
  conversationId: z.string().nullable(),
  totalAmount: z.number(),
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
  /** Each discount the order used: `amount` off the items, `shippingAmount` off delivery. */
  discounts: z.array(orderDiscountLineSchema),
  /** The buyer's order note. */
  notes: z.string().nullable(),
  /** Where the order is: shown when the receipt is opened to track it. */
  tracking: buyerOrderTrackingSchema,
  taxAmountMinor: z.number().int(),
  totalAmountMinor: z.number().int().nullable(),
  taxLabel: z.string().nullable(),
  pricesIncludeTax: z.boolean(),
  city: z.string().nullable(),
  zone: z.string().nullable(),
  area: z.string().nullable(),
  cityName: z.string().nullable(),
  zoneName: z.string().nullable(),
  areaName: z.string().nullable(),
  status: z.string(),
  paymentMethod: z.string().nullable(),
  paymentStatus: z.string(),
  paidAmount: z.number(),
  balanceDue: z.number(),
  /** Gift cards still paying for the order, in commit order (released or refunded ones are left out). */
  giftCardTenders: z.array(orderGiftCardTenderSchema),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  items: z.array(z.object({
    id: z.string(),
    productId: z.string(),
    variantId: z.string().nullable(),
    quantity: z.number(),
    price: z.number(),
    productName: z.string().nullable(),
    productImage: z.string().nullable(),
    variantLabel: z.string().nullable(),
    unitPriceMinor: z.number().int().nullable(),
    lineSubtotalMinor: z.number().int().nullable(),
    discountAmountMinor: z.number().int().nullable(),
    taxableAmountMinor: z.number().int().nullable(),
    taxAmountMinor: z.number().int(),
    ...orderLineFulfilmentShape,
    ...orderLineExtrasShape,
  })),
  supportRequests: z.array(receiptSupportRequestSchema),
  supportRequestActions: z.array(receiptSupportRequestActionSchema),
  supportRequestIntro: z.string(),
});

// ─── Track your order (public lookup) ──────────────────────────────────────
// The order number alone opens a status-only view: no address, phone, email
// or surname. Order numbers are guessable, so every miss is the same 404 and
// each buyer IP gets a strict budget. Full details, requests, downloads and
// messages need a code through a channel the merchant chose, sent to a
// contact saved on the order.

const orderLookupReferenceSchema = z.string().trim().min(1).max(64)
  .openapi({ description: 'Order number ("#1001") or order id' });

const orderCodeOptionSchema = z.object({
  channel: z.enum(CUSTOMER_AUTH_OTP_CHANNELS),
  destination: z.string().openapi({ description: 'Masked contact on the order ("01•••••678")' }),
});

const orderLookupStatusSchema = z.object({
  orderNumber: z.number().int().nullable(),
  /** First name only; nothing else that identifies the buyer. */
  firstName: z.string().nullable(),
  status: z.string(),
  paymentStatus: z.string(),
  createdAt: z.string().nullable(),
  requiresShipping: z.boolean(),
  shippingMethodKind: z.string().nullable(),
  shippingMethodName: z.string().nullable(),
  currencyCode: z.string().nullable(),
  currencyDecimalPlaces: z.number().int().nullable(),
  subtotal: z.number(),
  shipping: z.number(),
  discount: z.number(),
  tax: z.number(),
  total: z.number(),
  paid: z.number(),
  balanceDue: z.number(),
  items: z.array(z.object({
    productName: z.string().nullable(),
    variantLabel: z.string().nullable(),
    quantity: z.number().int(),
    productImage: z.string().nullable(),
  })),
  tracking: buyerOrderTrackingSchema,
  /** Where a code to open the full order can go: the store's chosen channels that reach this order. */
  codeOptions: z.array(orderCodeOptionSchema),
});

async function enforceOrderLookupRateLimit(env: Env, ip: string): Promise<void> {
  const [strict, standard] = await Promise.all([
    isWithinRateLimit(env, "RL_STRICT", "order-lookup-ip", ip),
    isWithinRateLimit(env, "RL_STANDARD", "order-lookup-ip-minute", ip),
  ]);
  if (!strict || !standard) {
    throw new RateLimitError("Too many order lookups.", 60);
  }
}

function firstNameOf(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 40) : null;
}

const orderLookupStatusRoute = createRoute({
  method: "post",
  path: "/lookup/status",
  tags: ["Orders"],
  summary: "Status-only view of an order by its number (no personal data)",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ reference: orderLookupReferenceSchema }).strict() } },
    },
  },
  responses: {
    200: {
      description: "Where the order is",
      content: { "application/json": { schema: successEnvelope(z.object({ order: orderLookupStatusSchema })) } },
    },
    ...errorResponses,
  },
});

// Storefront-server only: the storefront forwards the buyer's IP for the limit.
app.use("/lookup/status", authMiddleware);
app.openapi(orderLookupStatusRoute, async (c) => {
  const db = c.get("db");
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  await enforceOrderLookupRateLimit(c.env, getTrustedClientIp(c));

  const found = await findOrderByReference(db, c.req.valid("json").reference);
  if (!found) throw new NotFoundError(ORDER_LOOKUP_NOT_FOUND_MESSAGE);
  const order = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerName: orders.customerName,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      requiresShipping: orders.requiresShipping,
      shippingMethodKind: orders.shippingMethodKind,
      shippingMethodName: orders.shippingMethodName,
      currencyCode: orders.currencyCode,
      subtotalAmountMinor: orders.subtotalAmountMinor,
      taxAmountMinor: orders.taxAmountMinor,
      ...orderMoneySelection(orders),
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
    })
    .from(orders)
    .where(eq(orders.id, found.id))
    .get();
  if (!order) throw new NotFoundError(ORDER_LOOKUP_NOT_FOUND_MESSAGE);

  const [items, tracking, identity] = await Promise.all([
    db
      .select({
        productName: orderItems.productName,
        variantLabel: orderItems.variantLabel,
        quantity: orderItems.quantity,
        productImageObjectKey: publishedMediaObjectKey(),
        productImageStatus: media.status,
      })
      .from(orderItems)
      .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
      .where(eq(orderItems.orderId, order.id)),
    getBuyerOrderTracking(db, order),
    readCustomerIdentity(db),
  ]);
  const money = orderMoneyAmounts(order);
  const places = order.currencyDecimalPlaces;
  return ok(c, {
    order: {
      orderNumber: order.orderNumber ?? null,
      firstName: firstNameOf(order.customerName),
      status: order.status,
      paymentStatus: order.paymentStatus,
      createdAt: unixToDate(order.createdAt)?.toISOString() || null,
      requiresShipping: order.requiresShipping,
      shippingMethodKind: presentShippingMethodKind(order.shippingMethodKind),
      shippingMethodName: order.shippingMethodName,
      currencyCode: order.currencyCode,
      currencyDecimalPlaces: places,
      subtotal: fromMinor(order.subtotalAmountMinor ?? 0, places),
      shipping: money.shippingCharge,
      discount: money.discountAmount,
      tax: fromMinor(order.taxAmountMinor, places),
      total: money.totalAmount,
      paid: money.paidAmount,
      balanceDue: money.balanceDue,
      items: items.map((item) => ({
        productName: item.productName,
        variantLabel: item.variantLabel,
        quantity: item.quantity,
        productImage:
          item.productImageObjectKey && (item.productImageStatus === "ready" || item.productImageStatus === "trashed")
            ? getCurrentPublicMediaUrl(item.productImageObjectKey)
            : null,
      })),
      // Request and refund notes can carry the buyer's words (labels only),
      // and entry ids carry the internal order id.
      tracking: {
        ...tracking,
        timeline: tracking.timeline.map((entry, index) => ({ ...entry, id: `t${index}`, details: null })),
      },
      codeOptions: listOrderCodeOptions(identity, found),
    },
  });
});

const sendOrderLookupOtpRoute = createRoute({
  method: "post",
  path: "/lookup/send-otp",
  tags: ["Orders"],
  summary: "Send a code to the contact saved on an order, through a channel the store chose",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            reference: orderLookupReferenceSchema,
            channel: z.enum(CUSTOMER_AUTH_OTP_CHANNELS).optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Code sent; says where",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            message: z.string(),
            destination: z.string(),
            channel: z.enum(CUSTOMER_AUTH_OTP_CHANNELS),
            resendAfterSeconds: z.number().int(),
          })),
        },
      },
    },
    409: conflictResponse,
    503: serviceUnavailableResponse,
    ...errorResponses,
  },
});

app.openapi(sendOrderLookupOtpRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const env = c.env as unknown as Record<string, unknown>;
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");

  const result = await sendOrderLookupOtp(db, {
    reference: body.reference,
    channel: body.channel,
    ip: getTrustedClientIp(c),
    emailEnv: env,
    encryptionKey: getCredentialEncryptionKey(env),
    credentialEncryptionKey: getCredentialEncryptionKey(env),
  });
  try {
    await c.env.JOBS_QUEUE.send(result.queuePayload);
  } catch (error) {
    if (result.challengeKey && result.deliveryKey) {
      await deleteOrderPaymentRecoveryChallenge(db, {
        challengeKey: result.challengeKey,
        deliveryKey: result.deliveryKey,
      }).catch(() => undefined);
    }
    console.error("[Orders] Failed to enqueue order lookup code:", error instanceof Error ? error.name : typeof error);
    throw new ServiceUnavailableError("We couldn't send the code. Please try again.");
  }
  return ok(c, {
    message: result.message,
    destination: result.destination,
    channel: result.channel,
    resendAfterSeconds: result.resendAfterSeconds,
  });
});

const verifyOrderLookupOtpRoute = createRoute({
  method: "post",
  path: "/lookup/verify-otp",
  tags: ["Orders"],
  summary: "Verify an order lookup code and issue a private receipt proof",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ reference: orderLookupReferenceSchema, code: z.string().trim().min(4).max(12) }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Verified",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orderId: z.string(),
            receiptToken: z.string(),
            expiresAt: z.number(),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.use("/lookup/verify-otp", authMiddleware);
app.openapi(verifyOrderLookupOtpRoute, async (c) => {
  const body = c.req.valid("json");
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  const result = await verifyOrderLookupOtp(c.get("db"), {
    reference: body.reference,
    code: body.code,
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  return ok(c, result);
});

const getOrderReceiptRoute = createRoute({
  method: "get",
  path: "/receipt/{id}",
  tags: ["Orders"],
  summary: "Get minimal order receipt by ID and receipt token",
  request: {
    params: z.object({
      id: z.string(),
    }),
    headers: z.object({
      [RECEIPT_TOKEN_HEADER]: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Minimal order receipt",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ order: orderReceiptSchema })),
        },
      },
    },
    404: errorResponses[404],
  },
});

app.openapi(getOrderReceiptRoute, async (c) => {
  const db = c.get("db");
  const id = c.req.valid("param").id;
  const token = getReceiptTokenFromHeader(c);

  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  await validateReceiptToken(c.env.CACHE, id, token, db);

  const order = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
      shippingAddress: orders.shippingAddress,
      ...orderMoneySelection(orders),
      currencyCode: orders.currencyCode,
      subtotalAmountMinor: orders.subtotalAmountMinor,
      shippingMethodId: orders.shippingMethodId,
      shippingMethodName: orders.shippingMethodName,
      shippingMethodDescription: orders.shippingMethodDescription,
      shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
      shippingFeeWaived: orders.shippingFeeWaived,
      shippingMethodKind: orders.shippingMethodKind,
      pickupAddress: orders.pickupAddress,
      pickupHours: orders.pickupHours,
      pickupReadyAt: orders.pickupReadyAt,
      requiresShipping: orders.requiresShipping,
      notes: orders.notes,
      taxAmountMinor: orders.taxAmountMinor,
      taxLabel: orders.taxLabel,
      pricesIncludeTax: orders.pricesIncludeTax,
      city: orders.city,
      zone: orders.zone,
      area: orders.area,
      cityName: orders.cityName,
      zoneName: orders.zoneName,
      areaName: orders.areaName,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      fulfillmentStatus: orders.fulfillmentStatus,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`
    })
    .from(orders)
    .where(and(eq(orders.id, id), isNull(orders.deletedAt)))
    .get();

  if (!order) {
    throw new NotFoundError("Order receipt not found");
  }

  const [items, supportState, discountLines, tracking] = await Promise.all([
    db
      .select({
        id: orderItems.id,
        productId: orderItems.productId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        productName: orderItems.productName,
        productImageObjectKey: publishedMediaObjectKey(),
        productImageStatus: media.status,
        variantLabel: orderItems.variantLabel,
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
      .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
      .where(eq(orderItems.orderId, id)),
    getReceiptOrderSupportRequestStateForOrder(db, order),
    listOrderDiscountLines(db, id),
    getBuyerOrderTracking(db, order),
  ]);
  // Ledger and thread reads come after the first wave: at most six D1
  // connections per invocation.
  const [fulfillments, conversationId] = await Promise.all([
    listBuyerOrderFulfilments(db, id),
    findOrderConversationId(db, id),
  ]);
  const lineExtras = await composeOrderLineExtras(db, {
    orderId: id,
    orderItemIds: items.map((item) => item.id),
    audience: "buyer",
    currencyDecimalPlaces: order.currencyDecimalPlaces,
  });
  const giftCardTenders = order.paidAmountMinor > 0
    ? await presentOrderGiftCardTenders(db, id, order.currencyDecimalPlaces)
    : [];

  const money = orderMoneyAmounts(order);
  return ok(c, {
    order: {
      id: order.id,
      orderNumber: order.orderNumber ?? null,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: order.customerEmail,
      accountLinked: order.accountOwnerCustomerId !== null,
      shippingAddress: order.shippingAddress,
      requiresShipping: order.requiresShipping,
      shippingMethodKind: presentShippingMethodKind(order.shippingMethodKind),
      pickup: presentOrderPickup(order),
      fulfillments,
      conversationId,
      totalAmount: money.totalAmount,
      shippingCharge: money.shippingCharge,
      discountAmount: money.discountAmount,
      currencyCode: order.currencyCode,
      currencyDecimalPlaces: order.currencyDecimalPlaces,
      subtotalAmountMinor: order.subtotalAmountMinor,
      shippingAmountMinor: order.shippingAmountMinor,
      shippingMethodId: order.shippingMethodId,
      shippingMethodName: order.shippingMethodName,
      shippingMethodDescription: order.shippingMethodDescription,
      shippingMethodBaseAmountMinor: order.shippingMethodBaseAmountMinor,
      shippingFeeWaived: order.shippingFeeWaived,
      discountAmountMinor: order.discountAmountMinor,
      discounts: presentOrderDiscountLines(discountLines, order.currencyDecimalPlaces),
      notes: order.notes?.trim() || null,
      tracking,
      taxAmountMinor: order.taxAmountMinor,
      totalAmountMinor: order.totalAmountMinor,
      taxLabel: order.taxLabel,
      pricesIncludeTax: order.pricesIncludeTax,
      city: order.city,
      zone: order.zone,
      area: order.area,
      cityName: order.cityName,
      zoneName: order.zoneName,
      areaName: order.areaName,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      paidAmount: money.paidAmount,
      balanceDue: fromMinor(getCustomerVisibleBalanceDueMinor(order), order.currencyDecimalPlaces),
      giftCardTenders,
      createdAt: unixToDate(order.createdAt)?.toISOString() || null,
      updatedAt: unixToDate(order.updatedAt)?.toISOString() || null,
      items: items.map(({
        productImageObjectKey,
        productImageStatus,
        fulfillmentType,
        fulfilledQuantity,
        properties,
        propertiesPriceMinor,
        baseUnitPriceMinor,
        ...item
      }) => withOrderLineExtras({
        ...item,
        ...presentOrderLineFulfilment({
          fulfillmentType,
          fulfilledQuantity,
          properties,
          propertiesPriceMinor,
          baseUnitPriceMinor,
        }, order.currencyDecimalPlaces),
        price: fromMinor(item.unitPriceMinor, order.currencyDecimalPlaces),
        productImage:
          productImageObjectKey &&
          (productImageStatus === "ready" || productImageStatus === "trashed")
            ? getCurrentPublicMediaUrl(productImageObjectKey)
            : null,
      }, lineExtras)),
      supportRequests: supportState.supportRequests,
      supportRequestActions: supportState.supportRequestActions,
      supportRequestIntro: supportState.supportRequestIntro,
    },
  });
});

const createOwnerReceiptProofRoute = createRoute({
  method: "post",
  path: "/receipt/{id}/owner-proof",
  tags: ["Orders"],
  summary: "Issue a private receipt proof to the signed-in account that owns the order",
  request: {
    params: z.object({ id: z.string().trim().min(1).max(128) }),
    headers: z.object({ [CUSTOMER_SESSION_HEADER]: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Receipt proof for the account owner",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orderId: z.string(),
            receiptToken: z.string(),
            expiresAt: z.number(),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

// Storefront-server only (service JWT): the storefront keeps the proof in its
// httpOnly receipt cookie. Ownership is the account order page's rule.
app.use("/receipt/:id/owner-proof", authMiddleware);
app.openapi(createOwnerReceiptProofRoute, async (c) => {
  const db = c.get("db");
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  const sessionToken = getCustomerSessionTokenFromRequest(c);
  const session = sessionToken
    ? await getCustomerBySession(db, sessionToken, getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>))
    : null;
  if (!session?.customerId) throw new UnauthorizedError("Sign in to open this receipt.");

  return ok(c, await issueAccountOwnerReceipt(db, {
    customerId: session.customerId,
    orderId: c.req.valid("param").id,
  }));
});

export { app as receiptRoutes };
