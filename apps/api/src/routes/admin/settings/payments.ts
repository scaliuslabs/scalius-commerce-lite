import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings, siteSettings } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { eq, sql } from "drizzle-orm";
import { getKv } from "../../../utils/kv-cache";
import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import {
    invalidateApiAndScheduleStorefrontGroups,
} from "../../../utils/cache-invalidation";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
import {
    upsertSetting,
    upsertEncryptedSetting,
    getPaymentMethodPreferences,
    getActivePaymentMethods,
    getStripeSettings,
    getStripeCheckoutReadiness,
    getSSLCommerzCheckoutReadiness,
    getSSLCommerzSettings,
    getPolarCheckoutReadiness,
    getPolarSettings,
    isStripeCheckoutUsable,
    isSSLCommerzCheckoutUsable,
    isPolarCheckoutUsable,
    invalidatePaymentMethodsCache,
    invalidateStripeCache,
    invalidateSSLCommerzCache,
    invalidatePolarCache
} from "@scalius/core/modules/payments/gateway-settings";
import {
    getCheckoutFlowValidationIssues,
    isCheckoutGatewayUsableForFlow,
} from "@scalius/core/modules/settings/checkout-flow";

const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED = "••••••••••••";
type OnlineGatewayId = "stripe" | "sslcommerz" | "polar";
const GATEWAY_LABELS: Record<OnlineGatewayId, string> = {
    stripe: "Stripe",
    sslcommerz: "SSLCommerz",
    polar: "Polar",
};
const CHECKOUT_CACHE_GROUPS = ["checkout"];

async function invalidateCheckoutCaches(c: { env: Env; executionCtx?: ExecutionContext }): Promise<void> {
    await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
}

async function assertDisablingGatewayKeepsCheckoutFlow(
    db: Database,
    env: Env,
    gatewayId: OnlineGatewayId,
): Promise<void> {
    const [checkoutSettings] = await db
        .select({
            checkoutMode: siteSettings.checkoutMode,
            partialPaymentEnabled: siteSettings.partialPaymentEnabled,
            partialPaymentAmount: siteSettings.partialPaymentAmount,
        })
        .from(siteSettings)
        .limit(1);

    if (!checkoutSettings) return;

    const activePaymentMethods = await getActivePaymentMethods(
        db,
        getKv(),
        getCredentialEncryptionKey(env as Record<string, unknown>),
        { bypassMemoryCache: true },
    );
    const nextPaymentMethods = activePaymentMethods.enabledMethods.filter((method) => method !== gatewayId);
    const checkoutFlowIssues = getCheckoutFlowValidationIssues({
        checkoutMode: checkoutSettings.checkoutMode,
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        partialPaymentAmount: checkoutSettings.partialPaymentAmount,
        availablePaymentMethods: nextPaymentMethods,
    });

    if (checkoutFlowIssues.length > 0) {
        throw new ValidationError(
            `Cannot disable ${GATEWAY_LABELS[gatewayId]} because it would leave checkout without a compatible payment method. ${checkoutFlowIssues.join(" ")}`,
        );
    }
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

type SaveStripeInput = z.infer<typeof saveStripeSchema>;
type StripeSettingsMap = Record<string, string | undefined>;
type SSLCommerzSettingsMap = Record<string, string | undefined>;
type PolarSettingsMap = Record<string, string | undefined>;

async function readSettingsMap(db: Database, category: string): Promise<Record<string, string | undefined>> {
    const rows = await db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(eq(settings.category, category))
        .all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function readStripeSettingsMap(db: Database): Promise<StripeSettingsMap> {
    return readSettingsMap(db, "stripe");
}

async function readSSLCommerzSettingsMap(db: Database): Promise<SSLCommerzSettingsMap> {
    return readSettingsMap(db, "sslcommerz");
}

async function readPolarSettingsMap(db: Database): Promise<PolarSettingsMap> {
    return readSettingsMap(db, "polar");
}

function hasStoredSSLCommerzAccount(map: SSLCommerzSettingsMap): boolean {
    return Boolean(map.store_id?.trim() && map.store_password?.trim());
}

function hasStoredPolarAccount(map: PolarSettingsMap): boolean {
    return Boolean(map.access_token?.trim() && map.product_id?.trim());
}

function storedMarker(value: string | undefined): string {
    return value?.trim() ? "__stored__" : "";
}

function effectiveSecretValue(submitted: string | undefined, stored: string | undefined): string {
    if (submitted === undefined || submitted === MASKED || submitted.trim() === "") {
        return storedMarker(stored);
    }
    return submitted.trim();
}

function effectivePlainValue(submitted: string | undefined, stored: string | undefined): string {
    if (submitted === undefined || submitted === MASKED) return stored ?? "";
    return submitted.trim();
}

function getEffectiveStripeCheckoutSettings(map: StripeSettingsMap, body: SaveStripeInput) {
    const existingEnabled = map.enabled !== undefined
        ? map.enabled !== "false"
        : Boolean(map.secret_key && map.webhook_secret && map.publishable_key);

    return {
        secretKey: effectiveSecretValue(body.secretKey, map.secret_key),
        publishableKey: effectivePlainValue(body.publishableKey, map.publishable_key),
        webhookSecret: effectiveSecretValue(body.webhookSecret, map.webhook_secret),
        enabled: body.enabled ?? existingEnabled,
    };
}

function getEffectiveSSLCommerzCheckoutSettings(map: SSLCommerzSettingsMap, body: z.infer<typeof saveSSLCommerzSchema>) {
    const existingEnabled = map.enabled !== undefined
        ? map.enabled !== "false"
        : hasStoredSSLCommerzAccount(map);

    return {
        storeId: effectivePlainValue(body.storeId, map.store_id),
        storePassword: effectiveSecretValue(body.storePassword, map.store_password),
        sandbox: body.sandbox ?? map.sandbox !== "false",
        enabled: body.enabled ?? existingEnabled,
    };
}

function getEffectivePolarCheckoutSettings(map: PolarSettingsMap, body: z.infer<typeof savePolarSchema>) {
    const existingEnabled = map.enabled !== undefined
        ? map.enabled !== "false"
        : hasStoredPolarAccount(map);

    return {
        accessToken: effectiveSecretValue(body.accessToken, map.access_token),
        webhookSecret: effectiveSecretValue(body.webhookSecret, map.webhook_secret),
        productId: effectivePlainValue(body.productId, map.product_id),
        sandbox: body.sandbox ?? map.sandbox !== "false",
        enabled: body.enabled ?? existingEnabled,
    };
}

function buildUpsertSettingStatement(db: Database, category: string, key: string, value: string) {
    return db
        .insert(settings)
        .values({
            id: crypto.randomUUID(),
            key,
            value,
            type: "string",
            category,
        })
        .onConflictDoUpdate({
            target: [settings.key, settings.category],
            set: { value, updatedAt: sql`unixepoch()` },
        });
}

const gatewayStatusSchema = z.object({
    configured: z.boolean(),
    enabled: z.boolean(),
    usable: z.boolean().optional(),
    missingFields: z.array(z.string()).optional(),
    credentialErrors: z.array(z.string()).optional(),
    blockedReason: z.string().optional(),
    providerEnabled: z.boolean().optional(),
    checkoutSelected: z.boolean().optional(),
    checkoutVisible: z.boolean().optional(),
});

const paymentMethodsResponseSchema = z.object({
    enabledMethods: z.array(z.string()),
    defaultMethod: z.string(),
    activeMethods: z.array(z.string()).optional(),
    activeDefaultMethod: z.string().optional(),
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
        const encKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
        const readOptions = { bypassMemoryCache: true };
        const [rawConfig, activeConfig] = await Promise.all([
            getPaymentMethodPreferences(db),
            getActivePaymentMethods(db, kv, encKey, readOptions),
        ]);

        const [
            stripeSettings,
            sslSettings,
            polarSettings,
            stripeMap,
            sslMap,
            polarMap,
            checkoutSettings,
        ] = await Promise.all([
            getStripeSettings(db, kv, encKey, readOptions),
            getSSLCommerzSettings(db, kv, encKey, readOptions),
            getPolarSettings(db, kv, encKey, readOptions),
            readStripeSettingsMap(db),
            readSSLCommerzSettingsMap(db),
            readPolarSettingsMap(db),
            db
                .select({
                    checkoutMode: siteSettings.checkoutMode,
                    partialPaymentEnabled: siteSettings.partialPaymentEnabled,
                    partialPaymentAmount: siteSettings.partialPaymentAmount,
                })
                .from(siteSettings)
                .limit(1)
                .then((rows) => rows[0]),
        ]);
        const stripeReadiness = getStripeCheckoutReadiness(
            stripeSettings ?? getEffectiveStripeCheckoutSettings(stripeMap, {}),
        );
        const sslReadiness = getSSLCommerzCheckoutReadiness(sslSettings ?? {
            storeId: sslMap.store_id ?? "",
            storePassword: storedMarker(sslMap.store_password),
            enabled: sslMap.enabled !== undefined ? sslMap.enabled !== "false" : hasStoredSSLCommerzAccount(sslMap),
        });
        const polarReadiness = getPolarCheckoutReadiness(polarSettings ?? {
            accessToken: storedMarker(polarMap.access_token),
            productId: polarMap.product_id ?? "",
            webhookSecret: storedMarker(polarMap.webhook_secret),
            enabled: polarMap.enabled !== undefined ? polarMap.enabled !== "false" : hasStoredPolarAccount(polarMap),
        });

        const flowSettings = {
            checkoutMode: checkoutSettings?.checkoutMode ?? "all",
            partialPaymentEnabled: checkoutSettings?.partialPaymentEnabled ?? false,
            partialPaymentAmount: checkoutSettings?.partialPaymentAmount ?? 0,
        };
        const flowActiveMethods = activeConfig.enabledMethods.filter((method) =>
            isCheckoutGatewayUsableForFlow({
                gatewayId: method,
                checkoutMode: flowSettings.checkoutMode,
                partialPaymentEnabled: flowSettings.partialPaymentEnabled,
                partialPaymentAmount: flowSettings.partialPaymentAmount,
            }),
        );
        const flowDefaultMethod = flowActiveMethods.includes(activeConfig.defaultMethod)
            ? activeConfig.defaultMethod
            : (flowActiveMethods[0] ?? activeConfig.defaultMethod);

        return ok(c, {
            enabledMethods: rawConfig.enabledMethods,
            defaultMethod: rawConfig.enabledMethods.includes(rawConfig.defaultMethod)
                ? rawConfig.defaultMethod
                : (rawConfig.enabledMethods[0] ?? "cod"),
            activeMethods: flowActiveMethods,
            activeDefaultMethod: flowDefaultMethod,
            gatewayStatus: {
                stripe: {
                    ...stripeReadiness,
                    providerEnabled: stripeReadiness.enabled,
                    checkoutSelected: rawConfig.enabledMethods.includes("stripe"),
                    checkoutVisible: flowActiveMethods.includes("stripe"),
                },
                sslcommerz: {
                    ...sslReadiness,
                    providerEnabled: sslReadiness.enabled,
                    checkoutSelected: rawConfig.enabledMethods.includes("sslcommerz"),
                    checkoutVisible: flowActiveMethods.includes("sslcommerz"),
                },
                polar: {
                    ...polarReadiness,
                    providerEnabled: polarReadiness.enabled,
                    checkoutSelected: rawConfig.enabledMethods.includes("polar"),
                    checkoutVisible: flowActiveMethods.includes("polar"),
                },
                cod: {
                    configured: true,
                    enabled: true,
                    usable: true,
                    missingFields: [],
                    providerEnabled: true,
                    checkoutSelected: rawConfig.enabledMethods.includes("cod"),
                    checkoutVisible: flowActiveMethods.includes("cod"),
                }
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

    const kv = getKv();
    const encKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const readOptions = { bypassMemoryCache: true };
    const [stripeSettings, sslSettings, polarSettings] = await Promise.all([
        getStripeSettings(db, kv, encKey, readOptions),
        getSSLCommerzSettings(db, kv, encKey, readOptions),
        getPolarSettings(db, kv, encKey, readOptions),
    ]);
    const stripeReadiness = getStripeCheckoutReadiness(stripeSettings);
    if (data.enabledMethods.includes("stripe") && !stripeReadiness.usable) {
        throw new ValidationError(stripeReadiness.blockedReason ?? "Stripe is not ready for checkout.");
    }
    const sslReadiness = getSSLCommerzCheckoutReadiness(sslSettings);
    const polarReadiness = getPolarCheckoutReadiness(polarSettings);
    if (data.enabledMethods.includes("sslcommerz") && !sslReadiness.usable) {
        throw new ValidationError(sslReadiness.blockedReason ?? "SSLCommerz is not ready for checkout.");
    }
    if (data.enabledMethods.includes("polar") && !polarReadiness.usable) {
        throw new ValidationError(polarReadiness.blockedReason ?? "Polar is not ready for checkout.");
    }
    const usableMethods = data.enabledMethods.filter((method) => {
        if (method === "cod") return true;
        if (method === "stripe") return isStripeCheckoutUsable(stripeSettings);
        if (method === "sslcommerz") return isSSLCommerzCheckoutUsable(sslSettings);
        if (method === "polar") return isPolarCheckoutUsable(polarSettings);
        return false;
    });

    const [checkoutSettings] = await db
        .select({
            checkoutMode: siteSettings.checkoutMode,
            partialPaymentEnabled: siteSettings.partialPaymentEnabled,
            partialPaymentAmount: siteSettings.partialPaymentAmount,
        })
        .from(siteSettings)
        .limit(1);
    const checkoutFlowIssues = getCheckoutFlowValidationIssues({
        checkoutMode: checkoutSettings?.checkoutMode,
        partialPaymentEnabled: checkoutSettings?.partialPaymentEnabled ?? false,
        partialPaymentAmount: checkoutSettings?.partialPaymentAmount ?? 0,
        availablePaymentMethods: usableMethods,
    });
    if (checkoutFlowIssues.length > 0) {
        throw new ValidationError(checkoutFlowIssues.join(" "));
    }
    if (!isCheckoutGatewayUsableForFlow({
        gatewayId: data.defaultMethod,
        checkoutMode: checkoutSettings?.checkoutMode,
        partialPaymentEnabled: checkoutSettings?.partialPaymentEnabled ?? false,
        partialPaymentAmount: checkoutSettings?.partialPaymentAmount ?? 0,
    })) {
        throw new ValidationError("Default method is hidden by the current checkout flow settings.");
    }

    await safeBatch(db, [
        buildUpsertSettingStatement(db, "payment_methods", "enabled_methods", JSON.stringify(data.enabledMethods)),
        buildUpsertSettingStatement(db, "payment_methods", "default_method", data.defaultMethod),
    ]);

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
        const map = await readStripeSettingsMap(db);
        const storedEnabled = map.enabled !== undefined
            ? map.enabled !== "false"
            : Boolean(map.secret_key && map.webhook_secret && map.publishable_key);

        return ok(c, {
            secretKey: map.secret_key ? MASKED : "",
            publishableKey: map.publishable_key ?? "",
            webhookSecret: map.webhook_secret ? MASKED : "",
            enabled: storedEnabled
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
        const ops: Promise<void>[] = [];
        const existingMap = await readStripeSettingsMap(db);
        const effectiveSettings = getEffectiveStripeCheckoutSettings(existingMap, body);
        const stripeReadiness = getStripeCheckoutReadiness(effectiveSettings);
        if (stripeReadiness.enabled && !stripeReadiness.configured) {
            throw new ValidationError(stripeReadiness.blockedReason ?? "Stripe is not ready for checkout.");
        }
        const hasSecretWrite = Boolean(
            (body.secretKey && body.secretKey !== MASKED && body.secretKey.trim()) ||
            (body.webhookSecret && body.webhookSecret !== MASKED && body.webhookSecret.trim()),
        );
        const encKey = hasSecretWrite
            ? requireEncryptionKey(c.env as Record<string, unknown>)
            : undefined;

        if (body.enabled === false) {
            await assertDisablingGatewayKeepsCheckoutFlow(db, c.env, "stripe");
        }

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
            enabled: map.enabled !== undefined ? map.enabled !== "false" : hasStoredSSLCommerzAccount(map)
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
        const ops: Promise<void>[] = [];
        const existingMap = await readSSLCommerzSettingsMap(db);
        const effectiveSettings = getEffectiveSSLCommerzCheckoutSettings(existingMap, body);
        const sslReadiness = getSSLCommerzCheckoutReadiness(effectiveSettings);
        if (sslReadiness.enabled && !sslReadiness.configured) {
            throw new ValidationError(sslReadiness.blockedReason ?? "SSLCommerz is not ready for checkout.");
        }
        const hasSecretWrite = Boolean(body.storePassword && body.storePassword !== MASKED && body.storePassword.trim());
        const encKey = hasSecretWrite
            ? requireEncryptionKey(c.env as Record<string, unknown>)
            : undefined;

        if (body.enabled === false) {
            await assertDisablingGatewayKeepsCheckoutFlow(db, c.env, "sslcommerz");
        }

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
            enabled: map.enabled !== undefined ? map.enabled !== "false" : hasStoredPolarAccount(map)
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
        const ops: Promise<void>[] = [];
        const existingMap = await readPolarSettingsMap(db);
        const effectiveSettings = getEffectivePolarCheckoutSettings(existingMap, body);
        const polarReadiness = getPolarCheckoutReadiness(effectiveSettings);
        if (polarReadiness.enabled && !polarReadiness.configured) {
            throw new ValidationError(polarReadiness.blockedReason ?? "Polar is not ready for checkout.");
        }
        const hasSecretWrite = Boolean(
            (body.accessToken && body.accessToken !== MASKED && body.accessToken.trim()) ||
            (body.webhookSecret && body.webhookSecret !== MASKED && body.webhookSecret.trim()),
        );
        const encKey = hasSecretWrite
            ? requireEncryptionKey(c.env as Record<string, unknown>)
            : undefined;

        if (body.enabled === false) {
            await assertDisablingGatewayKeepsCheckoutFlow(db, c.env, "polar");
        }

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
