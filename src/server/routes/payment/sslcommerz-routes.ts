// src/server/routes/payment/sslcommerz-routes.ts
// Hono routes for SSLCommerz payment operations.
// Credentials are loaded from the DB settings table (set via admin dashboard).
//
// POST /payment/sslcommerz/session - Initiate payment session (storefront)
// GET/POST /payment/sslcommerz/success, fail, cancel - Redirect handlers after payment

import { Hono } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { orders, paymentPlans, PaymentStatus, OrderStatus } from "@/db/schema";
import { initSSLCommerzSession } from "@/lib/payment/sslcommerz";
import { getSSLCommerzSettings } from "@/lib/payment/gateway-settings";
import { getCurrencyConfig } from "@/lib/currency";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /payment/sslcommerz/session
// ---------------------------------------------------------------------------
const sessionSchema = z.object({
  orderId: z.string().min(1),
  paymentType: z.enum(["full", "deposit", "balance"]).default("full"),
  depositAmount: z.number().positive().optional(),
  currency: z.string().optional(),
  /** Base URL for redirect callbacks (e.g. https://example.com) */
  baseUrl: z.string().url().optional(),
});

app.post("/session", async (c) => {
  const db = c.get("db");
  const ssl = await getSSLCommerzSettings(db, c.env.CACHE);

  if (!ssl) {
    return c.json({
      success: false,
      error: "SSLCommerz is not configured. Please set credentials in the admin dashboard.",
    }, 503);
  }
  if (!ssl.enabled) {
    return c.json({ success: false, error: "SSLCommerz gateway is disabled." }, 503);
  }

  let body: z.infer<typeof sessionSchema>;
  try {
    body = sessionSchema.parse(await c.req.json());
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

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
      balanceDue: orders.balanceDue,
    })
    .from(orders)
    .where(eq(orders.id, body.orderId))
    .get();

  if (!order) return c.json({ success: false, error: "Order not found" }, 404);

  // Resolve currency from settings if not provided in the request
  if (!body.currency) {
    const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
    body.currency = currencyConfig.code;
  }

  if (order.paymentStatus === PaymentStatus.PAID) {
    return c.json({ success: false, error: "Order is already fully paid" }, 400);
  }
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
    return c.json({ success: false, error: "Cannot pay a cancelled/returned order" }, 400);
  }

  // Determine charge amount
  let chargeAmount: number;
  if (body.paymentType === "deposit") {
    if (!body.depositAmount) {
      return c.json({ success: false, error: "depositAmount required for deposit payment" }, 400);
    }
    chargeAmount = body.depositAmount;
  } else if (body.paymentType === "balance") {
    chargeAmount = order.balanceDue ?? (order.totalAmount - (order.paidAmount ?? 0));
    if (chargeAmount <= 0) return c.json({ success: false, error: "No balance due" }, 400);
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
      paymentType: body.paymentType,
    }
  );

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 500);
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
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  return c.json({
    success: true,
    gatewayUrl: result.gatewayUrl,
    sessionKey: result.sessionKey,
  });
});

// ---------------------------------------------------------------------------
// Redirect handlers (called by SSLCommerz after customer completes payment)
// IPN (POST) handles the actual DB update via /webhooks/sslcommerz
// These just redirect the customer to the appropriate storefront page
// ---------------------------------------------------------------------------

// SSLCommerz POSTs to these callback URLs with form-urlencoded body.
// Also handle GET for manual navigation / edge cases.

async function extractTranId(c: any): Promise<string> {
  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody();
      return (body as Record<string, string>).tran_id ?? "";
    } catch { /* fall through */ }
  }
  return c.req.query("tran_id") ?? "";
}

/** Resolve the storefront base URL (never the admin dashboard). */
function getStorefrontUrl(c: any): string {
  const envUrl = c.env?.STOREFRONT_URL;
  if (envUrl) return envUrl.replace(/\/+$/, ""); // trim trailing slash
  // Fallback: if STOREFRONT_URL is not set, use request origin (shouldn't happen in production)
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
