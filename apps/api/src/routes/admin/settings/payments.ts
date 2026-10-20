import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";

import { successEnvelope, conflictResponse, errorResponses, serviceUnavailableResponse } from "../../../schemas/responses";
import {
    BUILT_IN_PAYMENT_GATEWAY_IDS,
    BUILT_IN_PAYMENT_PROVIDERS,
    getPaymentGatewaySettingsSnapshot,
    getActivePaymentMethods,
    getPaymentMethodPreferences,
    getStripeSettings,
    getStripeCheckoutReadiness,
    COD_COUNTRIES,
    COD_PAYMENT_METHOD,
    isAppPaymentMethod,
    isPaymentMethodId,
    paymentMethodLabel,
    publicAmountLimits,
    type GatewaySettings,
    type PaymentProviders,
} from "@scalius/core/modules/payments";
import { isQualifiedProviderId, parseQualifiedProviderId, qualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { readPluginInstallations } from "@scalius/core/modules/plugins";
import { requestPaymentProviders } from "../../../plugins/providers/payment";
import {
    checkoutDocument,
    paymentMethodsDocument,
    stripeDocument,
    type StripeSettingsDocument,
    getCurrencySettings,
} from "@scalius/core/modules/settings";
import { writeSettingsDocuments } from "@scalius/core/settings-store";
import { getCheckoutFlowValidationIssues, isCheckoutGatewayUsableForFlow } from "@scalius/core/modules/checkout";
import { readSegmentDefinitions } from "@scalius/core/modules/customers";
import { NET_TERMS_PAYMENT_METHOD, netTermsNamesAnyone, netTermsSettingsSchema } from "@scalius/shared/payment-terms";

const NET_TERMS_NOBODY_MESSAGE = "Choose who may pay by invoice: a customer tag, a segment, or let apps decide.";

const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED = "••••••••••••";
const revisionSchema = z.number().int().nonnegative();
/** A save answers with the document revision the next save must send back. */
const savedRevisionResponse = successEnvelope(z.object({ message: z.string(), revision: revisionSchema }));

async function assertDisablingGatewayKeepsCheckoutFlow(
    db: Database,
    env: Env,
    gatewayId: string,
    providers: PaymentProviders = BUILT_IN_PAYMENT_PROVIDERS,
): Promise<void> {
    const encryptionKey = getCredentialEncryptionKey(env as Record<string, unknown>);
    const [checkoutSettings, activePaymentMethods, currencySettings] = await Promise.all([
        checkoutDocument.read(db),
        getActivePaymentMethods(db, encryptionKey, providers),
        getCurrencySettings(db),
    ]);
    const nextPaymentMethods = providers.filterForCurrency(
        activePaymentMethods.enabledMethods.filter((method) => method !== gatewayId),
        currencySettings.currencyCode,
    );
    const checkoutFlowIssues = getCheckoutFlowValidationIssues({
        checkoutMode: checkoutSettings.checkoutMode,
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        partialPaymentAmount: checkoutSettings.partialPaymentAmount,
        availablePaymentMethods: nextPaymentMethods,
        paymentProviders: providers,
    });

    if (checkoutFlowIssues.length > 0) {
        throw new ValidationError(
            `Cannot disable ${providers.label(gatewayId)} because it would leave checkout without a compatible payment method. ${checkoutFlowIssues.join(" ")}`,
        );
    }
}

/**
 * Whether a saved method still has an installed app behind it. An app's
 * method stays saved while its app is installed (deactivated, or its feature
 * off: checkout skips it and it comes back with the app). Once the app is
 * removed, or no longer declares that provider (bKash moved from
 * `scalius.bkash` into the Bangladesh pack), the id is an orphan: it is left
 * out of what the dashboard reads and of the next save, so it never shows as
 * on or blocks a save. The installations are read only when an app method is
 * saved; an app whose manifest this release can't read keeps its methods.
 */
async function installedAppMethods(db: Database, ids: readonly string[]): Promise<(id: string) => boolean> {
    if (!ids.some(isAppPaymentMethod)) return () => true;
    const { installations, unreadable } = await readPluginInstallations(db);
    const declared = new Set(installations.flatMap((installation) => installation.manifest.providers
        .filter((provider) => provider.kind === "payment")
        .map((provider) => qualifiedProviderId(installation.pluginId, provider.id))));
    const unreadableApps = new Set(unreadable.map((installation) => installation.pluginId));
    return (id) => {
        const app = parseQualifiedProviderId(id);
        return !app || declared.has(id) || unreadableApps.has(app.pluginId);
    };
}

// ─────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────
/** `cod`, a built-in gateway id or an app provider's `<plugin id>:<provider id>`. */
const paymentMethodIdSchema = z.string().max(160).refine(isPaymentMethodId, "Unknown payment method");
const updateMethodsSchema = z.object({
    enabledMethods: z.array(paymentMethodIdSchema)
        .min(1, "At least one payment method is required")
        .max(20)
        .refine((methods) => new Set(methods).size === methods.length, "Payment methods must be unique"),
    defaultMethod: paymentMethodIdSchema,
    expectedRevision: revisionSchema,
    /**
     * The invoice (`net_terms`): its net days and who may pay by it (customer
     * tags, segments, or an app's decision). Omitted: the saved settings stay.
     */
    netTerms: netTermsSettingsSchema.optional(),
});

const saveStripeSchema = z.object({
    expectedRevision: revisionSchema,
    secretKey: z.string().optional(),
    publishableKey: z.string().optional(),
    webhookSecret: z.string().optional(),
    enabled: z.boolean().optional(),
    showAtCheckout: z.literal(true).optional().openapi({
        description: "With enabled: also offers Stripe at checkout, written in the same batch as the keys (the dashboard switch's Turn on is one save).",
    }),
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
    /** The delivery countries the method serves ("any" for every country); cash on delivery serves only Bangladesh. */
    countries: z.union([z.literal("any"), z.array(z.string())]).optional(),
});

/** A gateway the merchant can offer: built in, or an active app's provider. */
const paymentGatewaySchema = z.object({
    id: z.string(),
    label: z.string(),
    checkoutName: z.string(),
    flow: z.enum(["card", "hosted", "deferred"]),
    /** The app that provides it; null for a built-in gateway. */
    pluginId: z.string().nullable(),
    supportsRefund: z.boolean(),
    chargeCurrencies: z.union([z.literal("any"), z.array(z.string())]),
    /** The delivery countries it serves ("any" for every country). */
    countries: z.union([z.literal("any"), z.array(z.string())]),
    /** Provider charge limits in major units (an advance payment must fit them), when it has any. */
    amountLimits: z.object({ currency: z.string(), min: z.number(), max: z.number() }).optional(),
});

const paymentMethodsResponseSchema = z.object({
    enabledMethods: z.array(z.string()),
    defaultMethod: z.string(),
    /** The invoice's net days and who may pay by it (used while `net_terms` is enabled). */
    netTerms: netTermsSettingsSchema,
    revision: revisionSchema,
    activeMethods: z.array(z.string()).optional(),
    activeDefaultMethod: z.string().optional(),
    /** Every gateway the store can offer now (built in first, then app providers). */
    gateways: z.array(paymentGatewaySchema),
    /** Keyed by payment method id: every gateway plus cod (app providers under their qualified ids). */
    gatewayStatus: z.object(Object.fromEntries(
        [...BUILT_IN_PAYMENT_GATEWAY_IDS, COD_PAYMENT_METHOD, NET_TERMS_PAYMENT_METHOD].map((id) => [id, gatewayStatusSchema]),
    )).catchall(gatewayStatusSchema),
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
    const providers = await requestPaymentProviders(c);
    const gatewaySnapshot = await getPaymentGatewaySettingsSnapshot(db, encKey, providers);
    const installed = await installedAppMethods(db, gatewaySnapshot.preferences.enabledMethods);
    const rawConfig = {
        ...gatewaySnapshot.preferences,
        enabledMethods: gatewaySnapshot.preferences.enabledMethods.filter(installed),
    };
    const activeConfig = gatewaySnapshot.activePaymentMethods;
    const savedSettings = gatewaySnapshot.settings as unknown as Record<string, GatewaySettings | null | undefined>;

    const [checkoutSettings, currencySettings, { revision }] = await Promise.all([
        checkoutDocument.read(db),
        getCurrencySettings(db),
        paymentMethodsDocument.readDetailed(db),
    ]);

    const flowActiveMethods = providers.filterForCurrency(
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
    for (const gateway of providers.gateways) {
        // Built-in settings come with the snapshot; an app gateway loads its own.
        const settings = savedSettings[gateway.id]
            ?? (isQualifiedProviderId(gateway.id) ? await gateway.loadSettings(db, encKey) : null);
        const readiness = gateway.readiness(settings);
        const currencyIssue = providers.currencyIssue(gateway.id, currencySettings.currencyCode);
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
        countries: COD_COUNTRIES === "any" ? "any" : [...COD_COUNTRIES],
        ...selection(COD_PAYMENT_METHOD),
    };
    // The invoice is ready once it names who may pay by it.
    const invoiceNamesAnyone = netTermsNamesAnyone(rawConfig.netTerms);
    gatewayStatus[NET_TERMS_PAYMENT_METHOD] = {
        configured: invoiceNamesAnyone,
        enabled: true,
        usable: invoiceNamesAnyone,
        missingFields: invoiceNamesAnyone ? [] : ["netTerms.customerTags"],
        ...(invoiceNamesAnyone ? {} : { blockedReason: NET_TERMS_NOBODY_MESSAGE }),
        providerEnabled: true,
        environment: "not_applicable",
        ...selection(NET_TERMS_PAYMENT_METHOD),
    };

    return ok(c, {
        enabledMethods: rawConfig.enabledMethods,
        netTerms: rawConfig.netTerms,
        defaultMethod: rawConfig.enabledMethods.includes(rawConfig.defaultMethod)
            ? rawConfig.defaultMethod
            : (rawConfig.enabledMethods[0] ?? COD_PAYMENT_METHOD),
        revision,
        activeMethods: flowActiveMethods,
        ...(flowDefaultMethod ? { activeDefaultMethod: flowDefaultMethod } : {}),
        gateways: providers.gateways.map((gateway) => ({
            id: gateway.id,
            label: gateway.label,
            checkoutName: gateway.checkoutName,
            flow: gateway.flow,
            pluginId: parseQualifiedProviderId(gateway.id)?.pluginId ?? null,
            supportsRefund: gateway.supportsRefund,
            chargeCurrencies: gateway.chargeCurrencies === "any" ? "any" as const : [...gateway.chargeCurrencies],
            countries: providers.countries(gateway.id) === "any" ? "any" as const : [...providers.countries(gateway.id) as readonly string[]],
            ...(publicAmountLimits(gateway) ? { amountLimits: publicAmountLimits(gateway) } : {}),
        })),
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

    const encKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const [currencySettings, saved] = await Promise.all([getCurrencySettings(db), getPaymentMethodPreferences(db)]);
    const savedMethods = new Set(saved.enabledMethods);
    // A saved method whose app was removed is dropped (see `installedAppMethods`).
    const installed = await installedAppMethods(db, data.enabledMethods.filter((method) => savedMethods.has(method)));
    const enabledMethods = data.enabledMethods.filter((method) => !savedMethods.has(method) || installed(method));
    if (!enabledMethods.includes(data.defaultMethod)) {
        throw new ValidationError("Default method must be one of the enabled methods");
    }
    // App gateways are read only when the merchant selects one.
    const providers = await requestPaymentProviders(c, enabledMethods.find(isAppPaymentMethod) ?? COD_PAYMENT_METHOD);
    const readyMethods: string[] = [];
    const netTerms = data.netTerms ?? saved.netTerms;
    for (const method of enabledMethods) {
        if (method === COD_PAYMENT_METHOD) {
            readyMethods.push(method);
            continue;
        }
        // The invoice must name who may pay by it, and its segments must exist.
        if (method === NET_TERMS_PAYMENT_METHOD) {
            if (!netTermsNamesAnyone(netTerms)) throw new ValidationError(NET_TERMS_NOBODY_MESSAGE, { issues: [{ path: ["netTerms", "customerTags"], message: NET_TERMS_NOBODY_MESSAGE }] });
            readyMethods.push(method);
            continue;
        }
        // Turning a method on, or making it the default, needs it ready. One
        // already saved that can't take payments now (its app deactivated, its
        // feature off) stays saved, is skipped by checkout until it is ready
        // again, and never blocks another change.
        const strict = !savedMethods.has(method) || method === data.defaultMethod;
        const gateway = strict ? providers.require(method) : providers.get(method);
        const readiness = gateway ? gateway.readiness(await gateway.loadSettings(db, encKey)) : null;
        const currencyIssue = providers.currencyIssue(method, currencySettings.currencyCode);
        if (gateway && readiness?.usable && !currencyIssue) {
            readyMethods.push(method);
            continue;
        }
        if (!strict) continue;
        throw new ValidationError(
            (readiness?.usable ? currencyIssue : readiness?.blockedReason) ?? `${gateway?.label ?? method} is not ready for checkout.`,
        );
    }
    const usableMethods = readyMethods;

    const checkoutSettings = await checkoutDocument.read(db);
    const checkoutFlowIssues = getCheckoutFlowValidationIssues({
        checkoutMode: checkoutSettings.checkoutMode,
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        partialPaymentAmount: checkoutSettings.partialPaymentAmount,
        availablePaymentMethods: usableMethods,
        paymentProviders: providers,
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

    if (data.netTerms && data.netTerms.segmentIds.length > 0) {
        const definitions = await readSegmentDefinitions(db, data.netTerms.segmentIds);
        const missing = data.netTerms.segmentIds.filter((id) => !definitions.get(id));
        if (missing.length > 0) {
            throw new ValidationError("A chosen segment no longer exists. Choose another.", { issues: [{ path: ["netTerms", "segmentIds"], message: `Unknown segment: ${missing.join(", ")}` }] });
        }
    }

    const { revision } = await paymentMethodsDocument.write(db, {
        enabledMethods,
        defaultMethod: data.defaultMethod,
        ...(data.netTerms ? { netTerms: data.netTerms } : {}),
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
            // Another method that keeps checkout working may be an app's (SSLCommerz, bKash).
            await assertDisablingGatewayKeepsCheckoutFlow(db, c.env, "stripe", await requestPaymentProviders(c));
        }

        const patch: Partial<StripeSettingsDocument> = {
            secretKey: submittedSecret(body.secretKey),
            publishableKey: body.publishableKey !== undefined && body.publishableKey !== MASKED
                ? body.publishableKey.trim()
                : undefined,
            webhookSecret: submittedSecret(body.webhookSecret),
            enabled: body.enabled,
        };
        if (body.showAtCheckout && body.enabled !== true) {
            throw new ValidationError("Stripe can be offered at checkout only while it is turned on.");
        }
        const methods = body.showAtCheckout ? await paymentMethodsDocument.readDetailed(db, undefined, { skipCache: true }) : null;
        // An unreadable selection offers nothing at checkout; the merchant fixes it in Payments, never this save.
        if (methods?.invalid) {
            throw new ValidationError("The checkout payment methods could not be read. Choose them again in Payments, then offer Stripe.");
        }
        // Never saved: cash on delivery is the implied method, and stays beside Stripe.
        const enabledMethods = methods?.value.enabledMethods ?? ["cod"];
        if (methods && !enabledMethods.includes("stripe")) {
            const currencyIssue = (await requestPaymentProviders(c)).currencyIssue("stripe", (await getCurrencySettings(db)).currencyCode);
            if (currencyIssue) throw new ValidationError(currencyIssue);
        }
        const [written] = await writeSettingsDocuments(db, [
            { document: stripeDocument, patch, ctx: { encryptionKey: encKey }, expectedRevision: body.expectedRevision },
            ...(methods && !enabledMethods.includes("stripe")
                ? [{
                    document: paymentMethodsDocument,
                    patch: { enabledMethods: [...enabledMethods, "stripe"], defaultMethod: methods.value.defaultMethod },
                    expectedRevision: methods.revision,
                }]
                : []),
        ]);

        return ok(c, { message: "Stripe settings saved successfully", revision: written!.revision });
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
    gatewayId: "stripe",
    expectedRevision: number,
    providers: PaymentProviders,
): Promise<number> {
    await assertDisablingGatewayKeepsCheckoutFlow(db, env, gatewayId, providers);
    const methods = await paymentMethodsDocument.readDetailed(db);
    const selected = methods.value.enabledMethods;
    const remaining = selected?.filter((method) => method !== gatewayId) ?? null;
    const [written] = await writeSettingsDocuments(db, [
        { document: stripeDocument, patch: { secretKey: "", publishableKey: "", webhookSecret: "", enabled: false }, expectedRevision },
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

for (const gateway of ["stripe"] as const) {
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
        const revision = await removeGatewayKeys(c.get("db"), c.env, gateway, expectedRevision, await requestPaymentProviders(c));

        return ok(c, { message: `${label} keys removed`, revision });
    });
}

export { app as paymentSettingsRoutes };
