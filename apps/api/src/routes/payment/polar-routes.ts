// src/server/routes/payment/polar-routes.ts
// Hono API routes for Polar payment operations (storefront-initiated).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { createPolarPaymentSession, isPaymentSessionProcessingResult } from "./payment-session-create";
import { acceptedPaymentSessionProcessing, paymentSessionProcessingResponse } from "./payment-session-response";

export const polarPaymentRoutes = new OpenAPIHono<{ Bindings: Env }>();
const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";

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
    receiptToken: z.string().min(1).optional(),
});

function getSessionReceiptToken(c: { req: { header: (name: string) => string | undefined } }, body: { receiptToken?: string }): string | undefined {
    const headerToken = c.req.header(RECEIPT_TOKEN_HEADER)?.trim();
    return body.receiptToken ?? (headerToken || undefined);
}

async function validateReceiptProof(
    c: { env: Env; req: { header: (name: string) => string | undefined } },
    db: Database,
    body: { orderId: string; receiptToken?: string },
): Promise<string> {
    const receiptToken = getSessionReceiptToken(c, body);
    await validateReceiptToken(c.env.CACHE, body.orderId, receiptToken, db);
    if (!receiptToken) throw new Error("Receipt token validation returned without proof.");
    return receiptToken;
}

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
        },
        headers: z.object({
            [RECEIPT_TOKEN_HEADER]: z.string().optional(),
        }),
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
        202: paymentSessionProcessingResponse,
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

polarPaymentRoutes.openapi(createPolarSessionRoute, async (c) => {
    const body = c.req.valid("json");
    const orderId = body.orderId;

    const db: Database = c.get("db");
    const receiptToken = await validateReceiptProof(c, db, body);

    const result = await createPolarPaymentSession(c, {
        orderId,
        paymentType: body.paymentType || body.type,
        depositAmount: body.depositAmount,
        proof: { kind: "receipt", receiptToken },
        returnTarget: { kind: "receipt" },
    });

    if (isPaymentSessionProcessingResult(result)) {
        return acceptedPaymentSessionProcessing(c, result);
    }

    return ok(c, result.hosted);
});

// ─── GET /success ────────────────────────────────────────────────────────────
// Redirect handlers — not OpenAPI routes (external callbacks)

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

function shouldReturnToAccount(c: { req: { query: (key: string) => string | undefined } }): boolean {
    return c.req.query("return_to") === "account" || c.req.query("returnTo") === "account";
}

function buildStorefrontOrderSuccessUrl(
    storefront: string,
    params: {
        orderId: string;
        payment: "polar";
        result?: "cancelled";
        paymentType?: "full" | "deposit" | "balance" | "";
        depositAmount?: string;
    },
): string {
    const url = new URL(`${storefront}/order-success`);
    url.searchParams.set("orderId", params.orderId);
    url.searchParams.set("payment", params.payment);
    if (params.result) url.searchParams.set("result", params.result);
    if (params.paymentType) url.searchParams.set("paymentType", params.paymentType);
    if (params.depositAmount) url.searchParams.set("depositAmount", params.depositAmount);
    return url.toString();
}

function buildStorefrontAccountOrderUrl(
    storefront: string,
    params: {
        orderId: string;
        payment: "polar";
        result?: "cancelled";
        paymentType?: "full" | "deposit" | "balance" | "";
    },
): string {
    const url = new URL(`${storefront}/account/orders/${encodeURIComponent(params.orderId)}`);
    url.searchParams.set("payment", params.payment);
    if (params.result) url.searchParams.set("result", params.result);
    if (params.paymentType) url.searchParams.set("paymentType", params.paymentType);
    return url.toString();
}

async function validateCallbackOrder(db: Pick<Database, "select">, orderId: string, storefrontUrl: string): Promise<string | null> {
    if (!orderId) return null;
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    return order ? null : `${storefrontUrl}/checkout?error=invalid_order`;
}

polarPaymentRoutes.get("/success", async (c) => {
    const orderId = c.req.query("order_id");
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
        if (shouldReturnToAccount(c) && orderId) {
            return c.redirect(buildStorefrontAccountOrderUrl(storefrontUrl, {
                orderId,
                payment: "polar",
                paymentType,
            }));
        }
        return c.redirect(buildStorefrontOrderSuccessUrl(storefrontUrl, {
            orderId: orderId ?? "",
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

    if (storefrontUrl) {
        if (orderId) {
            const db: Database = c.get("db");
            const invalidRedirect = await validateCallbackOrder(db, orderId, storefrontUrl);
            if (invalidRedirect) return c.redirect(invalidRedirect);
        }
        if (shouldReturnToAccount(c) && orderId) {
            return c.redirect(buildStorefrontAccountOrderUrl(storefrontUrl, {
                orderId,
                payment: "polar",
                result: "cancelled",
                paymentType: getCallbackPaymentType(c),
            }));
        }
        return c.redirect(buildStorefrontOrderSuccessUrl(storefrontUrl, {
            orderId,
            payment: "polar",
            result: "cancelled",
            paymentType: getCallbackPaymentType(c),
            depositAmount: getCallbackDepositAmount(c),
        }));
    }

    return c.redirect("/");
});
