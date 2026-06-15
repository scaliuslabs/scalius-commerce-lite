import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { getKv } from "../../../utils/kv-cache";
import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import { getEncryptionKey } from "../../../utils/encryption-key";
import {
    invalidateApiAndScheduleStorefrontGroups,
} from "../../../utils/cache-invalidation";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
import {
    upsertSetting,
    upsertEncryptedSetting,
    getActivePaymentMethods,
    getStripeSettings,
    getSSLCommerzSettings,
    getPolarSettings,
    invalidatePaymentMethodsCache,
    invalidateStripeCache,
    invalidateSSLCommerzCache,
    invalidatePolarCache
} from "@scalius/core/modules/payments/gateway-settings";

const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED = "••••••••••••";
const CHECKOUT_CACHE_GROUPS = ["checkout"];

async function invalidateCheckoutCaches(c: { env: Env; executionCtx?: ExecutionContext }): Promise<void> {
    await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
}

// ─────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────
const updateMethodsSchema = z.object({
    enabledMethods: z.array(z.enum(["stripe", "sslcommerz", "polar", "cod"])).min(1, "At least one payment method is required"),
    defaultMethod: z.enum(["stripe", "sslcommerz", "polar", "cod"])
});

const saveStripeSchema = z.object({
    secretKey: z.string().optional(),
    publishableKey: z.string().optional(),
    webhookSecret: z.string().optional(),
    enabled: z.boolean().optional()
});

const saveSSLCommerzSchema = z.object({
    storeId: z.string().optional(),
    storePassword: z.string().optional(),
    sandbox: z.boolean().optional(),
    enabled: z.boolean().optional()
});

const savePolarSchema = z.object({
    accessToken: z.string().optional(),
    webhookSecret: z.string().optional(),
    productId: z.string().optional(),
    sandbox: z.boolean().optional(),
    enabled: z.boolean().optional()
});

const gatewayStatusSchema = z.object({
    configured: z.boolean(),
    enabled: z.boolean(),
});

const paymentMethodsResponseSchema = z.object({
    enabledMethods: z.array(z.string()),
    defaultMethod: z.string(),
    gatewayStatus: z.object({
        stripe: gatewayStatusSchema,
        sslcommerz: gatewayStatusSchema,
        polar: gatewayStatusSchema,
        cod: gatewayStatusSchema,
    }),
}).passthrough();

const getPaymentMethodsRoute = createRoute({
    method: "get",
    path: "/payment-methods",
    tags: ["Admin - Settings"],
    summary: "Get active payment methods",
    responses: {
        200: { description: "Payment methods config", content: { "application/json": { schema: successEnvelope(paymentMethodsResponseSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getPaymentMethodsRoute, async (c) => {
    const db = c.get("db");
        const kv = getKv();
        const encKey = getEncryptionKey(c.env as Record<string, unknown>);
        const config = await getActivePaymentMethods(db, kv, encKey);

        const [stripeSettings, sslSettings, polarSettings] = await Promise.all([
            getStripeSettings(db, undefined, encKey),
            getSSLCommerzSettings(db, undefined, encKey),
            getPolarSettings(db, undefined, encKey),
        ]);

        return ok(c, {
            ...config,
            gatewayStatus: {
                stripe: { configured: !!stripeSettings, enabled: stripeSettings?.enabled ?? false },
                sslcommerz: { configured: !!sslSettings, enabled: sslSettings?.enabled ?? false },
                polar: { configured: !!polarSettings, enabled: polarSettings?.enabled ?? false },
                cod: { configured: true, enabled: true }
            }
        });
});

const savePaymentMethodsRoute = createRoute({
    method: "post",
    path: "/payment-methods",
    tags: ["Admin - Settings"],
    summary: "Save payment methods configuration",
    request: { body: { content: { "application/json": { schema: updateMethodsSchema } } } },
    responses: {
        200: { description: "Payment methods saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(savePaymentMethodsRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");

    if (!data.enabledMethods.includes(data.defaultMethod)) {
        throw new ValidationError("Default method must be one of the enabled methods");
    }

    await Promise.all([
        upsertSetting(db, "payment_methods", "enabled_methods", JSON.stringify(data.enabledMethods)),
        upsertSetting(db, "payment_methods", "default_method", data.defaultMethod),
    ]);

    const kv = getKv();
    await Promise.all([
        invalidatePaymentMethodsCache(kv),
        invalidateCheckoutCaches(c),
    ]);

    return ok(c, { message: "Payment methods updated" });
});

// ─────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────

const stripeSettingsResponseSchema = z.object({
    secretKey: z.string(),
    publishableKey: z.string(),
    webhookSecret: z.string(),
    enabled: z.boolean(),
});

const getStripeRoute = createRoute({
    method: "get",
    path: "/stripe",
    tags: ["Admin - Settings"],
    summary: "Get Stripe settings",
    responses: {
        200: { description: "Stripe settings", content: { "application/json": { schema: successEnvelope(stripeSettingsResponseSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getStripeRoute, async (c) => {
    const db = c.get("db");
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "stripe")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return ok(c, {
            secretKey: map.secret_key ? MASKED : "",
            publishableKey: map.publishable_key ?? "",
            webhookSecret: map.webhook_secret ? MASKED : "",
            enabled: map.enabled !== "false"
        });
});

const saveStripeRoute = createRoute({
    method: "post",
    path: "/stripe",
    tags: ["Admin - Settings"],
    summary: "Save Stripe settings",
    request: { body: { content: { "application/json": { schema: saveStripeSchema } } } },
    responses: {
        200: { description: "Stripe settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveStripeRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const encKey = getEncryptionKey(c.env as Record<string, unknown>);
        const ops: Promise<void>[] = [];

        if (body.secretKey && body.secretKey !== MASKED && body.secretKey.trim()) ops.push(upsertEncryptedSetting(db, "stripe", "secret_key", body.secretKey.trim(), encKey));
        if (body.publishableKey !== undefined && body.publishableKey !== MASKED) ops.push(upsertSetting(db, "stripe", "publishable_key", body.publishableKey.trim()));
        if (body.webhookSecret && body.webhookSecret !== MASKED && body.webhookSecret.trim()) ops.push(upsertEncryptedSetting(db, "stripe", "webhook_secret", body.webhookSecret.trim(), encKey));
        if (body.enabled !== undefined) ops.push(upsertSetting(db, "stripe", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([
            invalidateStripeCache(kv),
            invalidatePaymentMethodsCache(kv),
            invalidateCheckoutCaches(c),
        ]);

        return ok(c, { message: "Stripe settings saved successfully" });
});

// ─────────────────────────────────────────
// SSLCOMMERZ
// ─────────────────────────────────────────

const sslCommerzSettingsResponseSchema = z.object({
    storeId: z.string(),
    storePassword: z.string(),
    sandbox: z.boolean(),
    enabled: z.boolean(),
});

const getSSLCommerzRoute = createRoute({
    method: "get",
    path: "/sslcommerz",
    tags: ["Admin - Settings"],
    summary: "Get SSLCommerz settings",
    responses: {
        200: { description: "SSLCommerz settings", content: { "application/json": { schema: successEnvelope(sslCommerzSettingsResponseSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getSSLCommerzRoute, async (c) => {
    const db = c.get("db");
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "sslcommerz")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return ok(c, {
            storeId: map.store_id ?? "",
            storePassword: map.store_password ? MASKED : "",
            sandbox: map.sandbox !== "false",
            enabled: map.enabled !== "false"
        });
});

const saveSSLCommerzRoute = createRoute({
    method: "post",
    path: "/sslcommerz",
    tags: ["Admin - Settings"],
    summary: "Save SSLCommerz settings",
    request: { body: { content: { "application/json": { schema: saveSSLCommerzSchema } } } },
    responses: {
        200: { description: "SSLCommerz settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveSSLCommerzRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const encKey = getEncryptionKey(c.env as Record<string, unknown>);
        const ops: Promise<void>[] = [];

        if (body.storeId && body.storeId.trim()) ops.push(upsertSetting(db, "sslcommerz", "store_id", body.storeId.trim()));
        if (body.storePassword && body.storePassword !== MASKED && body.storePassword.trim()) ops.push(upsertEncryptedSetting(db, "sslcommerz", "store_password", body.storePassword.trim(), encKey));
        if (body.sandbox !== undefined) ops.push(upsertSetting(db, "sslcommerz", "sandbox", String(body.sandbox)));
        if (body.enabled !== undefined) ops.push(upsertSetting(db, "sslcommerz", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([
            invalidateSSLCommerzCache(kv),
            invalidatePaymentMethodsCache(kv),
            invalidateCheckoutCaches(c),
        ]);

        return ok(c, { message: "SSLCommerz settings saved successfully" });
});

// ─────────────────────────────────────────
// POLAR
// ─────────────────────────────────────────

const polarSettingsResponseSchema = z.object({
    accessToken: z.string(),
    webhookSecret: z.string(),
    productId: z.string(),
    sandbox: z.boolean(),
    enabled: z.boolean(),
});

const getPolarRoute = createRoute({
    method: "get",
    path: "/polar",
    tags: ["Admin - Settings"],
    summary: "Get Polar settings",
    responses: {
        200: { description: "Polar settings", content: { "application/json": { schema: successEnvelope(polarSettingsResponseSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getPolarRoute, async (c) => {
    const db = c.get("db");
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "polar")).all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        return ok(c, {
            accessToken: map.access_token ? MASKED : "",
            webhookSecret: map.webhook_secret ? MASKED : "",
            productId: map.product_id ?? "",
            sandbox: map.sandbox !== "false",
            enabled: map.enabled !== "false"
        });
});

const savePolarRoute = createRoute({
    method: "post",
    path: "/polar",
    tags: ["Admin - Settings"],
    summary: "Save Polar settings",
    request: { body: { content: { "application/json": { schema: savePolarSchema } } } },
    responses: {
        200: { description: "Polar settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(savePolarRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const encKey = getEncryptionKey(c.env as Record<string, unknown>);
        const ops: Promise<void>[] = [];

        if (body.accessToken && body.accessToken !== MASKED && body.accessToken.trim()) ops.push(upsertEncryptedSetting(db, "polar", "access_token", body.accessToken.trim(), encKey));
        if (body.webhookSecret && body.webhookSecret !== MASKED && body.webhookSecret.trim()) ops.push(upsertEncryptedSetting(db, "polar", "webhook_secret", body.webhookSecret.trim(), encKey));
        if (body.productId && body.productId.trim()) ops.push(upsertSetting(db, "polar", "product_id", body.productId.trim()));
        if (body.sandbox !== undefined) ops.push(upsertSetting(db, "polar", "sandbox", String(body.sandbox)));
        if (body.enabled !== undefined) ops.push(upsertSetting(db, "polar", "enabled", String(body.enabled)));

        await Promise.all(ops);

        const kv = getKv();
        await Promise.all([
            invalidatePolarCache(kv),
            invalidatePaymentMethodsCache(kv),
            invalidateCheckoutCaches(c),
        ]);

        return ok(c, { message: "Polar settings saved successfully" });
});

export { app as paymentSettingsRoutes };
