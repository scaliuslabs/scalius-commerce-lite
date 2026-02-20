// src/server/routes/payment/sslcommerz-routes.ts
// Hono routes for SSLCommerz payment operations.
// Credentials are loaded from the DB settings table (set via admin dashboard).
//
// POST /payment/sslcommerz/session              - Initiate payment session (storefront)
// POST /payment/sslcommerz/refund               - Issue refund (admin)
// GET  /payment/sslcommerz/refund-status/:refId  - Query refund status
// GET  /payment/sslcommerz/success              - Redirect handler after payment
// GET  /payment/sslcommerz/fail                 - Redirect handler after failure
// GET  /payment/sslcommerz/cancel               - Redirect handler after cancel

import { Hono } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { orders, orderPayments, paymentPlans, PaymentStatus, OrderStatus } from "@/db/schema";
import {
  initSSLCommerzSession,
  initiateSSLCommerzRefund,
  querySSLCommerzRefundStatus,
} from "@/lib/payment/sslcommerz";
import { getSSLCommerzSettings } from "@/lib/payment/gateway-settings";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /payment/sslcommerz/session
// ---------------------------------------------------------------------------
const sessionSchema = z.object({
  orderId: z.string().min(1),
  paymentType: z.enum(["full", "deposit", "balance"]).default("full"),
  depositAmount: z.number().positive().optional(),
  currency: z.string().default("BDT"),
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
// POST /payment/sslcommerz/refund
// Issue a refund for an SSLCommerz payment (admin).
// Requires the bank_tran_id from the original IPN validation.
// ---------------------------------------------------------------------------
const refundSchema = z.object({
  orderId: z.string().min(1),
  amount: z.number().positive("Refund amount must be positive"),
  remarks: z.string().min(1, "Refund remarks are required").default("Customer refund request"),
});

app.post("/refund", async (c) => {
  const db = c.get("db");
  const ssl = await getSSLCommerzSettings(db, c.env.CACHE);
  if (!ssl) return c.json({ success: false, error: "SSLCommerz not configured" }, 503);

  let body: z.infer<typeof refundSchema>;
  try {
    body = refundSchema.parse(await c.req.json());
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  // Find the payment record with bank_tran_id
  const payment = await db
    .select({
      id: orderPayments.id,
      amount: orderPayments.amount,
      sslcommerzBankTranId: orderPayments.sslcommerzBankTranId,
    })
    .from(orderPayments)
    .where(eq(orderPayments.orderId, body.orderId))
    .get();

  if (!payment || !payment.sslcommerzBankTranId) {
    return c.json({
      success: false,
      error: "No SSLCommerz payment found for this order. bank_tran_id is required for refunds.",
    }, 400);
  }

  if (body.amount > payment.amount) {
    return c.json({
      success: false,
      error: `Refund amount (${body.amount}) exceeds payment amount (${payment.amount})`,
    }, 400);
  }

  const refundTranId = `REF-${body.orderId}-${Date.now()}`;

  const result = await initiateSSLCommerzRefund(
    ssl.storeId,
    ssl.storePassword,
    ssl.sandbox,
    {
      bankTranId: payment.sslcommerzBankTranId,
      refundAmount: body.amount,
      refundRemarks: body.remarks,
      refundTranId,
    }
  );

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 500);
  }

  // Update order payment status
  const order = await db
    .select({ totalAmount: orders.totalAmount, paidAmount: orders.paidAmount })
    .from(orders)
    .where(eq(orders.id, body.orderId))
    .get();

  if (order) {
    const isFullRefund = body.amount >= (order.paidAmount ?? order.totalAmount);
    await db
      .update(orders)
      .set({
        paymentStatus: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL,
        paidAmount: Math.max(0, (order.paidAmount ?? 0) - body.amount),
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, body.orderId));
  }

  return c.json({
    success: true,
    refundRefId: result.refundRefId,
    refundTranId,
    status: result.status,
  });
});

// ---------------------------------------------------------------------------
// GET /payment/sslcommerz/refund-status/:refundRefId
// Query SSLCommerz refund processing status.
// ---------------------------------------------------------------------------
app.get("/refund-status/:refundRefId", async (c) => {
  const db = c.get("db");
  const ssl = await getSSLCommerzSettings(db, c.env.CACHE);
  if (!ssl) return c.json({ success: false, error: "SSLCommerz not configured" }, 503);

  const { refundRefId } = c.req.param();

  const result = await querySSLCommerzRefundStatus(
    ssl.storeId,
    ssl.storePassword,
    ssl.sandbox,
    refundRefId
  );

  return c.json({ success: true, ...result });
});

// ---------------------------------------------------------------------------
// Redirect handlers (called by SSLCommerz after customer completes payment)
// IPN (POST) handles the actual DB update via /webhooks/sslcommerz
// These just redirect the customer to the appropriate storefront page
// ---------------------------------------------------------------------------

app.get("/success", async (c) => {
  const tran_id = c.req.query("tran_id") ?? "";
  const origin = new URL(c.req.url).origin;
  return c.redirect(`${origin}/order-confirmed?orderId=${encodeURIComponent(tran_id)}`);
});

app.get("/fail", async (c) => {
  const tran_id = c.req.query("tran_id") ?? "";
  const origin = new URL(c.req.url).origin;
  return c.redirect(`${origin}/payment-failed?orderId=${encodeURIComponent(tran_id)}`);
});

app.get("/cancel", async (c) => {
  const tran_id = c.req.query("tran_id") ?? "";
  const origin = new URL(c.req.url).origin;
  return c.redirect(`${origin}/payment-cancelled?orderId=${encodeURIComponent(tran_id)}`);
});

export const sslcommerzPaymentRoutes = app;
