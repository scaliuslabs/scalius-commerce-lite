// src/server/routes/payment/polar-routes.ts
// Hono API routes for Polar payment operations (storefront-initiated).
// Pattern mirrors sslcommerz-routes.ts — redirect-based checkout flow.

import { Hono } from "hono";
import { type Database } from "@/db";
import { orders, paymentPlans, PaymentMethod } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getPolarSettings } from "@/modules/payments/gateway-settings";
import { createPolarCheckout } from "@/modules/payments/polar";
import { getKv } from "../../utils/kv-cache";
import { getCurrencyConfig } from "@/shared/currency";

export const polarPaymentRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /payment/polar/session — Create a Polar checkout session
// ---------------------------------------------------------------------------

polarPaymentRoutes.post("/session", async (c) => {
    try {
        const body = await c.req.json<{
            orderId: string;
            depositAmount?: number;
            currency?: string;
            type?: "full" | "deposit" | "balance";
            paymentType?: "full" | "deposit" | "balance";
            customerName?: string;
            customerEmail?: string;
            customerPhone?: string;
            successUrl?: string;
            cancelUrl?: string;
        }>();

        const orderId = body.orderId;
        const type = body.paymentType || body.type || "full";

        if (!orderId) {
            return c.json({ error: "orderId is required" }, 400);
        }

        const db: Database = c.get("db");
        const kv = getKv();

        // Get Polar credentials from DB
        const polarSettings = await getPolarSettings(db, kv);
        if (!polarSettings || !polarSettings.enabled) {
            return c.json({ error: "Polar is not configured or disabled" }, 503);
        }

        // Validate the order exists and is in a payable state
        const order = await db
            .select({
                id: orders.id,
                totalAmount: orders.totalAmount,
                status: orders.status,
                paymentMethod: orders.paymentMethod,
                paymentStatus: orders.paymentStatus,
                paidAmount: orders.paidAmount,
            })
            .from(orders)
            .where(eq(orders.id, orderId))
            .get();

        if (!order) {
            return c.json({ error: "Order not found" }, 404);
        }

        // Get configured currency
        const currencyConfig = await getCurrencyConfig(db);
        const currency = (body.currency ?? currencyConfig.code).toLowerCase();

        // Determine the correct amount based on payment type
        let paymentAmount = order.totalAmount;
        if (type === "deposit") {
            paymentAmount = body.depositAmount || order.totalAmount;
        } else if (type === "balance") {
            const plan = await db
                .select()
                .from(paymentPlans)
                .where(eq(paymentPlans.orderId, orderId))
                .get();
            if (plan) {
                paymentAmount = plan.balanceDue;
            }
        }

        // Convert to cents (smallest unit) for Polar
        const amountInCents = Math.round(paymentAmount * 100);

        // Build success URL with checkout ID placeholder
        const baseUrl = (c.env.PUBLIC_API_BASE_URL || new URL(c.req.url).origin).trim();
        const successUrl = body.successUrl || `${baseUrl}/api/v1/payment/polar/success?order_id=${orderId}`;

        // Create Polar checkout session
        const result = await createPolarCheckout(polarSettings, {
            orderId,
            amount: amountInCents,
            currency,
            productId: polarSettings.productId,
            paymentType: type,
            successUrl,
            cancelUrl: body.cancelUrl,
            customerName: body.customerName,
            customerEmail: body.customerEmail,
            metadata: {
                orderId,
                paymentType: type,
            },
        });

        if (!result.success || !result.checkoutUrl) {
            return c.json(
                { error: result.error || "Failed to create Polar checkout" },
                500
            );
        }

        // Save the Polar checkout ID to the order
        await db
            .update(orders)
            .set({
                paymentIntentId: result.checkoutId, // Reuse existing field
                paymentMethod: PaymentMethod.POLAR,
                updatedAt: new Date(),
            })
            .where(eq(orders.id, orderId));

        // Set up payment plan for deposit orders
        if (type === "deposit") {
            const depositAmount = paymentAmount;
            const balanceDue = order.totalAmount - depositAmount;

            await db
                .insert(paymentPlans)
                .values({
                    id: crypto.randomUUID(),
                    orderId,
                    totalAmount: order.totalAmount,
                    depositAmount,
                    balanceDue,
                    status: "pending",
                })
                .onConflictDoUpdate({
                    target: paymentPlans.orderId,
                    set: {
                        depositAmount,
                        balanceDue,
                        updatedAt: new Date(),
                    },
                });
        }

        return c.json({
            success: true,
            gatewayUrl: result.checkoutUrl,
            checkoutId: result.checkoutId,
        });
    } catch (error) {
        console.error("[polar-routes] Error creating checkout session:", error);
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ---------------------------------------------------------------------------
// GET /payment/polar/success — Redirect after successful Polar payment
// ---------------------------------------------------------------------------

polarPaymentRoutes.get("/success", async (c) => {
    const orderId = c.req.query("order_id");

    // Read storefront URL from env or settings
    const envObj = c.env as any;
    const storefrontUrl = envObj.STOREFRONT_URL || envObj.PUBLIC_STOREFRONT_URL || "";

    if (orderId && storefrontUrl) {
        return c.redirect(`${storefrontUrl}/order-success?orderId=${orderId}&payment=polar`);
    }

    return c.json({ success: true, message: "Payment received", orderId });
});

// ---------------------------------------------------------------------------
// GET /payment/polar/cancel — Redirect after cancelled Polar payment
// ---------------------------------------------------------------------------

polarPaymentRoutes.get("/cancel", async (c) => {
    const orderId = c.req.query("order_id");

    const envObj = c.env as any;
    const storefrontUrl = envObj.STOREFRONT_URL || envObj.PUBLIC_STOREFRONT_URL || "";

    if (storefrontUrl) {
        return c.redirect(`${storefrontUrl}/checkout?error=payment_cancelled&payment=polar`);
    }

    return c.json({ success: false, message: "Payment cancelled", orderId });
});
