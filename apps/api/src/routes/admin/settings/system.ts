import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import {
    getEmailProviderReadiness,
    getEmailRuntimeSettings,
} from "@scalius/core/integrations/email";
import { getSmsProviderReadiness } from "@scalius/core/integrations/sms";
import {
    normalizeFirebaseServiceAccountJson,
    readFirebaseSettings,
} from "@scalius/core/integrations/firebase/settings";
import {
    firstWhatsAppPlaceholderConfigError,
    getWhatsAppCloudApiSettings,
} from "@scalius/core/integrations/whatsapp";
import { getActivePaymentMethods, filterPaymentMethodsForCurrency } from "@scalius/core/modules/payments";
import {
    CUSTOMER_AUTH_CONTACT_FIELDS,
    CUSTOMER_AUTH_METHODS,
    CUSTOMER_AUTH_OTP_CHANNELS,
    customerAuthPolicyUsesEmailProvider,
    customerAuthPolicyUsesSmsProvider,
    customerAuthPolicyUsesWhatsAppProvider,
    getCustomerAuthPolicyForMethod,
    normalizeCustomerAuthMethod,
    normalizeCustomerAuthPolicy,
} from "@scalius/shared/customer-auth-policy";
import {
    getCheckoutFlowSettingsDocument,
    saveCheckoutFlowSettingsDocument,
    SettingsRevisionConflictError,
    selectSettingsDocuments,
    writeSettingsDocuments,
    type SettingsDocumentWriteRequest,
    getCurrencySettings,
    customerAuthDocument,
    emailDocument,
    firebaseDocument,
    securityDocument,
    whatsappDocument,
    type EmailSettings,
    type FirebaseSettings,
    type WhatsAppSettings,
    CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE,
    getCheckoutReadiness,
    getCustomerSignInReadiness,
} from "@scalius/core/modules/settings";
import { bumpCacheGeneration } from "../../../utils/cache-generation";
import { buildClearNotificationProviderBlocksStatement } from "@scalius/core/modules/notifications";
import {
    normalizeMerchantCspSource,
    normalizePlatformOrigin,
    parseMerchantCspSources,
    serializeMerchantCspSources,
    type CspSourceProblem,
} from "@scalius/shared/security-csp";

import { ok } from "../../../utils/api-response";
import { ValidationError } from "../../../utils/api-error";
import {
    conflictResponse,
    successEnvelope,
    errorResponses,
    serviceUnavailableResponse,
} from "../../../schemas/responses";
import { readinessSchema } from "../../../schemas/readiness";
import { isReady, type Readiness } from "@scalius/shared/readiness";

const app = new OpenAPIHono<{ Bindings: Env }>();

/** A save that changes a document must say which revision of it the editor loaded. */
function requireExpectedRevision(value: number | undefined, field: string): number {
    if (value === undefined) {
        throw new ValidationError(`expectedRevision.${field} is required to change these settings.`);
    }
    return value;
}
const MASKED = "••••••••••••";
const MERCHANT_CSP_INPUT_MAX_LENGTH = 65_536;
const MERCHANT_CSP_ORIGIN_MAX_LENGTH = 512;
const MERCHANT_CSP_SOURCE_MAX_COUNT = 100;
const MERCHANT_CSP_OUTPUT_MAX_LENGTH =
    MERCHANT_CSP_SOURCE_MAX_COUNT * MERCHANT_CSP_ORIGIN_MAX_LENGTH +
    (MERCHANT_CSP_SOURCE_MAX_COUNT - 1);
const INHERITED_SECURITY_ORIGIN_MAX_LENGTH = 2_048;
const PROVIDER_STATUS_ERROR_MAX_LENGTH = 1_000;
const WHATSAPP_ACCESS_TOKEN_MAX_LENGTH = 2_048;
const WHATSAPP_PHONE_NUMBER_ID_MAX_LENGTH = 128;
const WHATSAPP_TEMPLATE_NAME_MAX_LENGTH = 128;
const EMAIL_API_KEY_MAX_LENGTH = 512;
const EMAIL_SENDER_MAX_LENGTH = 320;

function normalizeStoredMerchantCspSources(
    value: string,
    env?: Record<string, unknown>,
): string {
    const inherited = new Set([
        "STOREFRONT_URL",
        "PUBLIC_API_BASE_URL",
        "BETTER_AUTH_URL",
        "CDN_DOMAIN_URL",
        "R2_PUBLIC_URL",
    ].map((key) => normalizePlatformOrigin(env?.[key])).filter(
        (source): source is string => Boolean(source),
    ));
    return serializeMerchantCspSources(
        parseMerchantCspSources(value)
            .filter(
                (source) =>
                    !inherited.has(source) &&
                    source.length <= MERCHANT_CSP_ORIGIN_MAX_LENGTH,
            )
            .slice(0, MERCHANT_CSP_SOURCE_MAX_COUNT),
    );
}

const CSP_PROBLEM_MESSAGES: Record<CspSourceProblem, string> = {
    https: "Use https.",
    path: "Enter just the site address, without a path.",
    invalid: "Enter a full address like https://chat.example.com.",
};

/** A save refuses (never drops) an entry it can't trust, naming the entry and the fix. */
function assertMerchantCspSourcesValid(value: string): void {
    const entries = value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
    const problems = entries.flatMap((entry) => {
        const { value: source, error } = normalizeMerchantCspSource(entry);
        if (error) return [`${entry}: ${CSP_PROBLEM_MESSAGES[error]}`];
        return source && source.length > MERCHANT_CSP_ORIGIN_MAX_LENGTH
            ? [`${entry}: ${CSP_PROBLEM_MESSAGES.invalid}`]
            : [];
    });
    if (new Set(entries).size > MERCHANT_CSP_SOURCE_MAX_COUNT) {
        problems.push(`Add up to ${MERCHANT_CSP_SOURCE_MAX_COUNT} trusted websites.`);
    }
    if (problems.length > 0) {
        throw new ValidationError(problems.join(" "), {
            issues: problems.map((message) => ({ path: ["cspAllowedDomains"], message })),
        });
    }
}

const inheritedSecuritySourceKindSchema = z.enum([
    "storefront",
    "api",
    "dashboard",
    "media",
]);

const inheritedSecuritySourceSchema = z.object({
    key: z.string(),
    label: z.string(),
    kind: inheritedSecuritySourceKindSchema,
    source: z.string().max(INHERITED_SECURITY_ORIGIN_MAX_LENGTH).nullable(),
    consequence: z.string(),
});

function inheritedSecuritySource(
    key: string,
    label: string,
    kind: z.infer<typeof inheritedSecuritySourceKindSchema>,
    raw: unknown,
    consequence: string,
) {
    const normalizedSource = normalizePlatformOrigin(raw);
    return {
        key,
        label,
        kind,
        source:
            normalizedSource &&
            normalizedSource.length <= INHERITED_SECURITY_ORIGIN_MAX_LENGTH
                ? normalizedSource
                : null,
        consequence,
    };
}

/**
 * Origins the storefront security policy trusts automatically. They are read
 * from the composed runtime env, which the Worker fills from the Platform
 * settings (Settings -> System -> Platform) at request time; they are not
 * Wrangler vars and cannot be edited on the Security page.
 */
export function getInheritedSecuritySources(
    env: Record<string, unknown>,
): Array<z.infer<typeof inheritedSecuritySourceSchema>> {
    return [
        inheritedSecuritySource(
            "storefront",
            "Storefront",
            "storefront",
            env.STOREFRONT_URL,
            "Add the Storefront URL in Settings → Platform.",
        ),
        inheritedSecuritySource(
            "api",
            "Commerce API",
            "api",
            env.PUBLIC_API_BASE_URL,
            "Add the API URL in Settings → Platform.",
        ),
        inheritedSecuritySource(
            "dashboard",
            "Admin dashboard",
            "dashboard",
            env.BETTER_AUTH_URL,
            "Add the Dashboard URL in Settings → Platform.",
        ),
        inheritedSecuritySource(
            "cdn",
            "Canonical media CDN",
            "media",
            env.CDN_DOMAIN_URL,
            "Add the Media URL in Settings → Platform.",
        ),
        inheritedSecuritySource(
            "r2",
            "Public media storage",
            "media",
            env.R2_PUBLIC_URL,
            "Add the Media URL in Settings → Platform.",
        ),
    ];
}

const customerAuthPolicySchema = z.object({
    otpChannels: z.array(z.enum(CUSTOMER_AUTH_OTP_CHANNELS)).min(1).max(3),
    requiredContactFields: z.array(z.enum(CUSTOMER_AUTH_CONTACT_FIELDS)).max(2).optional(),
    optionalContactFields: z.array(z.enum(CUSTOMER_AUTH_CONTACT_FIELDS)).max(2).optional(),
    defaultOtpChannel: z.enum(CUSTOMER_AUTH_OTP_CHANNELS).optional(),
});

/**
 * A provider message is merchant copy from a third party; bound it so one
 * pathological string cannot push the response past the operation ceiling.
 */
function boundedReadiness(value: Readiness): Readiness {
    return {
        status: value.status,
        issues: value.issues.map((issue) => ({
            ...issue,
            message: issue.message.slice(0, PROVIDER_STATUS_ERROR_MAX_LENGTH),
            ...(issue.fix ? { fix: issue.fix.slice(0, PROVIDER_STATUS_ERROR_MAX_LENGTH) } : {}),
        })),
    };
}

const checkoutReadinessResponseSchema = readinessSchema.extend({
    hasActiveShippingMethod: z.boolean(),
    hasActiveDeliveryHierarchy: z.boolean(),
    customerSignInRequired: z.boolean(),
    hasUsableCustomerSignIn: z.boolean(),
});

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────

const getCheckoutReadinessRoute = createRoute({
    method: "get",
    path: "/checkout-readiness",
    operationId: "dashboard.checkout.readiness_get",
    tags: ["Admin - Settings"],
    summary: "Get checkout readiness",
    description: "Check store checkout health, operational readiness, and blocking configuration issues.",
    responses: {
        200: {
            description: "Checkout readiness",
            content: { "application/json": { schema: successEnvelope(checkoutReadinessResponseSchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(getCheckoutReadinessRoute, async (c) => {
    const db = c.get("db");
    return ok(c, await getCheckoutReadiness(db, {
        encryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
        runtimeEnv: c.env as Record<string, unknown>,
        inspectOptionalCustomerSignIn: true,
    }));
});

const checkoutFlowSettingsSchema = z.object({
    guestCheckoutEnabled: z.boolean(),
    checkoutMode: z.enum(["guest_cod_only", "gateways_only", "all"]),
    partialPaymentEnabled: z.boolean(),
    partialPaymentAmount: z.number(),
    /** When digital and gift-card lines are delivered (Wave B); B3/B4 surface it in the dashboard. */
    autoFulfilMode: z.enum(["after_payment", "after_confirmation"]),
    revision: z.number().int().nonnegative(),
});

const getCheckoutFlowRoute = createRoute({
    method: "get",
    path: "/checkout-flow",
    operationId: "dashboard.checkout.flow_get",
    tags: ["Admin - Settings"],
    summary: "Get versioned checkout flow settings",
    responses: {
        200: {
            description: "Checkout flow settings",
            content: {
                "application/json": {
                    schema: successEnvelope(checkoutFlowSettingsSchema),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(getCheckoutFlowRoute, async (c) => {
    return ok(c, await getCheckoutFlowSettingsDocument(c.get("db")));
});

const saveCheckoutFlowSchema = checkoutFlowSettingsSchema
    .omit({ revision: true, autoFulfilMode: true })
    .extend({
        autoFulfilMode: checkoutFlowSettingsSchema.shape.autoFulfilMode.optional(),
        expectedRevision: z.number().int().nonnegative(),
    })
    .strict();

const saveCheckoutFlowRoute = createRoute({
    method: "put",
    path: "/checkout-flow",
    operationId: "dashboard.checkout.flow_update",
    tags: ["Admin - Settings"],
    summary: "Save versioned checkout flow settings",
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: saveCheckoutFlowSchema } },
        },
    },
    responses: {
        200: {
            description: "Checkout flow settings saved",
            content: {
                "application/json": {
                    schema: successEnvelope(checkoutFlowSettingsSchema),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(saveCheckoutFlowRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    const current = await getCheckoutFlowSettingsDocument(db);
    if (current.revision !== body.expectedRevision) {
        throw new SettingsRevisionConflictError("checkout", body.expectedRevision, current.revision);
    }
    const credentialEncryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    if (!body.guestCheckoutEnabled) {
        const signInReadiness = await getCustomerSignInReadiness(db, {
            encryptionKey: credentialEncryptionKey,
            runtimeEnv: c.env as Record<string, unknown>,
            customerSignInRequiredOverride: true,
        });
        if (!signInReadiness.hasUsableCustomerSignIn) {
            throw new ValidationError(CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE.message);
        }
    }
    const [activePaymentMethods, currencySettings] = await Promise.all([
        getActivePaymentMethods(db, credentialEncryptionKey),
        getCurrencySettings(db),
    ]);
    const saved = await saveCheckoutFlowSettingsDocument(db, {
        ...body,
        availablePaymentMethods: filterPaymentMethodsForCurrency(
            activePaymentMethods.enabledMethods,
            currencySettings.currencyCode,
        ),
    });

    await bumpCacheGeneration(c);
    return ok(c, saved);
});

const revisionSchema = z.number().int().nonnegative();
/** One revision per document /auth edits; a save sends back the ones it touches. */
const authRevisionsSchema = z.object({ customerAuth: revisionSchema, whatsapp: revisionSchema });
const savedRevisionResponse = successEnvelope(z.object({ message: z.string(), revision: revisionSchema }));

const authSettingsResponseSchema = z.object({
    revision: authRevisionsSchema,
    authVerificationMethod: z.enum(CUSTOMER_AUTH_METHODS),
    customerAuthPolicy: customerAuthPolicySchema,
    whatsappAccessToken: z.string().max(MASKED.length),
    whatsappPhoneNumberId: z.string().max(WHATSAPP_PHONE_NUMBER_ID_MAX_LENGTH),
    whatsappTemplateName: z.string().max(WHATSAPP_TEMPLATE_NAME_MAX_LENGTH),
});

const getAuthRoute = createRoute({
    method: "get",
    path: "/auth",
    operationId: "dashboard.settings.customer_auth_get",
    tags: ["Admin - Settings"],
    summary: "Get customer authentication settings",
    responses: {
        200: { description: "Auth settings", content: { "application/json": { schema: successEnvelope(authSettingsResponseSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getAuthRoute, async (c) => {
    const db = c.get("db");
    const credentialEncryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const [auth, whatsapp, whatsappDocumentRead] = await Promise.all([
        customerAuthDocument.readDetailed(db),
        getWhatsAppCloudApiSettings(db, credentialEncryptionKey),
        whatsappDocument.readDetailed(db, { encryptionKey: credentialEncryptionKey }),
    ]);

    return ok(c, {
        revision: { customerAuth: auth.revision, whatsapp: whatsappDocumentRead.revision },
        authVerificationMethod: auth.value.authVerificationMethod,
        customerAuthPolicy: auth.value.policy,
        whatsappAccessToken: whatsapp.accessTokenConfigured ? MASKED : "",
        whatsappPhoneNumberId: (whatsapp.phoneNumberId || "").slice(0, WHATSAPP_PHONE_NUMBER_ID_MAX_LENGTH),
        whatsappTemplateName: (whatsapp.authTemplateName || "").slice(0, WHATSAPP_TEMPLATE_NAME_MAX_LENGTH),
    });
});

const saveAuthSchema = z.object({
    expectedRevision: authRevisionsSchema.partial(),
    authVerificationMethod: z.enum(CUSTOMER_AUTH_METHODS).optional(),
    customerAuthPolicy: customerAuthPolicySchema.optional(),
    whatsappAccessToken: z.string().max(WHATSAPP_ACCESS_TOKEN_MAX_LENGTH).optional(),
    whatsappPhoneNumberId: z
        .string()
        .max(WHATSAPP_PHONE_NUMBER_ID_MAX_LENGTH)
        .nullable()
        .optional(),
    whatsappTemplateName: z
        .string()
        .max(WHATSAPP_TEMPLATE_NAME_MAX_LENGTH)
        .nullable()
        .optional(),
}).strict();

const saveAuthRoute = createRoute({
    method: "post",
    path: "/auth",
    operationId: "dashboard.settings.customer_auth_update",
    tags: ["Admin - Settings"],
    summary: "Save customer authentication settings",
    request: { body: { required: true, content: { "application/json": { schema: saveAuthSchema } } } },
    responses: {
        200: {
            description: "Auth settings saved",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({ message: z.string(), revision: authRevisionsSchema })),
                },
            },
        },
        ...errorResponses,
        409: conflictResponse,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveAuthRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    const credentialEncryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const existingAuth = await customerAuthDocument.read(db);

    const incomingWhatsAppAccessToken =
        typeof body.whatsappAccessToken === "string" && body.whatsappAccessToken !== MASKED
            ? body.whatsappAccessToken.trim()
            : undefined;
    const whatsappPlaceholderError = firstWhatsAppPlaceholderConfigError([
        ["WhatsApp access token", incomingWhatsAppAccessToken],
        ["WhatsApp phone number ID", typeof body.whatsappPhoneNumberId === "string" ? body.whatsappPhoneNumberId : undefined],
        ["WhatsApp template name", typeof body.whatsappTemplateName === "string" ? body.whatsappTemplateName : undefined],
    ]);
    if (whatsappPlaceholderError) {
        throw new ValidationError(whatsappPlaceholderError);
    }

    // A null clears the field; the store falls back to the default template.
    const whatsappPatch: Partial<WhatsAppSettings> = {
        accessToken: incomingWhatsAppAccessToken,
        phoneNumberId: body.whatsappPhoneNumberId === undefined ? undefined : body.whatsappPhoneNumberId ?? "",
        authTemplateName: body.whatsappTemplateName === undefined ? undefined : body.whatsappTemplateName ?? "",
    };
    const whatsappProviderTouched = Object.values(whatsappPatch).some((value) => value !== undefined);

    let requestedCustomerAuthPolicy: ReturnType<typeof normalizeCustomerAuthPolicy> | undefined;
    if (body.customerAuthPolicy) {
        requestedCustomerAuthPolicy = normalizeCustomerAuthPolicy(
            body.customerAuthPolicy,
            body.authVerificationMethod ?? existingAuth.authVerificationMethod,
        );
    } else if (body.authVerificationMethod) {
        requestedCustomerAuthPolicy = getCustomerAuthPolicyForMethod(
            normalizeCustomerAuthMethod(body.authVerificationMethod),
        );
    }
    const effectiveCustomerAuthPolicy = requestedCustomerAuthPolicy ?? existingAuth.policy;

    if (requestedCustomerAuthPolicy && customerAuthPolicyUsesEmailProvider(requestedCustomerAuthPolicy)) {
        const emailReadiness = await getEmailProviderReadiness({
            db,
            env: c.env as Record<string, unknown>,
            encryptionKey: credentialEncryptionKey,
        });
        if (!isReady(emailReadiness)) {
            throw new ValidationError(
                `Email OTP cannot be enabled until transactional email is configured. ${emailReadiness.issues[0]?.message ?? ""}`.trim(),
            );
        }
    }

    if (requestedCustomerAuthPolicy && customerAuthPolicyUsesSmsProvider(requestedCustomerAuthPolicy)) {
        const smsReadiness = await getSmsProviderReadiness(db, credentialEncryptionKey);
        if (!isReady(smsReadiness)) {
            throw new ValidationError(
                `SMS OTP cannot be enabled until an active SMS provider is configured. ${smsReadiness.issues[0]?.message ?? ""}`.trim(),
            );
        }
    }

    if (customerAuthPolicyUsesWhatsAppProvider(effectiveCustomerAuthPolicy)) {
        const whatsapp = await getWhatsAppCloudApiSettings(db, credentialEncryptionKey);
        const nextAccessToken = whatsappPatch.accessToken === undefined
            ? whatsapp.accessToken
            : whatsappPatch.accessToken || undefined;
        const nextPhoneNumberId = whatsappPatch.phoneNumberId === undefined
            ? whatsapp.phoneNumberId?.trim() || undefined
            : whatsappPatch.phoneNumberId.trim() || undefined;
        const nextTemplateName = whatsappPatch.authTemplateName === undefined
            ? whatsapp.authTemplateName?.trim() || undefined
            : whatsappPatch.authTemplateName.trim() || undefined;

        if (!nextAccessToken || !nextPhoneNumberId || !nextTemplateName) {
            throw new ValidationError(
                "WhatsApp OTP cannot be enabled until a WhatsApp access token, phone number ID, and OTP template name are configured.",
            );
        }
    }

    // Credentials and policy commit together (or not at all), each at the
    // revision the merchant loaded: a policy never points at credentials this
    // request failed to store.
    const writes: SettingsDocumentWriteRequest[] = [];
    if (whatsappProviderTouched) {
        writes.push({
            document: whatsappDocument,
            patch: whatsappPatch,
            ctx: {
                encryptionKey: whatsappPatch.accessToken
                    ? requireEncryptionKey(c.env as Record<string, unknown>)
                    : credentialEncryptionKey,
            },
            expectedRevision: requireExpectedRevision(body.expectedRevision.whatsapp, "whatsapp"),
        });
    }
    if (requestedCustomerAuthPolicy) {
        writes.push({
            document: customerAuthDocument,
            patch: { policy: requestedCustomerAuthPolicy },
            expectedRevision: requireExpectedRevision(body.expectedRevision.customerAuth, "customerAuth"),
        });
    }
    if (writes.length > 0) {
        await writeSettingsDocuments(db, writes, {
            after: whatsappProviderTouched
                ? [buildClearNotificationProviderBlocksStatement(db, { channel: "whatsapp" })]
                : [],
        });
    }
    const rows = await selectSettingsDocuments(db, [customerAuthDocument, whatsappDocument]);
    const revisionOf = (key: string) => rows.find((row) => row.category === key)?.revision ?? 0;

    await bumpCacheGeneration(c);
    return ok(c, {
        message: "Auth settings saved successfully",
        revision: {
            customerAuth: revisionOf(customerAuthDocument.key),
            whatsapp: revisionOf(whatsappDocument.key),
        },
    });
});

// ─────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────

const getSecurityRoute = createRoute({
    method: "get",
    path: "/security",
    tags: ["Admin - Settings"],
    summary: "Get security settings",
    operationId: "dashboard.security.policy_get",
    responses: {
        200: { description: "Security settings", content: { "application/json": { schema: successEnvelope(z.object({ cspAllowedDomains: z.string().max(MERCHANT_CSP_OUTPUT_MAX_LENGTH), revision: revisionSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(getSecurityRoute, async (c) => {
    const { value: stored, revision } = await securityDocument.readDetailed(
        c.get("db"),
        {},
        { skipCache: true },
    );

    return ok(c, {
        cspAllowedDomains: normalizeStoredMerchantCspSources(
            stored.cspAllowedDomains,
            c.env as Record<string, unknown>,
        ),
        revision,
    });
});

const getSecurityRuntimeSourcesRoute = createRoute({
    method: "get",
    path: "/security/runtime-sources",
    tags: ["Admin - Settings"],
    summary: "Get inherited storefront security origins",
    operationId: "dashboard.security.runtime_sources",
    responses: {
        200: {
            description: "Inherited storefront security origins",
            content: {
                "application/json": {
                    schema: successEnvelope(z.array(inheritedSecuritySourceSchema)),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(getSecurityRuntimeSourcesRoute, async (c) => {
    c.header("Cache-Control", "private, no-store");
    return ok(
        c,
        getInheritedSecuritySources(c.env as unknown as Record<string, unknown>),
    );
});

const saveSecuritySchema = z.object({
    expectedRevision: revisionSchema,
    cspAllowedDomains: z.string().max(MERCHANT_CSP_INPUT_MAX_LENGTH).optional(),
});

const saveSecurityRoute = createRoute({
    method: "post",
    path: "/security",
    tags: ["Admin - Settings"],
    summary: "Save security settings",
    operationId: "dashboard.security.policy_update",
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: saveSecuritySchema } },
        },
    },
    responses: {
        200: { description: "Security settings saved", content: { "application/json": { schema: savedRevisionResponse } } },
        ...errorResponses,
        409: conflictResponse,
    }
});

app.openapi(saveSecurityRoute, async (c) => {
    const db = c.get("db");
    const { cspAllowedDomains, expectedRevision } = c.req.valid("json");
    let revision = expectedRevision;

        if (typeof cspAllowedDomains === "string") {
            assertMerchantCspSourcesValid(cspAllowedDomains);
            // Writing through refreshes the KV mirror the Partytown proxy reads.
            ({ revision } = await securityDocument.write(db, {
                cspAllowedDomains: normalizeStoredMerchantCspSources(
                    cspAllowedDomains,
                    c.env as Record<string, unknown>,
                ),
            }, { kv: c.env.CACHE }, { expectedRevision }));
            await bumpCacheGeneration(c);
        }

        return ok(c, { message: "Security settings saved successfully", revision });
});

// ─────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────

const getEmailRoute = createRoute({
    method: "get",
    path: "/email",
    operationId: "dashboard.settings.email_get",
    tags: ["Admin - Settings"],
    summary: "Get email settings (system)",
    responses: {
        200: { description: "Email settings", content: { "application/json": { schema: successEnvelope(z.object({
            provider: z.enum(["cloudflare", "resend"]),
            apiKey: z.string().max(MASKED.length),
            sender: z.string().max(EMAIL_SENDER_MAX_LENGTH),
            senderConfigured: z.boolean(),
            cloudflareBindingConfigured: z.boolean(),
            resendConfigured: z.boolean(),
            readiness: readinessSchema,
            revision: revisionSchema,
        })) } } },
        ...errorResponses,
    }
});

app.openapi(getEmailRoute, async (c) => {
    const db = c.get("db");
        const emailSettings = await getEmailRuntimeSettings({
            db,
            env: c.env as Record<string, unknown>,
            encryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
        });
        const emailReadiness = await getEmailProviderReadiness({
            db,
            env: c.env as Record<string, unknown>,
            encryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
            settings: emailSettings,
        });
        const { value: { sender }, revision } = await emailDocument.readDetailed(db, {
            encryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
        });

        return ok(c, {
            provider: emailSettings.provider,
            apiKey: emailSettings.hasResendApiKey ? MASKED : "",
            sender: sender.slice(0, EMAIL_SENDER_MAX_LENGTH),
            senderConfigured: emailReadiness.senderConfigured,
            cloudflareBindingConfigured: emailSettings.cloudflareBindingConfigured,
            resendConfigured: emailSettings.hasResendApiKey,
            readiness: boundedReadiness(emailReadiness),
            revision,
        });
});

const saveEmailSchema = z.object({
    expectedRevision: revisionSchema,
    provider: z.enum(["cloudflare", "resend"]).optional(),
    apiKey: z.string().max(EMAIL_API_KEY_MAX_LENGTH).optional(),
    sender: z.string().max(EMAIL_SENDER_MAX_LENGTH).refine(
        (value) => value.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        "Sender must be a valid email address",
    ).optional(),
});

const saveEmailRoute = createRoute({
    method: "post",
    path: "/email",
    operationId: "dashboard.settings.email_update",
    tags: ["Admin - Settings"],
    summary: "Save email settings (system)",
    request: { body: { required: true, content: { "application/json": { schema: saveEmailSchema } } } },
    responses: {
        200: { description: "Email settings saved", content: { "application/json": { schema: savedRevisionResponse } } },
        ...errorResponses,
        409: conflictResponse,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveEmailRoute, async (c) => {
    const db = c.get("db");
        const { apiKey, sender, provider, expectedRevision } = c.req.valid("json");
        let revision = expectedRevision;
        const patch: Partial<EmailSettings> = {};
        const credentialEncryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
        const [currentEmailSettings, customerAuth] = await Promise.all([
            getEmailRuntimeSettings({
                db,
                env: c.env as Record<string, unknown>,
                encryptionKey: credentialEncryptionKey,
            }),
            customerAuthDocument.read(db),
        ]);

        if (provider) {
            patch.provider = provider;
        }

        let credentialWriteKey: string | undefined;
        if (typeof apiKey === "string" && apiKey !== MASKED) {
            const trimmedApiKey = apiKey.trim();
            if (trimmedApiKey) {
                credentialWriteKey = requireEncryptionKey(c.env as Record<string, unknown>);
                patch.resendApiKey = trimmedApiKey;
            } else {
                patch.resendApiKey = "";
            }
        }

        if (typeof sender === "string") {
            patch.sender = sender.trim();
        }

        const effectiveCustomerAuthPolicy = customerAuth.policy;
        const emailSettingsTouched = Object.keys(patch).length > 0;
        if (emailSettingsTouched && customerAuthPolicyUsesEmailProvider(effectiveCustomerAuthPolicy)) {
            // Judge the settings this save would leave behind with the one
            // shared email readiness rule instead of re-deriving it here.
            const nextResendApiKey = typeof apiKey === "string" && apiKey !== MASKED
                ? (apiKey.trim() || null)
                : currentEmailSettings.resendApiKey;
            const nextSender = typeof sender === "string" ? sender.trim() : currentEmailSettings.sender;
            const nextReadiness = await getEmailProviderReadiness({
                env: c.env as Record<string, unknown>,
                settings: {
                    ...currentEmailSettings,
                    provider: provider ?? currentEmailSettings.provider,
                    sender: nextSender,
                    senderConfigured: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextSender),
                    resendApiKey: nextResendApiKey,
                    hasResendApiKey: Boolean(nextResendApiKey),
                },
            });
            if (!isReady(nextReadiness)) {
                throw new ValidationError(
                    "Email OTP is enabled for customer sign-in. Keep a valid sender and the selected email provider configured, or remove Email OTP first.",
                );
            }
        }

        if (emailSettingsTouched) {
            ({ revision } = await emailDocument.write(db, patch, {
                encryptionKey: credentialWriteKey ?? credentialEncryptionKey,
            }, {
                expectedRevision,
                after: [buildClearNotificationProviderBlocksStatement(db, { channel: "email" })],
            }));
            // Email readiness is projected into the cached public checkout
            // configuration when customer sign-in is required.
            await bumpCacheGeneration(c);
        }
        return ok(c, { message: "Email settings saved successfully", revision });
});

// ─────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────

const getFirebaseRoute = createRoute({
    method: "get",
    path: "/firebase",
    operationId: "dashboard.notifications.firebase_get",
    tags: ["Admin - Settings"],
    summary: "Get Firebase settings (system)",
    responses: {
        200: { description: "Firebase settings", content: { "application/json": { schema: successEnvelope(z.object({ serviceAccount: z.string(), publicConfig: z.record(z.string(), z.unknown()), revision: revisionSchema })) } } },
        ...errorResponses,
    }
});

app.openapi(getFirebaseRoute, async (c) => {
    const stored = await readFirebaseSettings(
        c.get("db"),
        getCredentialEncryptionKey(c.env as Record<string, unknown>),
    );

    return ok(c, {
        serviceAccount: stored.serviceAccountStored ? MASKED : "",
        publicConfig: stored.publicConfig,
        revision: stored.revision,
    });
});

const saveFirebaseSchema = z.object({
    expectedRevision: revisionSchema,
    serviceAccount: z.string().optional(),
    publicConfig: z.record(z.string(), z.unknown()).optional(),
});

const saveFirebaseRoute = createRoute({
    method: "post",
    path: "/firebase",
    operationId: "dashboard.notifications.firebase_update",
    tags: ["Admin - Settings"],
    summary: "Save Firebase settings (system)",
    request: { body: { required: true, content: { "application/json": { schema: saveFirebaseSchema } } } },
    responses: {
        200: { description: "Firebase settings saved", content: { "application/json": { schema: savedRevisionResponse } } },
        ...errorResponses,
        409: conflictResponse,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveFirebaseRoute, async (c) => {
    const db = c.get("db");
    const { serviceAccount, publicConfig, expectedRevision } = c.req.valid("json");
    let revision = expectedRevision;
    const patch: Partial<FirebaseSettings> = {};
    let encryptionKey: string | undefined;
    const credentialChanged = typeof serviceAccount === "string" && serviceAccount !== MASKED;

    if (credentialChanged) {
        const normalizedServiceAccount = normalizeFirebaseServiceAccountJson(serviceAccount);
        if (normalizedServiceAccount) encryptionKey = requireEncryptionKey(c.env as Record<string, unknown>);
        patch.serviceAccount = normalizedServiceAccount;
    }

    if (publicConfig) {
        patch.publicConfig = publicConfig;
    }

    if (Object.keys(patch).length > 0) {
        ({ revision } = await firebaseDocument.write(db, patch, {
            encryptionKey: encryptionKey
                ?? getCredentialEncryptionKey(c.env as Record<string, unknown>),
        }, {
            expectedRevision,
            after: credentialChanged
                ? [buildClearNotificationProviderBlocksStatement(db, { channel: "push" })]
                : [],
        }));
    }

    return ok(c, { message: "Settings saved successfully", revision });
});

export { app as systemSettingsRoutes };
