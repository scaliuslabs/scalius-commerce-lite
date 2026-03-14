// src/server/routes/payment/sslcommerz-routes.ts
// Hono routes for SSLCommerz payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { orders, paymentPlans, PaymentStatus, OrderStatus } from "@scalius/database/schema";
import { initSSLCommerzSession } from "@scalius/core/modules/payments/sslcommerz";
import { getSSLCommerzSettings } from "@scalius/core/modules/payments/gateway-settings";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { NotFoundError, ValidationError, ServiceUnavailableError, ApiError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── POST /session ───────────────────────────────────────────────────────────

const sessionSchema = z.object({
  orderId: z.string().min(1),
  paymentType: z.enum(["full", "deposit", "balance"]).default("full"),
  depositAmount: z.number().positive().optional(),
  currency: z.string().optional(),
  baseUrl: z.url().optional()
});

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
    200: { description: "Session created"  },
    400: { description: "Invalid request"  },
    404: { description: "Order not found"  },
    503: { description: "SSLCommerz not configured"  }
  }
});

app.openapi(createSessionRoute, async (c) => {
  const db = c.get("db");
  const ssl = await getSSLCommerzSettings(db, c.env.CACHE);

  if (!ssl) {
    throw new ServiceUnavailableError("SSLCommerz is not configured. Please set credentials in the admin dashboard.");
  }
  if (!ssl.enabled) {
    throw new ServiceUnavailableError("SSLCommerz gateway is disabled.");
  }

  const body = c.req.valid("json");

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
      paymentStatus: orders.paymentStatus,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue
    })
    .from(orders)
    .where(eq(orders.id, body.orderId))
    .get();

  if (!order) throw new NotFoundError("Order not found");

  // Resolve currency
  if (!body.currency) {
    const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
    body.currency = currencyConfig.code;
  }

  if (order.paymentStatus === PaymentStatus.PAID) {
    throw new ValidationError("Order is already fully paid");
  }
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
    throw new ValidationError("Cannot pay a cancelled/returned order");
  }

  // Determine charge amount
  let chargeAmount: number;
  if (body.paymentType === "deposit") {
    if (!body.depositAmount) {
      throw new ValidationError("depositAmount required for deposit payment");
    }
    chargeAmount = body.depositAmount;
  } else if (body.paymentType === "balance") {
    chargeAmount = order.balanceDue ?? (order.totalAmount - (order.paidAmount ?? 0));
    if (chargeAmount <= 0) throw new ValidationError("No balance due");
  } else {
    chargeAmount = order.totalAmount;
  }

  const origin = body.baseUrl ?? new URL(c.req.url).origin;
  const apiBase = `${origin}/api/v1`;

  const result = await initSSLCommerzSession(
    ssl.storeId,
    ssl.storePassword,
    ssl.sandbox,
    {
      orderId: body.orderId,
      totalAmount: chargeAmount,
      currency: body.currency,
      successUrl: `${apiBase}/payment/sslcommerz/success`,
      failUrl: `${apiBase}/payment/sslcommerz/fail`,
      cancelUrl: `${apiBase}/payment/sslcommerz/cancel`,
      ipnUrl: `${apiBase}/webhooks/sslcommerz`,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: order.customerEmail ?? undefined,
      customerAddress: order.shippingAddress,
      customerCity: order.cityName ?? undefined,
      paymentType: body.paymentType
    }
  );

  if (!result.success) {
    throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create SSLCommerz session");
  }

  // Save session key to order
  if (result.sessionKey) {
    await db
      .update(orders)
      .set({ paymentIntentId: result.sessionKey, updatedAt: sql`unixepoch()` })
      .where(eq(orders.id, body.orderId));
  }

  // Create payment plan for deposit orders
  if (body.paymentType === "deposit" && body.depositAmount) {
    await db.insert(paymentPlans).values({
      id: crypto.randomUUID(),
      orderId: body.orderId,
      totalAmount: order.totalAmount,
      depositAmount: body.depositAmount,
      balanceDue: order.totalAmount - body.depositAmount,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date()
    }).onConflictDoNothing();
  }

  return ok(c, {
    gatewayUrl: result.gatewayUrl,
    sessionKey: result.sessionKey
  });
});

// ─── Redirect handlers ──────────────────────────────────────────────────────
// SSLCommerz POSTs to these callback URLs. Also handle GET for edge cases.
// These are NOT OpenAPI routes — external callbacks, not client-consumed APIs.

async function extractTranId(c: { req: { method: string; parseBody: () => Promise<Record<string, unknown>>; query: (key: string) => string | undefined } }): Promise<string> {
  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody();
      return (body as Record<string, string>).tran_id ?? "";
    } catch { /* fall through */ }
  }
  return c.req.query("tran_id") ?? "";
}

function getStorefrontUrl(c: { env?: { STOREFRONT_URL?: string }; req: { url: string } }): string {
  const envUrl = c.env?.STOREFRONT_URL;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

app.post("/success", async (c) => {
  const tran_id = await extractTranId(c);
  const storefront = getStorefrontUrl(c);
  return c.redirect(`${storefront}/order-success?orderId=${encodeURIComponent(tran_id)}&payment=sslcommerz`);
});

app.get("/success", async (c) => {
  const tran_id = c.req.query("tran_id") ?? "";
  const storefront = getStorefrontUrl(c);
  return c.redirect(`${storefront}/order-success?orderId=${encodeURIComponent(tran_id)}&payment=sslcommerz`);
});

app.post("/fail", async (c) => {
  const tran_id = await extractTranId(c);
  const storefront = getStorefrontUrl(c);
  return c.redirect(`${storefront}/cart?error=payment_failed&orderId=${encodeURIComponent(tran_id)}`);
});

app.get("/fail", async (c) => {
  const tran_id = c.req.query("tran_id") ?? "";
  const storefront = getStorefrontUrl(c);
  return c.redirect(`${storefront}/cart?error=payment_failed&orderId=${encodeURIComponent(tran_id)}`);
});

app.post("/cancel", async (c) => {
  const tran_id = await extractTranId(c);
  const storefront = getStorefrontUrl(c);
  return c.redirect(`${storefront}/cart?error=payment_cancelled&orderId=${encodeURIComponent(tran_id)}`);
});

app.get("/cancel", async (c) => {
  const tran_id = c.req.query("tran_id") ?? "";
  const storefront = getStorefrontUrl(c);
  return c.redirect(`${storefront}/cart?error=payment_cancelled&orderId=${encodeURIComponent(tran_id)}`);
});

export const sslcommerzPaymentRoutes = app;
