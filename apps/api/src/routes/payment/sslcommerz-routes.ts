// src/server/routes/payment/sslcommerz-routes.ts
// Hono routes for SSLCommerz payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { orders, paymentPlans, PaymentMethod } from "@scalius/database/schema";
import {
  buildSSLCommerzTranId,
  initSSLCommerzSession,
  parseSSLCommerzTranId,
} from "@scalius/core/modules/payments/sslcommerz";
import {
  buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
} from "@scalius/core/modules/payments/payment-session-attempts";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  getSSLCommerzSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import { assertNoActiveShipmentClaim } from "@scalius/core/modules/orders/shipment-claim";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { NotFoundError, ValidationError, ServiceUnavailableError, ApiError } from "../../utils/api-error";
import { getEncryptionKey } from "../../utils/encryption-key";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { assertPaymentSessionOrderPayable, resolvePaymentSessionPolicy } from "./payment-session-policy";
import { assertGatewayEnabledForCheckout } from "./payment-method-allowlist";

import { ok } from "../../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

type SSLCommerzSessionResponse = {
  gatewayUrl?: string;
  sessionKey?: string;
};

// ─── POST /session ───────────────────────────────────────────────────────────

const sessionSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1),
  paymentType: z.enum(["full", "deposit", "balance"]).default("full"),
  depositAmount: z.number().positive().optional(),
  currency: z.string().optional()
});

function buildSslCallbackUrl(apiBase: string, path: string, params: Record<string, string | undefined>): string {
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

const createSessionRoute = createRoute({
  method: "post",
  path: "/session",
  tags: ["Payments - SSLCommerz"],
  summary: "Create an SSLCommerz payment session",
  request: {
    body: {
      content: {
        "application/json": { schema: sessionSchema }
      }
    }
  },
  responses: {
    200: {
      description: "Session created",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            gatewayUrl: z.string().optional(),
            sessionKey: z.string().optional(),
          })),
        },
      },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createSessionRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  await validateReceiptToken(c.env.CACHE, body.orderId, body.receiptToken);

  // Fetch order + customer info
  const order = await db
    .select({
      id: orders.id,
      totalAmount: orders.totalAmount,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      shippingAddress: orders.shippingAddress,
      cityName: orders.cityName,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue,
      deletedAt: orders.deletedAt,
      shipmentClaimId: orders.shipmentClaimId,
      shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt
    })
    .from(orders)
    .where(eq(orders.id, body.orderId))
    .get();

  if (!order) throw new NotFoundError("Order not found");
  assertNoActiveShipmentClaim(order);
  assertPaymentSessionOrderPayable(order);
  if (order.paymentMethod !== PaymentMethod.SSLCOMMERZ) {
    throw new ValidationError("Order is not configured for SSLCommerz payment");
  }

  const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewayEnabledForCheckout(db, c.env.CACHE, encryptionKey, "sslcommerz");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: body.paymentType,
    depositAmount: body.depositAmount,
  }, checkoutFlowSettings);

  const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
  const currency = currencyConfig.code;

  const ssl = await getSSLCommerzSettings(
    db,
    c.env.CACHE,
    encryptionKey,
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  );

  if (!ssl) {
    throw new ServiceUnavailableError("SSLCommerz is not configured. Please set credentials in the admin dashboard.");
  }
  if (!ssl.enabled) {
    throw new ServiceUnavailableError("SSLCommerz gateway is disabled.");
  }

  const origin = getTrustedApiOrigin(c.env, c.req.url);
  const apiBase = `${origin}/api/v1`;
  const callbackParams = {
    order_id: body.orderId,
    receipt_token: body.receiptToken,
  };
  const successUrl = buildSslCallbackUrl(apiBase, "/payment/sslcommerz/success", callbackParams);
  const failUrl = buildSslCallbackUrl(apiBase, "/payment/sslcommerz/fail", { order_id: body.orderId });
  const cancelUrl = buildSslCallbackUrl(apiBase, "/payment/sslcommerz/cancel", { order_id: body.orderId });
  const ipnUrl = `${apiBase}/webhooks/sslcommerz`;

  const attemptIdentity = await buildPaymentSessionAttemptIdentity({
    orderId: body.orderId,
    gateway: "sslcommerz",
    paymentType: policy.paymentType,
    amount: policy.chargeAmount,
    currency,
    receiptToken: body.receiptToken,
    requestContext: {
      successUrl,
      failUrl,
      cancelUrl,
      ipnUrl,
    },
  });
  const transactionId = buildSSLCommerzTranId(body.orderId, policy.paymentType, attemptIdentity.transactionSuffix);
  const attemptClaim = await claimPaymentSessionAttempt<SSLCommerzSessionResponse>(db, {
    ...attemptIdentity,
    providerCorrelationId: transactionId,
  });
  if (attemptClaim.status === "replay") {
    return ok(c, attemptClaim.response);
  }

  let result: Awaited<ReturnType<typeof initSSLCommerzSession>>;
  try {
    result = await initSSLCommerzSession(
      ssl.storeId,
      ssl.storePassword,
      ssl.sandbox,
      {
        orderId: body.orderId,
        transactionId,
        totalAmount: policy.chargeAmount,
        currency,
        successUrl,
        failUrl,
        cancelUrl,
        ipnUrl,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerEmail: order.customerEmail ?? undefined,
        customerAddress: order.shippingAddress,
        customerCity: order.cityName ?? undefined,
        paymentType: policy.paymentType
      }
    );
  } catch (error: unknown) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, error)
      .catch((markError: unknown) => console.error("[payments] Failed to mark SSLCommerz session attempt failed:", markError));
    throw error;
  }

  if (!result.success) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, result.error || "Failed to create SSLCommerz session")
      .catch((error: unknown) => console.error("[payments] Failed to mark SSLCommerz session attempt failed:", error));
    throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create SSLCommerz session");
  }

  const responsePayload: SSLCommerzSessionResponse = {
    gatewayUrl: result.gatewayUrl,
    sessionKey: result.sessionKey
  };

  await markPaymentSessionAttemptCreated(db, attemptClaim.attempt, {
    providerSessionId: result.sessionKey,
    providerCorrelationId: transactionId,
    response: responsePayload,
  });

  // Save session key to order
  try {
    if (result.sessionKey) {
      await db
        .update(orders)
        .set({ paymentIntentId: result.sessionKey, updatedAt: sql`unixepoch()` })
        .where(eq(orders.id, body.orderId));
    }

    // Create payment plan for deposit orders
    if (policy.paymentType === "deposit") {
      await db.insert(paymentPlans).values({
        id: crypto.randomUUID(),
        orderId: body.orderId,
        totalAmount: order.totalAmount,
        depositAmount: policy.depositAmount,
        balanceDue: policy.balanceDue,
        status: "pending",
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`
      }).onConflictDoNothing();
    }
  } catch (error: unknown) {
    console.error("[payments] SSLCommerz session was created, but local order session side effects failed:", error);
  }

  return ok(c, responsePayload);
});

// ─── Redirect handlers ──────────────────────────────────────────────────────
// SSLCommerz POSTs to these callback URLs. Also handle GET for edge cases.
// These are NOT OpenAPI routes — external callbacks, not client-consumed APIs.

function getTrustedApiOrigin(env: { PUBLIC_API_BASE_URL?: string }, requestUrl: string): string {
  const configured = env.PUBLIC_API_BASE_URL?.trim();
  const base = configured || new URL(requestUrl).origin;
  return base.replace(/\/+$/, "");
}

async function extractTranId(c: { req: { method: string; parseBody: () => Promise<Record<string, unknown>>; query: (key: string) => string | undefined } }): Promise<string> {
  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody();
      return (body as Record<string, string>).tran_id ?? "";
    } catch { /* fall through */ }
  }
  return c.req.query("tran_id") ?? "";
}

async function resolveCallbackOrderId(c: {
  req: {
    method: string;
    parseBody: () => Promise<Record<string, unknown>>;
    query: (key: string) => string | undefined;
  };
}): Promise<string> {
  const queryOrderId = c.req.query("order_id") ?? "";
  if (queryOrderId) return queryOrderId;
  return parseSSLCommerzTranId(await extractTranId(c)).orderId;
}

function getStorefrontUrl(c: { env?: { STOREFRONT_URL?: string }; req: { url: string } }): string {
  const envUrl = c.env?.STOREFRONT_URL;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

app.post("/success", async (c) => {
  const orderId = await resolveCallbackOrderId(c);
  const storefront = getStorefrontUrl(c);
  const receiptToken = c.req.query("receipt_token") ?? "";
  if (orderId) {
    const db = c.get("db");
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return c.redirect(`${storefront}/checkout?error=invalid_order`);
  }
  return c.redirect(`${storefront}/order-success?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(receiptToken)}&payment=sslcommerz`);
});

app.get("/success", async (c) => {
  const orderId = await resolveCallbackOrderId(c);
  const storefront = getStorefrontUrl(c);
  const receiptToken = c.req.query("receipt_token") ?? "";
  if (orderId) {
    const db = c.get("db");
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return c.redirect(`${storefront}/checkout?error=invalid_order`);
  }
  return c.redirect(`${storefront}/order-success?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(receiptToken)}&payment=sslcommerz`);
});

app.post("/fail", async (c) => {
  const orderId = await resolveCallbackOrderId(c);
  const storefront = getStorefrontUrl(c);
  if (orderId) {
    const db = c.get("db");
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return c.redirect(`${storefront}/checkout?error=invalid_order`);
  }
  return c.redirect(`${storefront}/cart?error=payment_failed&orderId=${encodeURIComponent(orderId)}`);
});

app.get("/fail", async (c) => {
  const orderId = await resolveCallbackOrderId(c);
  const storefront = getStorefrontUrl(c);
  if (orderId) {
    const db = c.get("db");
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return c.redirect(`${storefront}/checkout?error=invalid_order`);
  }
  return c.redirect(`${storefront}/cart?error=payment_failed&orderId=${encodeURIComponent(orderId)}`);
});

app.post("/cancel", async (c) => {
  const orderId = await resolveCallbackOrderId(c);
  const storefront = getStorefrontUrl(c);
  if (orderId) {
    const db = c.get("db");
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return c.redirect(`${storefront}/checkout?error=invalid_order`);
  }
  return c.redirect(`${storefront}/cart?error=payment_cancelled&orderId=${encodeURIComponent(orderId)}`);
});

app.get("/cancel", async (c) => {
  const orderId = await resolveCallbackOrderId(c);
  const storefront = getStorefrontUrl(c);
  if (orderId) {
    const db = c.get("db");
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return c.redirect(`${storefront}/checkout?error=invalid_order`);
  }
  return c.redirect(`${storefront}/cart?error=payment_cancelled&orderId=${encodeURIComponent(orderId)}`);
});

export const sslcommerzPaymentRoutes = app;
