import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings, siteSettings } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { eq, sql } from "drizzle-orm";
import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import {
    invalidateApiAndScheduleStorefrontGroups,
    type WaitUntilExecutionContext,
} from "../../../utils/cache-invalidation";
import { successEnvelope, messageResponse, errorResponses, serviceUnavailableResponse } from "../../../schemas/responses";
import {
    getPaymentGatewaySettingsSnapshot,
    getActivePaymentMethods,
    getStripeSettings,
    getStripeCheckoutReadiness,
    isStripePlaceholderCredential,
    getSSLCommerzCheckoutReadiness,
    getSSLCommerzSettings,
    isSSLCommerzPlaceholderCredential,
    getPolarCheckoutReadiness,
    getPolarSettings,
    isPolarPlaceholderCredential,
    isStripeCheckoutUsable,
    isSSLCommerzCheckoutUsable,
    isPolarCheckoutUsable,
} from "@scalius/core/modules/payments/gateway-settings";
import {
    saveSettingAggregate,
    type SettingAggregateWrite,
} from "@scalius/core/modules/settings/settings-write";
import {
    getCheckoutFlowValidationIssues,
    isCheckoutGatewayUsableForFlow,
} from "@scalius/core/modules/settings/checkout-flow";
import {
    filterPaymentGatewayIdsForCurrency,
    getPaymentGatewayCurrencyEligibilityIssue,
} from "@scalius/core/modules/payments/gateway-currency-policy";
import { getCurrencySettings } from "@scalius/core/modules/settings/site-settings.service";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";

const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED = "••••••••••••";
type OnlineGatewayId = "stripe" | "sslcommerz" | "polar";
const GATEWAY_LABELS: Record<OnlineGatewayId, string> = {
    stripe: "Stripe",
    sslcommerz: "SSLCommerz",
    polar: "Polar",
};
const CHECKOUT_CACHE_GROUPS = ["checkout"];

function getSandboxEnvironment(sandbox: boolean): "test" | "live" {
    return sandbox ? "test" : "live";
}

async function invalidateCheckoutCaches(c: { env: Env; executionCtx?: WaitUntilExecutionContext }): Promise<void> {
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

    const [activePaymentMethods, currencySettings] = await Promise.all([
        getActivePaymentMethods(
            db,
            getCredentialEncryptionKey(env as Record<string, unknown>),
        ),
        getCurrencySettings(db),
    ]);
    const nextPaymentMethods = filterPaymentGatewayIdsForCurrency(
        activePaymentMethods.enabledMethods.filter((method) => method !== gatewayId),
        currencySettings.currencyCode,
    );
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
    enabledMethods: z.array(z.enum(["stripe", "sslcommerz", "polar", "cod"]))
        .min(1, "At least one payment method is required")
        .max(4)
        .refine((methods) => new Set(methods).size === methods.length, "Payment methods must be unique"),
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

function effectivePlaceholderAwareSecretValue(
    submitted: string | undefined,
    stored: string | undefined,
    isPlaceholder: (value: unknown) => boolean,
): string {
    if (submitted === undefined || submitted === MASKED || submitted.trim() === "") {
        if (isPlaceholder(stored)) return stored?.trim() ?? "";
        return storedMarker(stored);
    }
    return submitted.trim();
}

function effectiveSSLCommerzSecretValue(submitted: string | undefined, stored: string | undefined): string {
    if (submitted === undefined || submitted === MASKED || submitted.trim() === "") {
        if (isSSLCommerzPlaceholderCredential(stored)) return stored?.trim() ?? "";
        return storedMarker(stored);
    }
    return submitted.trim();
}

function effectivePlainValue(submitted: string | undefined, stored: string | undefined): string {
    if (submitted === undefined || submitted === MASKED) return stored ?? "";
    return submitted.trim();
}

function getEffectiveStripeCheckoutSettings(
    map: StripeSettingsMap,
    body: SaveStripeInput,
    storedSettings?: Awaited<ReturnType<typeof getStripeSettings>>,
) {
    const existingEnabled = map.enabled !== undefined
        ? map.enabled !== "false"
        : Boolean(map.secret_key && map.webhook_secret && map.publishable_key);
    const submittedSecretKey = body.secretKey && body.secretKey !== MASKED
        ? body.secretKey.trim()
        : "";
    const submittedWebhookSecret = body.webhookSecret && body.webhookSecret !== MASKED
        ? body.webhookSecret.trim()
        : "";

    return {
        secretKey: submittedSecretKey
            ? submittedSecretKey
            : (storedSettings?.secretKey ?? effectivePlaceholderAwareSecretValue(
                body.secretKey,
                map.secret_key,
                isStripePlaceholderCredential,
            )),
        publishableKey: effectivePlainValue(
            body.publishableKey,
            storedSettings?.publishableKey ?? map.publishable_key,
        ),
        webhookSecret: submittedWebhookSecret
            ? submittedWebhookSecret
            : (storedSettings?.webhookSecret ?? effectivePlaceholderAwareSecretValue(
                body.webhookSecret,
                map.webhook_secret,
                isStripePlaceholderCredential,
            )),
        enabled: body.enabled ?? existingEnabled,
        credentialErrors: storedSettings?.credentialErrors,
    };
}

function getEffectiveSSLCommerzCheckoutSettings(
    map: SSLCommerzSettingsMap,
    body: z.infer<typeof saveSSLCommerzSchema>,
    storedSettings?: Awaited<ReturnType<typeof getSSLCommerzSettings>>,
) {
    const existingEnabled = map.enabled !== undefined
        ? map.enabled !== "false"
        : hasStoredSSLCommerzAccount(map);
    const hasSubmittedStorePassword = Boolean(
        body.storePassword &&
        body.storePassword !== MASKED &&
        body.storePassword.trim(),
    );

    return {
        storeId: effectivePlainValue(body.storeId, storedSettings?.storeId ?? map.store_id),
        storePassword: hasSubmittedStorePassword
            ? body.storePassword!.trim()
            : (storedSettings?.storePassword || effectiveSSLCommerzSecretValue(body.storePassword, map.store_password)),
        sandbox: body.sandbox ?? map.sandbox !== "false",
        enabled: body.enabled ?? existingEnabled,
        credentialErrors: storedSettings?.credentialErrors,
    };
}

function getEffectivePolarCheckoutSettings(map: PolarSettingsMap, body: z.infer<typeof savePolarSchema>) {
    const existingEnabled = map.enabled !== undefined
        ? map.enabled !== "false"
        : hasStoredPolarAccount(map);

    return {
        accessToken: effectivePlaceholderAwareSecretValue(body.accessToken, map.access_token, isPolarPlaceholderCredential),
        webhookSecret: effectivePlaceholderAwareSecretValue(body.webhookSecret, map.webhook_secret, isPolarPlaceholderCredential),
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
    environment: z.enum(["test", "live", "mixed", "unknown", "not_applicable"]).optional(),
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
    operationId: "dashboard.payments.methods_get",
    tags: ["Admin - Settings"],
    summary: "Get active payment methods",
    responses: {
        200: { description: "Payment methods config", content: { "application/json": { schema: successEnvelope(paymentMethodsResponseSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getPaymentMethodsRoute, async (c) => {
    const db = c.get("db");
    const encKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const gatewaySnapshot = await getPaymentGatewaySettingsSnapshot(db, encKey);
    const rawConfig = gatewaySnapshot.preferences;
    const activeConfig = gatewaySnapshot.activePaymentMethods;
    const { stripe: stripeSettings, sslcommerz: sslSettings, polar: polarSettings } =
        gatewaySnapshot.settings;

    const [stripeMap, sslMap, polarMap, checkoutSettings, currencySettings] = await Promise.all([
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
        getCurrencySettings(db),
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
        const currencyActiveMethods = filterPaymentGatewayIdsForCurrency(
            activeConfig.enabledMethods,
            currencySettings.currencyCode,
        );
        const flowActiveMethods = currencyActiveMethods.filter((method) =>
            isCheckoutGatewayUsableForFlow({
                gatewayId: method,
                checkoutMode: flowSettings.checkoutMode,
                partialPaymentEnabled: flowSettings.partialPaymentEnabled,
                partialPaymentAmount: flowSettings.partialPaymentAmount,
            }),
        );
        const flowDefaultMethod = flowActiveMethods.includes(activeConfig.defaultMethod)
            ? activeConfig.defaultMethod
            : flowActiveMethods[0];
        const sslCurrencyIssue = getPaymentGatewayCurrencyEligibilityIssue(
            "sslcommerz",
            currencySettings.currencyCode,
        );

        return ok(c, {
            enabledMethods: rawConfig.enabledMethods,
            defaultMethod: rawConfig.enabledMethods.includes(rawConfig.defaultMethod)
                ? rawConfig.defaultMethod
                : (rawConfig.enabledMethods[0] ?? "cod"),
            activeMethods: flowActiveMethods,
            ...(flowDefaultMethod ? { activeDefaultMethod: flowDefaultMethod } : {}),
            gatewayStatus: {
                stripe: {
                    ...stripeReadiness,
                    environment: getStripeCredentialEnvironment(stripeSettings ?? {
                        secretKey: stripeMap.secret_key ?? "",
                        publishableKey: stripeMap.publishable_key ?? "",
                    }),
                    providerEnabled: stripeReadiness.enabled,
                    checkoutSelected: rawConfig.enabledMethods.includes("stripe"),
                    checkoutVisible: flowActiveMethods.includes("stripe"),
                },
                sslcommerz: {
                    ...sslReadiness,
                    usable: sslReadiness.usable && !sslCurrencyIssue,
                    blockedReason: sslCurrencyIssue ?? sslReadiness.blockedReason,
                    environment: getSandboxEnvironment(sslSettings?.sandbox ?? sslMap.sandbox !== "false"),
                    providerEnabled: sslReadiness.enabled,
                    checkoutSelected: rawConfig.enabledMethods.includes("sslcommerz"),
                    checkoutVisible: flowActiveMethods.includes("sslcommerz"),
                },
                polar: {
                    ...polarReadiness,
                    environment: getSandboxEnvironment(polarSettings?.sandbox ?? polarMap.sandbox !== "false"),
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
                    environment: "not_applicable" as const,
                }
            }
        });
});

const savePaymentMethodsRoute = createRoute({
    method: "post",
    path: "/payment-methods",
    operationId: "dashboard.payments.methods_update",
    tags: ["Admin - Settings"],
    summary: "Save payment methods configuration",
    request: { body: { required: true, content: { "application/json": { schema: updateMethodsSchema } } } },
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

    const encKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const [stripeSettings, sslSettings, polarSettings, currencySettings] = await Promise.all([
        getStripeSettings(db, encKey),
        getSSLCommerzSettings(db, encKey),
        getPolarSettings(db, encKey),
        getCurrencySettings(db),
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
    const sslCurrencyIssue = getPaymentGatewayCurrencyEligibilityIssue(
        "sslcommerz",
        currencySettings.currencyCode,
    );
    if (data.enabledMethods.includes("sslcommerz") && sslCurrencyIssue) {
        throw new ValidationError(sslCurrencyIssue);
    }
    if (data.enabledMethods.includes("polar") && !polarReadiness.usable) {
        throw new ValidationError(polarReadiness.blockedReason ?? "Polar is not ready for checkout.");
    }
    const credentialUsableMethods = data.enabledMethods.filter((method) => {
        if (method === "cod") return true;
        if (method === "stripe") return isStripeCheckoutUsable(stripeSettings);
        if (method === "sslcommerz") return isSSLCommerzCheckoutUsable(sslSettings);
        if (method === "polar") return isPolarCheckoutUsable(polarSettings);
        return false;
    });
    const usableMethods = filterPaymentGatewayIdsForCurrency(
        credentialUsableMethods,
        currencySettings.currencyCode,
    );

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

    await invalidateCheckoutCaches(c);

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
    operationId: "dashboard.payments.stripe_get",
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
    operationId: "dashboard.payments.stripe_update",
    tags: ["Admin - Settings"],
    summary: "Save Stripe settings",
    request: { body: { required: true, content: { "application/json": { schema: saveStripeSchema } } } },
    responses: {
        200: { description: "Stripe settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveStripeRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const writes: SettingAggregateWrite[] = [];
        const configuredEncryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
        const [existingMap, storedSettings] = await Promise.all([
            readStripeSettingsMap(db),
            getStripeSettings(db, configuredEncryptionKey),
        ]);
        const effectiveSettings = getEffectiveStripeCheckoutSettings(existingMap, body, storedSettings);
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

        if (body.secretKey && body.secretKey !== MASKED && body.secretKey.trim()) writes.push({ category: "stripe", key: "secret_key", value: body.secretKey.trim(), encrypted: true });
        if (body.publishableKey !== undefined && body.publishableKey !== MASKED) writes.push({ category: "stripe", key: "publishable_key", value: body.publishableKey.trim() });
        if (body.webhookSecret && body.webhookSecret !== MASKED && body.webhookSecret.trim()) writes.push({ category: "stripe", key: "webhook_secret", value: body.webhookSecret.trim(), encrypted: true });
        if (body.enabled !== undefined) writes.push({ category: "stripe", key: "enabled", value: String(body.enabled) });

        await saveSettingAggregate(db, writes, encKey);

        await invalidateCheckoutCaches(c);

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
    operationId: "dashboard.payments.sslcommerz_get",
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
    operationId: "dashboard.payments.sslcommerz_update",
    tags: ["Admin - Settings"],
    summary: "Save SSLCommerz settings",
    request: { body: { required: true, content: { "application/json": { schema: saveSSLCommerzSchema } } } },
    responses: {
        200: { description: "SSLCommerz settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveSSLCommerzRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const writes: SettingAggregateWrite[] = [];
        const existingMap = await readSSLCommerzSettingsMap(db);
        const storedSettings = await getSSLCommerzSettings(
            db,
            getCredentialEncryptionKey(c.env as Record<string, unknown>),
        );
        const effectiveSettings = getEffectiveSSLCommerzCheckoutSettings(existingMap, body, storedSettings);
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

        if (body.storeId && body.storeId.trim()) writes.push({ category: "sslcommerz", key: "store_id", value: body.storeId.trim() });
        if (body.storePassword && body.storePassword !== MASKED && body.storePassword.trim()) writes.push({ category: "sslcommerz", key: "store_password", value: body.storePassword.trim(), encrypted: true });
        if (body.sandbox !== undefined) writes.push({ category: "sslcommerz", key: "sandbox", value: String(body.sandbox) });
        if (body.enabled !== undefined) writes.push({ category: "sslcommerz", key: "enabled", value: String(body.enabled) });

        await saveSettingAggregate(db, writes, encKey);

        await invalidateCheckoutCaches(c);

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
    operationId: "dashboard.payments.polar_get",
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
    operationId: "dashboard.payments.polar_update",
    tags: ["Admin - Settings"],
    summary: "Save Polar settings",
    request: { body: { required: true, content: { "application/json": { schema: savePolarSchema } } } },
    responses: {
        200: { description: "Polar settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(savePolarRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const writes: SettingAggregateWrite[] = [];
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

        if (body.accessToken && body.accessToken !== MASKED && body.accessToken.trim()) writes.push({ category: "polar", key: "access_token", value: body.accessToken.trim(), encrypted: true });
        if (body.webhookSecret && body.webhookSecret !== MASKED && body.webhookSecret.trim()) writes.push({ category: "polar", key: "webhook_secret", value: body.webhookSecret.trim(), encrypted: true });
        if (body.productId && body.productId.trim()) writes.push({ category: "polar", key: "product_id", value: body.productId.trim() });
        if (body.sandbox !== undefined) writes.push({ category: "polar", key: "sandbox", value: String(body.sandbox) });
        if (body.enabled !== undefined) writes.push({ category: "polar", key: "enabled", value: String(body.enabled) });

        await saveSettingAggregate(db, writes, encKey);

        await invalidateCheckoutCaches(c);

        return ok(c, { message: "Polar settings saved successfully" });
});

export { app as paymentSettingsRoutes };
