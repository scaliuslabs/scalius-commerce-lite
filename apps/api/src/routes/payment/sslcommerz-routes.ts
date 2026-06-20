// src/server/routes/payment/sslcommerz-routes.ts
// Hono routes for SSLCommerz payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders, PaymentMethod } from "@scalius/database/schema";
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
import { ensurePendingPaymentPlanForSession } from "./payment-plan-session";

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
  paymentType: z.enum(["full", "deposit", "balance"]).optional(),
  depositAmount: z.number().positive().optional(),
  currency: z.string().optional(),
  retryKey: z.string().trim().min(1).max(128).optional()
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
  await validateReceiptToken(c.env.CACHE, body.orderId, body.receiptToken, db);

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
  await ensurePendingPaymentPlanForSession(db, order, policy);

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
    payment_type: policy.paymentType,
    deposit_amount: policy.paymentType === "deposit" ? String(policy.depositAmount) : undefined,
  };
  const successUrl = buildSslCallbackUrl(apiBase, "/payment/sslcommerz/success", callbackParams);
  const failUrl = buildSslCallbackUrl(apiBase, "/payment/sslcommerz/fail", callbackParams);
  const cancelUrl = buildSslCallbackUrl(apiBase, "/payment/sslcommerz/cancel", callbackParams);
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
      retryKey: body.retryKey ?? null,
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

  // Save session key to order as a recovery hint; attempt/provider ids carry
  // the durable idempotency contract.
  try {
    if (result.sessionKey) {
      await db
        .update(orders)
        .set({ paymentIntentId: result.sessionKey, updatedAt: sql`unixepoch()` })
        .where(eq(orders.id, body.orderId));
    }
  } catch (error: unknown) {
    console.error("[payments] SSLCommerz session was created, but local order recovery hint failed:", error);
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

type SslCallbackContext = {
  req: {
    method: string;
    url: string;
    parseBody: () => Promise<Record<string, unknown>>;
    query: (key: string) => string | undefined;
  };
  env?: { STOREFRONT_URL?: string };
  get: (key: "db") => Pick<Database, "select">;
};

function normalizeCallbackPaymentType(value: string | undefined): "full" | "deposit" | "balance" | "" {
  if (value === "full" || value === "deposit" || value === "balance") return value;
  return "";
}

function getCallbackReceiptToken(c: { req: { query: (key: string) => string | undefined } }): string {
  return c.req.query("receipt_token") ?? c.req.query("receiptToken") ?? "";
}

function getCallbackPaymentType(c: { req: { query: (key: string) => string | undefined } }): "full" | "deposit" | "balance" | "" {
  return normalizeCallbackPaymentType(c.req.query("payment_type") ?? c.req.query("paymentType"));
}

function getCallbackDepositAmount(c: { req: { query: (key: string) => string | undefined } }): string {
  const value = c.req.query("deposit_amount") ?? c.req.query("depositAmount") ?? "";
  if (!value) return "";
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? value : "";
}

function buildStorefrontOrderSuccessUrl(
  storefront: string,
  params: {
    orderId: string;
    receiptToken: string;
    payment: "sslcommerz";
    result?: "failed" | "cancelled";
    paymentType?: "full" | "deposit" | "balance" | "";
    depositAmount?: string;
  },
): string {
  const url = new URL(`${storefront}/order-success`);
  url.searchParams.set("orderId", params.orderId);
  url.searchParams.set("token", params.receiptToken);
  url.searchParams.set("payment", params.payment);
  if (params.result) url.searchParams.set("result", params.result);
  if (params.paymentType) url.searchParams.set("paymentType", params.paymentType);
  if (params.depositAmount) url.searchParams.set("depositAmount", params.depositAmount);
  return url.toString();
}

async function buildSslCallbackRedirectUrl(c: SslCallbackContext, result?: "failed" | "cancelled"): Promise<string> {
  const orderId = await resolveCallbackOrderId(c);
  const storefront = getStorefrontUrl(c);
  const receiptToken = getCallbackReceiptToken(c);

  if (orderId) {
    const db = c.get("db");
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return `${storefront}/checkout?error=invalid_order`;
  }

  if (!receiptToken) {
    const error = result === "cancelled" ? "payment_cancelled" : "payment_failed";
    return `${storefront}/cart?error=${error}&orderId=${encodeURIComponent(orderId)}`;
  }

  return buildStorefrontOrderSuccessUrl(storefront, {
    orderId,
    receiptToken,
    payment: "sslcommerz",
    result,
    paymentType: getCallbackPaymentType(c),
    depositAmount: getCallbackDepositAmount(c),
  });
}

app.post("/success", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c));
});

app.get("/success", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c));
});

app.post("/fail", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c, "failed"));
});

app.get("/fail", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c, "failed"));
});

app.post("/cancel", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c, "cancelled"));
});

app.get("/cancel", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c, "cancelled"));
});

export const sslcommerzPaymentRoutes = app;
