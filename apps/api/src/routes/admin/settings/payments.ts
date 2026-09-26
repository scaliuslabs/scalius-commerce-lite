import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";

import { successEnvelope, conflictResponse, errorResponses, serviceUnavailableResponse } from "../../../schemas/responses";
import {
    getPaymentGatewaySettingsSnapshot,
    getActivePaymentMethods,
    getStripeSettings,
    getStripeCheckoutReadiness,
    getSSLCommerzCheckoutReadiness,
    getSSLCommerzSettings,
    COD_PAYMENT_METHOD,
    filterPaymentMethodsForCurrency,
    getPaymentMethodCurrencyIssue,
    listPaymentGateways,
    listPaymentMethodIds,
    paymentMethodLabel,
    requirePaymentGateway,
    type GatewaySettings,
} from "@scalius/core/modules/payments";
import {
    checkoutDocument,
    paymentMethodsDocument,
    sslcommerzDocument,
    stripeDocument,
    type SSLCommerzSettingsDocument,
    type StripeSettingsDocument,
    getCheckoutFlowValidationIssues,
    isCheckoutGatewayUsableForFlow,
    getCurrencySettings,
    writeSettingsDocuments,
} from "@scalius/core/modules/settings";

const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED = "••••••••••••";
const revisionSchema = z.number().int().nonnegative();
/** A save answers with the document revision the next save must send back. */
const savedRevisionResponse = successEnvelope(z.object({ message: z.string(), revision: revisionSchema }));

async function assertDisablingGatewayKeepsCheckoutFlow(
    db: Database,
    env: Env,
    gatewayId: string,
): Promise<void> {
    const [checkoutSettings, activePaymentMethods, currencySettings] = await Promise.all([
        checkoutDocument.read(db),
        getActivePaymentMethods(
            db,
            getCredentialEncryptionKey(env as Record<string, unknown>),
        ),
        getCurrencySettings(db),
    ]);
    const nextPaymentMethods = filterPaymentMethodsForCurrency(
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
            `Cannot disable ${paymentMethodLabel(gatewayId)} because it would leave checkout without a compatible payment method. ${checkoutFlowIssues.join(" ")}`,
        );
    }
}

// ─────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────
const paymentMethodIdSchema = z.enum(listPaymentMethodIds() as [string, ...string[]]);
const updateMethodsSchema = z.object({
    enabledMethods: z.array(paymentMethodIdSchema)
        .min(1, "At least one payment method is required")
        .max(listPaymentMethodIds().length)
        .refine((methods) => new Set(methods).size === methods.length, "Payment methods must be unique"),
    defaultMethod: paymentMethodIdSchema,
    expectedRevision: revisionSchema,
});

const saveStripeSchema = z.object({
    expectedRevision: revisionSchema,
    secretKey: z.string().optional(),
    publishableKey: z.string().optional(),
    webhookSecret: z.string().optional(),
    enabled: z.boolean().optional()
});

const saveSSLCommerzSchema = z.object({
    expectedRevision: revisionSchema,
    storeId: z.string().optional(),
    storePassword: z.string().optional(),
    sandbox: z.boolean().optional(),
    enabled: z.boolean().optional()
});

type SaveStripeInput = z.infer<typeof saveStripeSchema>;

/**
 * Keys may be saved a few at a time while a gateway stays off; turning it on
 * needs every key. Missing keys are named against their fields.
 */
function assertGatewayCanTurnOn(label: string, readiness: {
    enabled: boolean;
    configured: boolean;
    missingFields: readonly string[];
    credentialErrors?: string[];
    blockedReason?: string;
}): void {
    if (!readiness.enabled || readiness.configured) return;
    const message = readiness.blockedReason ?? `${label} is not ready for checkout.`;
    const missing = readiness.credentialErrors?.length ? [] : readiness.missingFields;
    throw new ValidationError(
        message,
        missing.length ? { issues: missing.map((field) => ({ path: [field], message })) } : undefined,
    );
}

function submittedSecret(value: string | undefined): string | undefined {
    return value && value !== MASKED && value.trim() ? value.trim() : undefined;
}

/** A secret is shown as stored even when this request cannot decrypt it. */
function maskedSecret(
    stored: { value: object; secretErrors: Partial<Record<string, string>> },
    field: string,
): string {
    return (stored.value as Record<string, unknown>)[field] || stored.secretErrors[field] ? MASKED : "";
}

function getEffectiveStripeCheckoutSettings(
    body: SaveStripeInput,
    storedSettings: Awaited<ReturnType<typeof getStripeSettings>>,
) {
    return {
        secretKey: submittedSecret(body.secretKey) ?? storedSettings?.secretKey ?? "",
        publishableKey: body.publishableKey === undefined || body.publishableKey === MASKED
            ? storedSettings?.publishableKey ?? ""
            : body.publishableKey.trim(),
        webhookSecret: submittedSecret(body.webhookSecret) ?? storedSettings?.webhookSecret ?? "",
        enabled: body.enabled ?? storedSettings?.enabled ?? false,
        credentialErrors: storedSettings?.credentialErrors,
    };
}

function getEffectiveSSLCommerzCheckoutSettings(
    body: z.infer<typeof saveSSLCommerzSchema>,
    storedSettings: Awaited<ReturnType<typeof getSSLCommerzSettings>>,
) {
    return {
        storeId: body.storeId === undefined || body.storeId === MASKED
            ? storedSettings?.storeId ?? ""
            : body.storeId.trim(),
        storePassword: submittedSecret(body.storePassword) ?? storedSettings?.storePassword ?? "",
        sandbox: body.sandbox ?? storedSettings?.sandbox ?? true,
        enabled: body.enabled ?? storedSettings?.enabled ?? false,
        credentialErrors: storedSettings?.credentialErrors,
    };
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
    revision: revisionSchema,
    activeMethods: z.array(z.string()).optional(),
    activeDefaultMethod: z.string().optional(),
    /** Keyed by payment method id: every registered gateway plus cod. */
    gatewayStatus: z.object(Object.fromEntries(listPaymentMethodIds().map((id) => [id, gatewayStatusSchema]))),
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
    const savedSettings = gatewaySnapshot.settings as unknown as Record<string, GatewaySettings | null | undefined>;

    const [checkoutSettings, currencySettings, { revision }] = await Promise.all([
        checkoutDocument.read(db),
        getCurrencySettings(db),
        paymentMethodsDocument.readDetailed(db),
    ]);

    const flowActiveMethods = filterPaymentMethodsForCurrency(
        activeConfig.enabledMethods,
        currencySettings.currencyCode,
    ).filter((method) =>
        isCheckoutGatewayUsableForFlow({
            gatewayId: method,
            checkoutMode: checkoutSettings?.checkoutMode ?? "all",
            partialPaymentEnabled: checkoutSettings?.partialPaymentEnabled ?? false,
            partialPaymentAmount: checkoutSettings?.partialPaymentAmount ?? 0,
        }),
    );
    const flowDefaultMethod = flowActiveMethods.includes(activeConfig.defaultMethod)
        ? activeConfig.defaultMethod
        : flowActiveMethods[0];
    const selection = (method: string) => ({
        checkoutSelected: (rawConfig.enabledMethods as readonly string[]).includes(method),
        checkoutVisible: flowActiveMethods.includes(method),
    });

    const gatewayStatus: Record<string, z.infer<typeof gatewayStatusSchema>> = {};
    for (const gateway of listPaymentGateways()) {
        const settings = savedSettings[gateway.id] ?? null;
        const readiness = gateway.readiness(settings);
        const currencyIssue = getPaymentMethodCurrencyIssue(gateway.id, currencySettings.currencyCode);
        gatewayStatus[gateway.id] = {
            ...readiness,
            usable: readiness.usable && !currencyIssue,
            blockedReason: currencyIssue ?? readiness.blockedReason,
            environment: gateway.environment(settings),
            providerEnabled: readiness.enabled,
            ...selection(gateway.id),
        };
    }
    gatewayStatus[COD_PAYMENT_METHOD] = {
        configured: true,
        enabled: true,
        usable: true,
        missingFields: [],
        providerEnabled: true,
        environment: "not_applicable",
        ...selection(COD_PAYMENT_METHOD),
    };

    return ok(c, {
        enabledMethods: rawConfig.enabledMethods,
        defaultMethod: rawConfig.enabledMethods.includes(rawConfig.defaultMethod)
            ? rawConfig.defaultMethod
            : (rawConfig.enabledMethods[0] ?? COD_PAYMENT_METHOD),
        revision,
        activeMethods: flowActiveMethods,
        ...(flowDefaultMethod ? { activeDefaultMethod: flowDefaultMethod } : {}),
        gatewayStatus,
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
        200: { description: "Payment methods saved", content: { "application/json": { schema: savedRevisionResponse } } },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(savePaymentMethodsRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");

    if (!data.enabledMethods.includes(data.defaultMethod)) {
        throw new ValidationError("Default method must be one of the enabled methods");
    }

    const encKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const currencySettings = await getCurrencySettings(db);
    for (const method of data.enabledMethods) {
        if (method === COD_PAYMENT_METHOD) continue;
        const gateway = requirePaymentGateway(method);
        const readiness = gateway.readiness(await gateway.loadSettings(db, encKey));
        if (!readiness.usable) {
            throw new ValidationError(readiness.blockedReason ?? `${gateway.label} is not ready for checkout.`);
        }
        const currencyIssue = getPaymentMethodCurrencyIssue(method, currencySettings.currencyCode);
        if (currencyIssue) throw new ValidationError(currencyIssue);
    }
    const usableMethods = filterPaymentMethodsForCurrency(data.enabledMethods, currencySettings.currencyCode);

    const checkoutSettings = await checkoutDocument.read(db);
    const checkoutFlowIssues = getCheckoutFlowValidationIssues({
        checkoutMode: checkoutSettings.checkoutMode,
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        partialPaymentAmount: checkoutSettings.partialPaymentAmount,
        availablePaymentMethods: usableMethods,
    });
    if (checkoutFlowIssues.length > 0) {
        throw new ValidationError(checkoutFlowIssues.join(" "));
    }
    if (!isCheckoutGatewayUsableForFlow({
        gatewayId: data.defaultMethod,
        checkoutMode: checkoutSettings.checkoutMode,
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        partialPaymentAmount: checkoutSettings.partialPaymentAmount,
    })) {
        throw new ValidationError("Default method is hidden by the current checkout flow settings.");
    }

    const { revision } = await paymentMethodsDocument.write(db, {
        enabledMethods: data.enabledMethods,
        defaultMethod: data.defaultMethod,
    }, {}, { expectedRevision: data.expectedRevision });

    return ok(c, { message: "Payment methods updated", revision });
});

// ─────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────

const stripeSettingsResponseSchema = z.object({
    revision: revisionSchema,
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
        const stored = await stripeDocument.readDetailed(db);

        return ok(c, {
            revision: stored.revision,
            secretKey: maskedSecret(stored, "secretKey"),
            publishableKey: stored.value.publishableKey,
            webhookSecret: maskedSecret(stored, "webhookSecret"),
            enabled: stored.stored && stored.value.enabled,
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
        200: { description: "Stripe settings saved", content: { "application/json": { schema: savedRevisionResponse } } },
        ...errorResponses,
        409: conflictResponse,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveStripeRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const configuredEncryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
        const storedSettings = await getStripeSettings(db, configuredEncryptionKey);
        const effectiveSettings = getEffectiveStripeCheckoutSettings(body, storedSettings);
        const stripeReadiness = getStripeCheckoutReadiness(effectiveSettings);
        assertGatewayCanTurnOn("Stripe", stripeReadiness);
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

        const patch: Partial<StripeSettingsDocument> = {
            secretKey: submittedSecret(body.secretKey),
            publishableKey: body.publishableKey !== undefined && body.publishableKey !== MASKED
                ? body.publishableKey.trim()
                : undefined,
            webhookSecret: submittedSecret(body.webhookSecret),
            enabled: body.enabled,
        };
        const { revision } = await stripeDocument.write(db, patch, { encryptionKey: encKey }, {
            expectedRevision: body.expectedRevision,
        });

        return ok(c, { message: "Stripe settings saved successfully", revision });
});

// ─────────────────────────────────────────
// SSLCOMMERZ
// ─────────────────────────────────────────

const sslCommerzSettingsResponseSchema = z.object({
    revision: revisionSchema,
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
        const stored = await sslcommerzDocument.readDetailed(db);

        return ok(c, {
            revision: stored.revision,
            storeId: stored.value.storeId,
            storePassword: maskedSecret(stored, "storePassword"),
            sandbox: stored.value.sandbox,
            enabled: stored.stored && stored.value.enabled,
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
        200: { description: "SSLCommerz settings saved", content: { "application/json": { schema: savedRevisionResponse } } },
        ...errorResponses,
        409: conflictResponse,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveSSLCommerzRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const storedSettings = await getSSLCommerzSettings(
            db,
            getCredentialEncryptionKey(c.env as Record<string, unknown>),
        );
        const effectiveSettings = getEffectiveSSLCommerzCheckoutSettings(body, storedSettings);
        const sslReadiness = getSSLCommerzCheckoutReadiness(effectiveSettings);
        assertGatewayCanTurnOn("SSLCommerz", sslReadiness);
        const hasSecretWrite = Boolean(body.storePassword && body.storePassword !== MASKED && body.storePassword.trim());
        const encKey = hasSecretWrite
            ? requireEncryptionKey(c.env as Record<string, unknown>)
            : undefined;

        if (body.enabled === false) {
            await assertDisablingGatewayKeepsCheckoutFlow(db, c.env, "sslcommerz");
        }

        const patch: Partial<SSLCommerzSettingsDocument> = {
            storeId: body.storeId?.trim() || undefined,
            storePassword: submittedSecret(body.storePassword),
            sandbox: body.sandbox,
            enabled: body.enabled,
        };
        const { revision } = await sslcommerzDocument.write(db, patch, { encryptionKey: encKey }, {
            expectedRevision: body.expectedRevision,
        });

        return ok(c, { message: "SSLCommerz settings saved successfully", revision });
});

// ─────────────────────────────────────────
// REMOVE KEYS (Shopify/Stripe apps: Disconnect)
// ─────────────────────────────────────────

const removeKeysSchema = z.object({ expectedRevision: revisionSchema });

/**
 * Deletes every stored credential of a gateway and turns it off, and takes it
 * out of the checkout selection in the same batch. Refused, like turning it
 * off, when checkout would be left without a payment method.
 */
async function removeGatewayKeys(
    db: Database,
    env: Env,
    gatewayId: "stripe" | "sslcommerz",
    expectedRevision: number,
): Promise<number> {
    await assertDisablingGatewayKeepsCheckoutFlow(db, env, gatewayId);
    const methods = await paymentMethodsDocument.readDetailed(db);
    const selected = methods.value.enabledMethods;
    const remaining = selected?.filter((method) => method !== gatewayId) ?? null;
    const [written] = await writeSettingsDocuments(db, [
        gatewayId === "stripe"
            ? { document: stripeDocument, patch: { secretKey: "", publishableKey: "", webhookSecret: "", enabled: false }, expectedRevision }
            : { document: sslcommerzDocument, patch: { storeId: "", storePassword: "", sandbox: true, enabled: false }, expectedRevision },
        ...(remaining && remaining.length !== selected!.length
            ? [{
                document: paymentMethodsDocument,
                patch: {
                    enabledMethods: remaining,
                    defaultMethod: remaining.includes(methods.value.defaultMethod)
                        ? methods.value.defaultMethod
                        : remaining[0] ?? COD_PAYMENT_METHOD,
                },
                expectedRevision: methods.revision,
            }]
            : []),
    ]);
    return written!.revision;
}

for (const gateway of ["stripe", "sslcommerz"] as const) {
    const label = paymentMethodLabel(gateway);
    app.openapi(createRoute({
        method: "delete",
        path: `/${gateway}`,
        operationId: `dashboard.payments.${gateway}_remove`,
        tags: ["Admin - Settings"],
        summary: `Remove the saved ${label} keys and turn ${label} off`,
        request: { body: { required: true, content: { "application/json": { schema: removeKeysSchema } } } },
        responses: {
            200: { description: `${label} keys removed`, content: { "application/json": { schema: savedRevisionResponse } } },
            ...errorResponses,
            409: conflictResponse,
        },
    }), async (c) => {
        const { expectedRevision } = c.req.valid("json");
        const revision = await removeGatewayKeys(c.get("db"), c.env, gateway, expectedRevision);

        return ok(c, { message: `${label} keys removed`, revision });
    });
}

export { app as paymentSettingsRoutes };
