import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";

import {
  orders,
  orderItems,
  productVariants,
  products,
  productImages,
  PaymentMethod,
  InventoryPool,
  siteSettings
} from "@scalius/database/schema";
import { isDiscountValid, calculateDiscountAmount } from "@scalius/core/modules/discounts/discounts.eligibility";
import { eq, sql } from "drizzle-orm";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { getCustomerBySession, getSessionCookie } from "@scalius/core/modules/customers/customer-auth.service";
import { FRESH_GATEWAY_SETTINGS_READ_OPTIONS, getActivePaymentMethods } from "@scalius/core/modules/payments/gateway-settings";
import { isCheckoutGatewayUsableForFlow, type CheckoutPaymentMethodId } from "@scalius/core/modules/settings/checkout-flow";
import {
  commitStorefrontOrderPayload,
  createStorefrontOrder,
  runStorefrontOrderPostCommitSideEffects,
} from "@scalius/core/modules/orders";
import { invalidateProductAvailabilityCaches } from "../utils/cache-invalidation";
import { NotFoundError, ValidationError, RateLimitError, UnauthorizedError, ServiceUnavailableError } from "../utils/api-error";
import { getEncryptionKey } from "../utils/encryption-key";
import { rateLimit, getClientIp } from "@scalius/shared/rate-limit";
import {
  RECEIPT_TOKEN_PREFIX,
  RECEIPT_TOKEN_TTL_SECONDS,
  validateReceiptToken,
} from "../utils/order-receipt-token";

import { created, ok } from "../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const CUSTOMER_SESSION_HEADER = "X-Customer-Session";
const PAYMENT_METHOD_LABELS: Record<CheckoutPaymentMethodId, string> = {
  cod: "Cash on delivery",
  stripe: "Stripe",
  sslcommerz: "SSLCommerz",
  polar: "Polar",
};

function getOptionalExecutionContext(c: { executionCtx?: ExecutionContext }): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

async function invalidateStorefrontOrderAvailabilityCaches(
  db: Database,
  env: Env,
  orderId: string,
  executionCtx: ExecutionContext | undefined,
): Promise<void> {
  try {
    await invalidateProductAvailabilityCaches(
      db,
      { orderIds: [orderId] },
      { env, executionCtx },
    );
  } catch (error) {
    console.error("[Orders] Failed to invalidate product availability caches after order commit:", {
      orderId,
      error,
    });
  }
}

function getCustomerSessionTokenFromRequest(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const explicitSessionToken = c.req.header(CUSTOMER_SESSION_HEADER)?.trim();
  if (explicitSessionToken) return explicitSessionToken;

  return getSessionCookie(c.req.header("Cookie") ?? null);
}

async function assertCheckoutOrderPolicy(
  c: {
    env: Env;
    get: (key: "db") => Database;
    req: { header: (name: string) => string | undefined };
  },
  customerPhone: string,
  paymentMethod: CheckoutPaymentMethodId,
): Promise<void> {
  const db = c.get("db");
  const [checkoutSettings] = await db
    .select({
      guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
      checkoutMode: siteSettings.checkoutMode,
      partialPaymentEnabled: siteSettings.partialPaymentEnabled,
      partialPaymentAmount: siteSettings.partialPaymentAmount,
    })
    .from(siteSettings)
    .limit(1);

  let activePaymentMethods: Awaited<ReturnType<typeof getActivePaymentMethods>>;
  try {
    activePaymentMethods = await getActivePaymentMethods(
      db,
      c.env.CACHE,
      getEncryptionKey(c.env as Record<string, unknown>),
      FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
    );
  } catch (error) {
    console.warn("[Orders] Failed to read active payment methods before checkout:", error);
    throw new ServiceUnavailableError("Checkout payment settings are temporarily unavailable. Please try again shortly.");
  }

  if (!activePaymentMethods.enabledMethods.includes(paymentMethod)) {
    throw new ServiceUnavailableError(`${PAYMENT_METHOD_LABELS[paymentMethod]} is not enabled for checkout.`);
  }

  if (!isCheckoutGatewayUsableForFlow({
    gatewayId: paymentMethod,
    checkoutMode: checkoutSettings?.checkoutMode,
    partialPaymentEnabled: checkoutSettings?.partialPaymentEnabled ?? false,
    partialPaymentAmount: checkoutSettings?.partialPaymentAmount ?? 0,
  })) {
    throw new ValidationError(`${PAYMENT_METHOD_LABELS[paymentMethod]} is not available for the current checkout settings.`);
  }

  if (checkoutSettings?.guestCheckoutEnabled ?? true) {
    return;
  }

  if (!c.env.CACHE) {
    throw new ServiceUnavailableError("Checkout sign-in is temporarily unavailable. Please try again shortly.");
  }

  const sessionToken = getCustomerSessionTokenFromRequest(c);
  if (!sessionToken) {
    throw new UnauthorizedError("Please sign in before checkout.");
  }

  const session = await getCustomerBySession(c.env.CACHE, sessionToken);
  if (!session?.customerId) {
    throw new UnauthorizedError("Please sign in before checkout.");
  }

  if (!session.phone || session.phone !== customerPhone) {
    throw new ValidationError("Checkout phone must match the signed-in customer phone.");
  }
}

const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// ─── GET /status/:token ──────────────────────────────────────────────────────

const getOrderStatusRoute = createRoute({
  method: "get",
  path: "/status/{token}",
  tags: ["Orders"],
  summary: "Check order processing status by checkout token",
  request: {
    params: z.object({
      token: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Order status",
      content: { "application/json": { schema: successEnvelope(z.object({
        status: z.string(),
        orderId: z.string().optional(),
      }).passthrough()) } },
    },
    202: {
      description: "Order is processing",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: z.object({ status: z.string(), message: z.string() }),
      }) } },
    },
    400: errorResponses[400],
  }
});

app.openapi(getOrderStatusRoute, async (c) => {
  const token = c.req.valid("param").token;
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  if (!token || !token.startsWith("chk_")) {
    throw new ValidationError("Invalid checkout token");
  }

  if (!c.env.CACHE) {
    console.warn("[Orders] Polling endpoint hit but CACHE KV is not bound!");
    return ok(c, { status: "processing" });
  }

  const kvKey = `checkout_status:${token}`;
  const statusStr = await c.env.CACHE.get(kvKey);

  if (!statusStr) {
    return c.json({ success: true, data: { status: "processing", message: "Order is waiting in queue." } }, 202);
  }

  const statusData = JSON.parse(statusStr);

  if (statusData.status === "processing" && statusData.orderId) {
    const db = c.get("db");
    const orderExists = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, statusData.orderId))
      .limit(1);

    if (orderExists.length > 0) {
      return ok(c, {
        status: "completed",
        orderId: statusData.orderId,
        receiptToken: token,
      });
    }
  }

  return ok(c, statusData);
});

// ─── GET /receipt/:id ───────────────────────────────────────────────────────

const orderReceiptSchema = z.object({
  id: z.string(),
  customerName: z.string(),
  shippingAddress: z.string(),
  totalAmount: z.number(),
  shippingCharge: z.number(),
  discountAmount: z.number().nullable(),
  city: z.string(),
  zone: z.string(),
  area: z.string().nullable(),
  cityName: z.string().nullable(),
  zoneName: z.string().nullable(),
  areaName: z.string().nullable(),
  status: z.string(),
  paymentMethod: z.string().nullable(),
  paymentStatus: z.string(),
  paidAmount: z.number(),
  balanceDue: z.number(),
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
    variantSize: z.string().nullable(),
    variantColor: z.string().nullable(),
  })),
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
    query: z.object({
      token: z.string().optional(),
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
  const token = c.req.valid("query").token;

  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  await validateReceiptToken(c.env.CACHE, id, token);

  const order = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      shippingAddress: orders.shippingAddress,
      totalAmount: orders.totalAmount,
      shippingCharge: orders.shippingCharge,
      discountAmount: orders.discountAmount,
      city: orders.city,
      zone: orders.zone,
      area: orders.area,
      cityName: orders.cityName,
      zoneName: orders.zoneName,
      areaName: orders.areaName,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`
    })
    .from(orders)
    .where(eq(orders.id, id))
    .get();

  if (!order) {
    throw new NotFoundError("Order receipt not found");
  }

  const items = await db
    .select({
      id: orderItems.id,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      price: orderItems.price,
      productName: products.name,
      productImage: sql<string>`(
        SELECT ${productImages.url}
        FROM ${productImages}
        WHERE ${productImages.productId} = ${products.id}
        AND ${productImages.isPrimary} = 1
        LIMIT 1
      )`.as("productImage"),
      variantSize: productVariants.size,
      variantColor: productVariants.color
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
    .where(eq(orderItems.orderId, id));

  return ok(c, {
    order: {
      ...order,
      createdAt: unixToDate(order.createdAt)?.toISOString() || null,
      updatedAt: unixToDate(order.updatedAt)?.toISOString() || null,
      items,
    },
  });
});

// ─── POST / ──────────────────────────────────────────────────────────────────

const createOrderSchema = z.object({
  customerName: z
    .string()
    .min(3, "Customer name must be at least 3 characters")
    .max(100, "Customer name must be less than 100 characters"),
  customerPhone: phoneNumberSchema,
  customerEmail: z.email().nullable(),
  shippingAddress: z
    .string()
    .min(10, "Address must be at least 10 characters")
    .max(500, "Address must be less than 500 characters"),
  city: z.string().min(1, "City is required"),
  zone: z.string().min(1, "Zone is required"),
  area: z.string().nullable(),
  cityName: z.string().nullable().optional(),
  zoneName: z.string().nullable().optional(),
  areaName: z.string().nullable().optional(),
  notes: z
    .string()
    .max(500, "Notes must be less than 500 characters")
    .nullable(),
  items: z.array(
    z.object({
      productId: z.string().min(1, "Product is required"),
      variantId: z.string().nullable(),
      quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(99, "Quantity must be at most 99"),
      price: z.number().min(0, "Price must be greater than or equal to 0"),
      productName: z.string().optional().nullable(),
      variantLabel: z.string().optional().nullable()
    }),
  ).min(1, "At least one item is required"),
  discountAmount: z
    .number()
    .min(0, "Discount must be greater than or equal to 0")
    .nullable(),
  discountCode: z.string().optional().nullable(),
  shippingCharge: z
    .number()
    .min(0, "Shipping charge must be greater than or equal to 0"),
  shippingMethodId: z.string().optional().nullable(),
  paymentMethod: z
    .enum([PaymentMethod.STRIPE, PaymentMethod.SSLCOMMERZ, PaymentMethod.POLAR, PaymentMethod.COD])
    .default(PaymentMethod.COD),
  inventoryPool: z
    .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
    .default(InventoryPool.REGULAR)
});

const createOrderRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Orders"],
  summary: "Create a new storefront order",
  request: {
    body: {
      content: {
        "application/json": {
          schema: createOrderSchema
        }
      }
    }
  },
  responses: {
    201: {
      description: "Order created",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: z.object({
          checkoutToken: z.string(),
          receiptToken: z.string(),
          orderId: z.string(),
          paymentMethod: z.string(),
          totalAmount: z.number(),
          message: z.string(),
        }),
      }) } },
    },
    400: errorResponses[400],
    401: errorResponses[401],
    429: errorResponses[429],
    500: errorResponses[500],
    503: serviceUnavailableResponse,
  }
});

app.openapi(createOrderRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const requestUrl = c.req.url;

  await assertCheckoutOrderPolicy(c, data.customerPhone, data.paymentMethod as CheckoutPaymentMethodId);

  // Rate limit order attempts without punishing legitimate shared-IP buyers.
  const kv = c.env.CACHE as KVNamespace | undefined;
  if (kv) {
    const ip = getClientIp(c.req.raw);
    const [ipResult, phoneResult] = await Promise.all([
      rateLimit({ kv, key: `order:ip:${ip}`, limit: 60, windowMs: 60_000 }),
      rateLimit({ kv, key: `order:phone:${data.customerPhone}`, limit: 5, windowMs: 60_000 }),
    ]);
    if (!ipResult.allowed || !phoneResult.allowed) {
      throw new RateLimitError("Too many order requests. Please try again later.");
    }
  }

  try {
    type CartItem = { id: string; price: number; quantity: number; variantId?: string };
    const result = await createStorefrontOrder(
      db,
      data,
      requestUrl,
      (db, code, total, items, customerPhone) => isDiscountValid(db, code, total, items as CartItem[], customerPhone),
      (db, discount, total, items, shippingCost) => calculateDiscountAmount(
        db,
        discount as { id: string; type: string; valueType: string; discountValue: number },
        total,
        items as CartItem[],
        shippingCost,
      ),
    );

    const kvKey = `checkout_status:${result.checkoutToken}`;
    await c.env.CACHE.put(
      kvKey,
      JSON.stringify({ status: "processing", orderId: result.orderId }),
      { expirationTtl: 300 },
    );
    await c.env.CACHE.put(
      `${RECEIPT_TOKEN_PREFIX}${result.checkoutToken}`,
      JSON.stringify({ orderId: result.orderId }),
      { expirationTtl: RECEIPT_TOKEN_TTL_SECONDS },
    );

    try {
      await commitStorefrontOrderPayload(db, c.env, result.queuePayload);
    } catch (commitError) {
      await c.env.CACHE.put(
        kvKey,
        JSON.stringify({
          status: "failed",
          orderId: result.orderId,
          error: commitError instanceof ValidationError
            ? commitError.message
            : "Order creation failed. Please try again.",
          updatedAt: Date.now(),
        }),
        { expirationTtl: 86400 },
      );
      throw commitError;
    }

    const executionCtx = getOptionalExecutionContext(c);
    const sideEffects = Promise.all([
      runStorefrontOrderPostCommitSideEffects(db, c.env, result.queuePayload),
      invalidateStorefrontOrderAvailabilityCaches(db, c.env, result.orderId, executionCtx),
    ]).then(() => undefined);
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      executionCtx.waitUntil(sideEffects);
    } else {
      await sideEffects;
    }

    return created(c, {
      checkoutToken: result.checkoutToken,
      receiptToken: result.checkoutToken,
      orderId: result.orderId,
      paymentMethod: result.paymentMethod,
      totalAmount: result.totalAmount,
      message: "Order created",
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid input data", error.issues);
    }

    throw error;
  }
});

// Export the order routes
export { app as orderRoutes };
