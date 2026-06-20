// src/server/routes/payment/polar-routes.ts
// Hono API routes for Polar payment operations (storefront-initiated).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type Database } from "@scalius/database/client";
import { orders, paymentPlans, PaymentMethod } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import {
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
    getPolarSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import {
    buildPaymentSessionAttemptIdentity,
    claimPaymentSessionAttempt,
    markPaymentSessionAttemptCreated,
    markPaymentSessionAttemptFailed,
} from "@scalius/core/modules/payments/payment-session-attempts";
import { createPolarCheckout } from "@scalius/core/modules/payments/polar";
import { assertNoActiveShipmentClaim } from "@scalius/core/modules/orders/shipment-claim";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { NotFoundError, ServiceUnavailableError, ApiError, ValidationError } from "../../utils/api-error";
import { getEncryptionKey } from "../../utils/encryption-key";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { assertPaymentSessionOrderPayable, resolvePaymentSessionPolicy } from "./payment-session-policy";
import { assertGatewayEnabledForCheckout } from "./payment-method-allowlist";

import { ok } from "../../utils/api-response";
export const polarPaymentRoutes = new OpenAPIHono<{ Bindings: Env }>();

type PolarSessionResponse = {
    gatewayUrl?: string;
    checkoutId?: string;
};

// ─── POST /session ───────────────────────────────────────────────────────────

const polarSessionSchema = z.object({
    orderId: z.string().min(1),
    depositAmount: z.number().positive().optional(),
    currency: z.string().optional(),
    type: z.enum(["full", "deposit", "balance"]).optional(),
    paymentType: z.enum(["full", "deposit", "balance"]).optional(),
    customerName: z.string().optional(),
    customerEmail: z.string().optional(),
    customerPhone: z.string().optional(),
    receiptToken: z.string().min(1),
    retryKey: z.string().trim().min(1).max(128).optional()
});

const createPolarSessionRoute = createRoute({
    method: "post",
    path: "/session",
    tags: ["Payments - Polar"],
    summary: "Create a Polar checkout session",
    request: {
        body: {
            content: {
                "application/json": { schema: polarSessionSchema }
            }
        }
    },
    responses: {
        200: {
            description: "Polar checkout session created",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        gatewayUrl: z.string().optional(),
                        checkoutId: z.string().optional(),
                    })),
                },
            },
        },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

polarPaymentRoutes.openapi(createPolarSessionRoute, async (c) => {
    const body = c.req.valid("json");
    const orderId = body.orderId;

    const db: Database = c.get("db");
    const kv = c.env.CACHE;
    const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
    await validateReceiptToken(c.env.CACHE, orderId, body.receiptToken, db);

    // Validate the order exists
    const order = await db
        .select({
            id: orders.id,
            totalAmount: orders.totalAmount,
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
        .where(eq(orders.id, orderId))
        .get();

    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);
    assertPaymentSessionOrderPayable(order);
    if (order.paymentMethod !== PaymentMethod.POLAR) {
        throw new ValidationError("Order is not configured for Polar payment");
    }

    const checkoutFlowSettings = await assertGatewayEnabledForCheckout(db, kv, encryptionKey, "polar");
    const policy = await resolvePaymentSessionPolicy(db, order, {
        paymentType: body.paymentType || body.type,
        depositAmount: body.depositAmount,
    }, checkoutFlowSettings);

    // Get configured currency
    const currencyConfig = await getCurrencyConfig(db);
    let currency = currencyConfig.code.toLowerCase();
    let paymentAmount = policy.chargeAmount;

    // Get Polar credentials from DB
    const polarSettings = await getPolarSettings(
        db,
        kv,
        encryptionKey,
        FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
    );
    if (!polarSettings || !polarSettings.enabled) {
        throw new ServiceUnavailableError("Polar is not configured or disabled");
    }

    // Polar only supports specific currencies. If the store currency isn't
    // supported, convert the amount to USD using the configured exchange rate.
    const POLAR_SUPPORTED_CURRENCIES = new Set([
        "aed", "ars", "aud", "brl", "cad", "chf", "clp", "cny", "cop", "czk",
        "dkk", "eur", "gbp", "hkd", "huf", "idr", "ils", "inr", "jpy", "krw",
        "mxn", "myr", "nok", "nzd", "pen", "php", "pln", "ron", "sar", "sek",
        "sgd", "thb", "try", "twd", "usd", "zar",
    ]);

    // Track the original local currency amount before any conversion.
    // All DB amounts (orders, paymentPlans, orderPayments) must stay in store currency.
    const originalLocalAmount = paymentAmount;
    const originalCurrency = currency;
    let exchangeRate = 1;

    if (!POLAR_SUPPORTED_CURRENCIES.has(currency)) {
        const rate = currencyConfig.usdExchangeRate;
        if (!rate || rate <= 0) {
            throw new ApiError(400, "CURRENCY_ERROR",
                `Currency "${currency.toUpperCase()}" is not supported by Polar and no USD exchange rate is configured. ` +
                `Please set a USD exchange rate in Settings > Currency.`
            );
        }
        console.log(`[Polar] Converting ${currency.toUpperCase()} → USD at rate ${rate} for order ${orderId}`);
        exchangeRate = rate;
        paymentAmount = Math.round((paymentAmount / rate) * 100) / 100; // Round to 2 decimals
        currency = "usd";
    }

    // Convert major-unit amount to smallest currency unit using ISO 4217 decimals.
    // e.g. USD/BDT: ×100, JPY: ×1, BHD: ×1000
    const decimals = getDecimalPlaces(currency);
    const amountInCents = Math.round(paymentAmount * Math.pow(10, decimals));

    const baseUrl = getTrustedApiOrigin(c.env, c.req.url);
    const callbackParams = {
        order_id: orderId,
        receipt_token: body.receiptToken,
        payment_type: policy.paymentType,
        deposit_amount: policy.paymentType === "deposit" ? String(policy.depositAmount) : undefined,
    };
    const successUrl = buildPolarCallbackUrl(baseUrl, "/api/v1/payment/polar/success", callbackParams);
    const cancelUrl = buildPolarCallbackUrl(baseUrl, "/api/v1/payment/polar/cancel", callbackParams);

    const attemptIdentity = await buildPaymentSessionAttemptIdentity({
        orderId,
        gateway: "polar",
        paymentType: policy.paymentType,
        amount: paymentAmount,
        currency,
        receiptToken: body.receiptToken,
        requestContext: {
            amountInSmallestUnit: amountInCents,
            originalLocalAmount,
            originalCurrency,
            exchangeRate,
            successUrl,
            cancelUrl,
            customerName: body.customerName ?? null,
            customerEmail: body.customerEmail ?? null,
            retryKey: body.retryKey ?? null,
        },
    });
    const attemptClaim = await claimPaymentSessionAttempt<PolarSessionResponse>(db, attemptIdentity);
    if (attemptClaim.status === "replay") {
        return ok(c, attemptClaim.response);
    }

    let result: Awaited<ReturnType<typeof createPolarCheckout>>;
    try {
        result = await createPolarCheckout(polarSettings, {
            orderId,
            amount: amountInCents,
            currency,
            productId: polarSettings.productId,
            paymentType: policy.paymentType,
            successUrl,
            cancelUrl,
            customerName: body.customerName,
            customerEmail: body.customerEmail,
            metadata: {
                orderId,
                paymentType: policy.paymentType,
                // Roundtrip original amounts through Polar webhook so the queue consumer
                // can record paidAmount in store currency, not gateway currency.
                originalAmount: String(originalLocalAmount),
                originalCurrency,
                exchangeRate: String(exchangeRate),
            }
        });
    } catch (error: unknown) {
        await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, error)
            .catch((markError: unknown) => console.error("[payments] Failed to mark Polar session attempt failed:", markError));
        throw error;
    }

    if (!result.success || !result.checkoutUrl) {
        await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, result.error || "Failed to create Polar checkout")
            .catch((error: unknown) => console.error("[payments] Failed to mark Polar session attempt failed:", error));
        throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create Polar checkout");
    }

    const responsePayload: PolarSessionResponse = {
        gatewayUrl: result.checkoutUrl,
        checkoutId: result.checkoutId
    };

    await markPaymentSessionAttemptCreated(db, attemptClaim.attempt, {
        providerSessionId: result.checkoutId,
        response: responsePayload,
    });

    // Save the Polar checkout ID to the order
    try {
        await db
            .update(orders)
            .set({
                paymentIntentId: result.checkoutId,
                paymentMethod: PaymentMethod.POLAR,
                updatedAt: sql`unixepoch()`
            })
            .where(eq(orders.id, orderId));

        // Set up payment plan for deposit orders.
        // Use original local currency amounts — NOT the converted gateway amount.
        if (policy.paymentType === "deposit") {
            await db
                .insert(paymentPlans)
                .values({
                    id: crypto.randomUUID(),
                    orderId,
                    totalAmount: order.totalAmount,
                    depositAmount: policy.depositAmount,
                    balanceDue: policy.balanceDue,
                    status: "pending"
                })
                .onConflictDoUpdate({
                    target: paymentPlans.orderId,
                    set: {
                        depositAmount: policy.depositAmount,
                        balanceDue: policy.balanceDue,
                        updatedAt: sql`unixepoch()`
                    }
                });
        }
    } catch (error: unknown) {
        console.error("[payments] Polar session was created, but local order session side effects failed:", error);
    }

    return ok(c, responsePayload);
});

// ─── GET /success ────────────────────────────────────────────────────────────
// Redirect handlers — not OpenAPI routes (external callbacks)

function getTrustedApiOrigin(env: { PUBLIC_API_BASE_URL?: string }, requestUrl: string): string {
    const configured = env.PUBLIC_API_BASE_URL?.trim();
    const base = configured || new URL(requestUrl).origin;
    return base.replace(/\/+$/, "");
}

function buildPolarCallbackUrl(baseUrl: string, path: string, params: Record<string, string | undefined>): string {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
        if (value) url.searchParams.set(key, value);
    }
    return url.toString();
}

function getConfiguredStorefrontUrl(env: { STOREFRONT_URL?: string; PUBLIC_STOREFRONT_URL?: string }): string {
    return String(env.STOREFRONT_URL || env.PUBLIC_STOREFRONT_URL || "").replace(/\/+$/, "");
}

function normalizeCallbackPaymentType(value: string | undefined): "full" | "deposit" | "balance" | "" {
    if (value === "full" || value === "deposit" || value === "balance") return value;
    return "";
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
        payment: "polar";
        result?: "cancelled";
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

async function validateCallbackOrder(db: Pick<Database, "select">, orderId: string, storefrontUrl: string): Promise<string | null> {
    if (!orderId) return null;
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    return order ? null : `${storefrontUrl}/checkout?error=invalid_order`;
}

polarPaymentRoutes.get("/success", async (c) => {
    const orderId = c.req.query("order_id");
    const receiptToken = c.req.query("receipt_token") ?? "";
    const paymentType = getCallbackPaymentType(c);
    const depositAmount = getCallbackDepositAmount(c);

    const envObj = c.env;
    const storefrontUrl = getConfiguredStorefrontUrl(envObj);

    if (storefrontUrl) {
        if (orderId) {
            const db: Database = c.get("db");
            const invalidRedirect = await validateCallbackOrder(db, orderId, storefrontUrl);
            if (invalidRedirect) return c.redirect(invalidRedirect);
        }
        if (!receiptToken) return c.redirect(`${storefrontUrl}/checkout?error=payment_return_missing_receipt&payment=polar`);
        return c.redirect(buildStorefrontOrderSuccessUrl(storefrontUrl, {
            orderId: orderId ?? "",
            receiptToken,
            payment: "polar",
            paymentType,
            depositAmount,
        }));
    }

    return c.redirect("/");
});

// ─── GET /cancel ─────────────────────────────────────────────────────────────

polarPaymentRoutes.get("/cancel", async (c) => {
    const envObj = c.env;
    const storefrontUrl = getConfiguredStorefrontUrl(envObj);
    const orderId = c.req.query("order_id") ?? "";
    const receiptToken = c.req.query("receipt_token") ?? "";

    if (storefrontUrl) {
        if (orderId) {
            const db: Database = c.get("db");
            const invalidRedirect = await validateCallbackOrder(db, orderId, storefrontUrl);
            if (invalidRedirect) return c.redirect(invalidRedirect);
        }
        if (!receiptToken) {
            return c.redirect(`${storefrontUrl}/checkout?error=payment_cancelled&payment=polar`);
        }
        return c.redirect(buildStorefrontOrderSuccessUrl(storefrontUrl, {
            orderId,
            receiptToken,
            payment: "polar",
            result: "cancelled",
            paymentType: getCallbackPaymentType(c),
            depositAmount: getCallbackDepositAmount(c),
        }));
    }

    return c.redirect("/");
});
