import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings, siteSettings } from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { invalidateSiteSettingsCache } from "@scalius/core/modules/settings";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { getEmailProviderReadiness, getEmailRuntimeSettings, readEmailSetting } from "@scalius/core/integrations/email";
import { getSmsProviderReadiness } from "@scalius/core/integrations/sms";
import {
    normalizeFirebaseServiceAccountJson,
    saveFirebaseServiceAccountJson,
} from "@scalius/core/integrations/firebase/settings";
import {
    firstWhatsAppPlaceholderConfigError,
    getWhatsAppCloudApiSettings,
    saveWhatsAppAccessToken,
} from "@scalius/core/integrations/whatsapp";
import {
    getActivePaymentMethods,
    upsertEncryptedSetting,
    upsertSetting,
} from "@scalius/core/modules/payments/gateway-settings";
import {
    CUSTOMER_AUTH_CONTACT_FIELDS,
    CUSTOMER_AUTH_METHODS,
    CUSTOMER_AUTH_OTP_CHANNELS,
    customerAuthPolicyUsesEmailProvider,
    customerAuthPolicyUsesSmsProvider,
    customerAuthPolicyUsesWhatsAppProvider,
    getCustomerAuthPolicyForMethod,
    getLegacyCustomerAuthMethodForPolicy,
    normalizeCustomerAuthMethod,
    normalizeCustomerAuthPolicy,
} from "@scalius/shared/customer-auth-policy";
import {
    CheckoutFlowRevisionConflictError,
    getCheckoutFlowSettingsDocument,
    saveCheckoutFlowSettingsDocument,
} from "@scalius/core/modules/settings/checkout-flow-admin.service";
import {
    CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE,
    getCheckoutReadiness,
    getCustomerSignInReadiness,
} from "@scalius/core/modules/settings/checkout-readiness";
import {
    getOptionalExecutionContext,
    invalidateApiAndScheduleStorefrontGroups,
} from "../../../utils/cache-invalidation";
import { clearNotificationProviderBlocks } from "@scalius/core/modules/notifications/notification-provider-health";
import {
    normalizePlatformOrigin,
    parseMerchantCspSources,
    serializeMerchantCspSources,
} from "@scalius/shared/security-csp";

import { ok } from "../../../utils/api-response";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import {
    conflictResponse,
    successEnvelope,
    messageResponse,
    errorResponses,
    serviceUnavailableResponse,
} from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED = "••••••••••••";
const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;
const LAYOUT_CACHE_GROUPS = ["layout"] as const;
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

export function getInheritedSecuritySources(
    env: Record<string, unknown>,
): Array<z.infer<typeof inheritedSecuritySourceSchema>> {
    return [
        inheritedSecuritySource(
            "storefront",
            "Storefront",
            "storefront",
            env.STOREFRONT_URL,
            "The storefront trusts its own origin by default.",
        ),
        inheritedSecuritySource(
            "api",
            "Commerce API",
            "api",
            env.PUBLIC_API_BASE_URL,
            "Buyer requests can connect to this exact API origin.",
        ),
        inheritedSecuritySource(
            "dashboard",
            "Admin dashboard",
            "dashboard",
            env.BETTER_AUTH_URL,
            "Admin sessions and credentialed API requests recognize this exact origin.",
        ),
        inheritedSecuritySource(
            "cdn",
            "Canonical media CDN",
            "media",
            env.CDN_DOMAIN_URL,
            "Storefront images can load from this exact media origin.",
        ),
        inheritedSecuritySource(
            "r2",
            "Public media storage",
            "media",
            env.R2_PUBLIC_URL,
            "Existing public media can load from this exact storage origin.",
        ),
    ];
}

const customerAuthPolicySchema = z.object({
    otpChannels: z.array(z.enum(CUSTOMER_AUTH_OTP_CHANNELS)).min(1).max(3),
    requiredContactFields: z.array(z.enum(CUSTOMER_AUTH_CONTACT_FIELDS)).max(2).optional(),
    optionalContactFields: z.array(z.enum(CUSTOMER_AUTH_CONTACT_FIELDS)).max(2).optional(),
    defaultOtpChannel: z.enum(CUSTOMER_AUTH_OTP_CHANNELS).optional(),
});

const checkoutReadinessResponseSchema = z.object({
    ready: z.boolean(),
    hasActiveShippingMethod: z.boolean(),
    hasActiveDeliveryHierarchy: z.boolean(),
    customerSignInRequired: z.boolean(),
    hasUsableCustomerSignIn: z.boolean(),
    issues: z.array(z.string()),
});

function parseCustomerAuthPolicy(value: string | null | undefined): unknown {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}

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
    revision: z.number().int().positive(),
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
    .omit({ revision: true })
    .extend({ expectedRevision: z.number().int().positive() })
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
        throw new CheckoutFlowRevisionConflictError(body.expectedRevision, current.revision);
    }
    const credentialEncryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    if (!body.guestCheckoutEnabled) {
        const signInReadiness = await getCustomerSignInReadiness(db, {
            encryptionKey: credentialEncryptionKey,
            runtimeEnv: c.env as Record<string, unknown>,
            customerSignInRequiredOverride: true,
        });
        if (!signInReadiness.hasUsableCustomerSignIn) {
            throw new ValidationError(CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE);
        }
    }
    const activePaymentMethods = await getActivePaymentMethods(
        db,
        credentialEncryptionKey,
    );
    const saved = await saveCheckoutFlowSettingsDocument(db, {
        ...body,
        availablePaymentMethods: activePaymentMethods.enabledMethods,
    });

    await invalidateSiteSettingsCache(c.env.CACHE);
    await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
    return ok(c, saved);
});

const authSettingsResponseSchema = z.object({
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
        const [row] = await db.select().from(siteSettings).limit(1);
        if (!row) throw new NotFoundError("Settings not found");
        const policyRow = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.category, "customer_auth"), eq(settings.key, "policy")))
            .get()
            .catch(() => null);
        const customerAuthPolicy = normalizeCustomerAuthPolicy(
            parseCustomerAuthPolicy(policyRow?.value),
            row.authVerificationMethod,
        );
        const whatsapp = await getWhatsAppCloudApiSettings(
            db,
            getCredentialEncryptionKey(c.env as Record<string, unknown>),
            {
                migrateLegacy: true,
                migrationEncryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
            },
        );

	        return ok(c, {
	            authVerificationMethod: policyRow?.value
                    ? getLegacyCustomerAuthMethodForPolicy(customerAuthPolicy)
                    : normalizeCustomerAuthMethod(row.authVerificationMethod),
                customerAuthPolicy,
            whatsappAccessToken: whatsapp.accessTokenConfigured ? MASKED : "",
            whatsappPhoneNumberId: (whatsapp.phoneNumberId || "").slice(
                0,
                WHATSAPP_PHONE_NUMBER_ID_MAX_LENGTH,
            ),
            whatsappTemplateName: (whatsapp.authTemplateName || "").slice(
                0,
                WHATSAPP_TEMPLATE_NAME_MAX_LENGTH,
            ),
        });
});

const saveAuthSchema = z.object({
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
        200: { description: "Auth settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveAuthRoute, async (c) => {
    const db = c.get("db");
        const body = c.req.valid("json");
        const [existingSettings] = await db.select().from(siteSettings).limit(1);

        if (!existingSettings) throw new ValidationError("Base Site Settings must be configured first");

        const updates: Partial<typeof siteSettings.$inferInsert> = {};
        let customerAuthPolicyValue: string | undefined;
        let requestedCustomerAuthPolicy:
            | ReturnType<typeof normalizeCustomerAuthPolicy>
            | undefined;
        const credentialEncryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
        const incomingWhatsAppAccessToken =
            typeof body.whatsappAccessToken === "string" &&
            body.whatsappAccessToken !== MASKED
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
        const credentialWriteKey =
            incomingWhatsAppAccessToken
                ? requireEncryptionKey(c.env as Record<string, unknown>)
                : undefined;
        const whatsappProviderTouched =
            (typeof body.whatsappAccessToken === "string" && body.whatsappAccessToken !== MASKED) ||
            typeof body.whatsappPhoneNumberId === "string" ||
            body.whatsappPhoneNumberId === null ||
            typeof body.whatsappTemplateName === "string" ||
            body.whatsappTemplateName === null;

        if (body.customerAuthPolicy) {
            const customerAuthPolicy = normalizeCustomerAuthPolicy(
                body.customerAuthPolicy,
                body.authVerificationMethod ?? existingSettings.authVerificationMethod,
            );
            requestedCustomerAuthPolicy = customerAuthPolicy;
            updates.authVerificationMethod = getLegacyCustomerAuthMethodForPolicy(customerAuthPolicy);
            customerAuthPolicyValue = JSON.stringify(customerAuthPolicy);
        } else if (body.authVerificationMethod) {
            const authVerificationMethod = normalizeCustomerAuthMethod(body.authVerificationMethod);
            const customerAuthPolicy = getCustomerAuthPolicyForMethod(authVerificationMethod);
            requestedCustomerAuthPolicy = customerAuthPolicy;
            updates.authVerificationMethod = authVerificationMethod;
            customerAuthPolicyValue = JSON.stringify(customerAuthPolicy);
        }
        if (typeof body.whatsappPhoneNumberId === "string" || body.whatsappPhoneNumberId === null) {
            updates.whatsappPhoneNumberId = body.whatsappPhoneNumberId;
        }
        if (typeof body.whatsappTemplateName === "string" || body.whatsappTemplateName === null) {
            updates.whatsappTemplateName = body.whatsappTemplateName;
        }

        if (requestedCustomerAuthPolicy && customerAuthPolicyUsesEmailProvider(requestedCustomerAuthPolicy)) {
            const emailReadiness = await getEmailProviderReadiness({
                db,
                env: c.env as Record<string, unknown>,
                encryptionKey: credentialEncryptionKey,
            });
            if (!emailReadiness.configured) {
                throw new ValidationError(
                    `Email OTP cannot be enabled until transactional email is configured. ${emailReadiness.error ?? ""}`.trim(),
                );
            }
        }

        if (requestedCustomerAuthPolicy && customerAuthPolicyUsesSmsProvider(requestedCustomerAuthPolicy)) {
            const smsReadiness = await getSmsProviderReadiness(db, credentialEncryptionKey);
            if (!smsReadiness.configured) {
                throw new ValidationError(
                    `SMS OTP cannot be enabled until an active SMS provider is configured. ${smsReadiness.error ?? ""}`.trim(),
                );
            }
        }

        if (requestedCustomerAuthPolicy && customerAuthPolicyUsesWhatsAppProvider(requestedCustomerAuthPolicy)) {
            const whatsapp = await getWhatsAppCloudApiSettings(db, credentialEncryptionKey);
            const nextAccessToken =
                typeof body.whatsappAccessToken === "string"
                    ? body.whatsappAccessToken === MASKED
                        ? whatsapp.accessToken
                        : body.whatsappAccessToken.trim() || undefined
                    : whatsapp.accessToken;
            const nextPhoneNumberId =
                updates.whatsappPhoneNumberId !== undefined
                    ? updates.whatsappPhoneNumberId?.trim() || undefined
                    : whatsapp.phoneNumberId?.trim() || undefined;
            const nextTemplateName =
                updates.whatsappTemplateName !== undefined
                    ? updates.whatsappTemplateName?.trim() || undefined
                    : whatsapp.authTemplateName?.trim() || undefined;

            if (!nextAccessToken || !nextPhoneNumberId || !nextTemplateName) {
                throw new ValidationError(
                    "WhatsApp OTP cannot be enabled until a WhatsApp access token, phone number ID, and OTP template name are configured.",
                );
            }
        }

        if (customerAuthPolicyValue !== undefined) {
            await upsertSetting(db, "customer_auth", "policy", customerAuthPolicyValue);
        }

        if (Object.keys(updates).length > 0) {
            await db
                .update(siteSettings)
                .set(updates)
                .where(eq(siteSettings.id, existingSettings.id));
        }

        if (typeof body.whatsappAccessToken === "string" && body.whatsappAccessToken !== MASKED) {
            await saveWhatsAppAccessToken(
                db,
                body.whatsappAccessToken,
                credentialWriteKey,
                existingSettings.id,
            );
        }
        if (whatsappProviderTouched) {
            await clearNotificationProviderBlocks(db, { channel: "whatsapp" });
        }

        await invalidateSiteSettingsCache(c.env.CACHE);
        await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        return ok(c, { message: "Auth settings saved successfully" });
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
        200: { description: "Security settings", content: { "application/json": { schema: successEnvelope(z.object({ cspAllowedDomains: z.string().max(MERCHANT_CSP_OUTPUT_MAX_LENGTH) })) } } },
        ...errorResponses,
    }
});

app.openapi(getSecurityRoute, async (c) => {
    const db = c.get("db");
        const row = await db
            .select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.key, "csp_allowed_domains"), eq(settings.category, "security")))
            .get();

        return ok(c, {
            cspAllowedDomains: normalizeStoredMerchantCspSources(
                row?.value || "",
                c.env as Record<string, unknown>,
            ),
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
        200: { description: "Security settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveSecurityRoute, async (c) => {
    const db = c.get("db");
    const { cspAllowedDomains } = c.req.valid("json");

        if (typeof cspAllowedDomains === "string") {
            const normalizedCspAllowedDomains = normalizeStoredMerchantCspSources(
                cspAllowedDomains,
                c.env as Record<string, unknown>,
            );
            await db
                .insert(settings)
                .values({
                    id: `set_${nanoid(10)}`,
                    key: "csp_allowed_domains",
                    value: normalizedCspAllowedDomains,
                    type: "string",
                    category: "security"
                })
                .onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: normalizedCspAllowedDomains, updatedAt: sql`(unixepoch())` }
                });

            const env = c.env as Env | undefined;
            if (env?.CACHE) {
                const cacheWrite = env.CACHE
                    .put("security:csp_allowed_domains", normalizedCspAllowedDomains)
                    .catch((error) => {
                        console.error("[Settings] Failed to cache CSP allowed domains:", error);
                    });

                const executionCtx = getOptionalExecutionContext(c);
                if (executionCtx) {
                    executionCtx.waitUntil(cacheWrite);
                } else {
                    void cacheWrite;
                }
            }
            await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
        }

        return ok(c, { message: "Security settings saved successfully" });
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
            ready: z.boolean(),
            readinessError: z.string().max(PROVIDER_STATUS_ERROR_MAX_LENGTH).nullable(),
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
        const sender = await readEmailSetting(db, "email_sender");

        return ok(c, {
            provider: emailSettings.provider,
            apiKey: emailSettings.hasResendApiKey ? MASKED : "",
            sender: (sender || "").slice(0, EMAIL_SENDER_MAX_LENGTH),
            senderConfigured: emailReadiness.senderConfigured,
            cloudflareBindingConfigured: emailSettings.cloudflareBindingConfigured,
            resendConfigured: emailSettings.hasResendApiKey,
            ready: emailReadiness.configured,
            readinessError:
                typeof emailReadiness.error === "string"
                    ? emailReadiness.error.slice(0, PROVIDER_STATUS_ERROR_MAX_LENGTH)
                    : null,
        });
});

const saveEmailSchema = z.object({
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
        200: { description: "Email settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveEmailRoute, async (c) => {
    const db = c.get("db");
        const { apiKey, sender, provider } = c.req.valid("json");
        const updates: Promise<unknown>[] = [];

        if (provider) {
            updates.push(upsertSetting(db, "email", "email_provider", provider));
        }

        if (typeof apiKey === "string" && apiKey !== MASKED) {
            const trimmedApiKey = apiKey.trim();
            if (trimmedApiKey) {
                const encKey = requireEncryptionKey(c.env as Record<string, unknown>);
                updates.push(upsertEncryptedSetting(db, "email", "resend_api_key", trimmedApiKey, encKey));
            } else {
                updates.push(upsertSetting(db, "email", "resend_api_key", ""));
            }
        }

        if (typeof sender === "string") {
            updates.push(upsertSetting(db, "email", "email_sender", sender.trim()));
        }

        await Promise.all(updates);
        if (updates.length > 0) {
            await clearNotificationProviderBlocks(db, { channel: "email" });
            // Email readiness is projected into the cached public checkout
            // configuration when customer sign-in is required.
            await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
        }
        return ok(c, { message: "Email settings saved successfully" });
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
        200: { description: "Firebase settings", content: { "application/json": { schema: successEnvelope(z.object({ serviceAccount: z.string(), publicConfig: z.record(z.string(), z.unknown()) })) } } },
        ...errorResponses,
    }
});

app.openapi(getFirebaseRoute, async (c) => {
    const db = c.get("db");
        const results = await db.select({ key: settings.key, value: settings.value }).from(settings).where(eq(settings.category, "firebase")).all();

        const config: { serviceAccount: string; publicConfig: Record<string, unknown> } = { serviceAccount: "", publicConfig: {} };

        results.forEach((row) => {
            if (row.key === "service_account") config.serviceAccount = row.value ? MASKED : "";
            if (row.key === "public_config") {
                try { config.publicConfig = JSON.parse(row.value); } catch { config.publicConfig = {}; }
            }
        });

        return ok(c, config);
});

const saveFirebaseSchema = z.object({
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
        200: { description: "Firebase settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(saveFirebaseRoute, async (c) => {
    const db = c.get("db");
    const { serviceAccount, publicConfig } = c.req.valid("json");
        const updates: Promise<unknown>[] = [];

        if (typeof serviceAccount === "string" && serviceAccount !== MASKED) {
            const normalizedServiceAccount = normalizeFirebaseServiceAccountJson(serviceAccount);
            const encKey = normalizedServiceAccount
                ? requireEncryptionKey(c.env as Record<string, unknown>)
                : undefined;
            updates.push(saveFirebaseServiceAccountJson(db, normalizedServiceAccount, encKey));
        }

        if (publicConfig) {
            updates.push(
                db.insert(settings)
                    .values({ id: `set_${nanoid(10)}`, key: "public_config", value: JSON.stringify(publicConfig), type: "json", category: "firebase" })
                    .onConflictDoUpdate({ target: [settings.key, settings.category], set: { value: JSON.stringify(publicConfig), updatedAt: sql`(unixepoch())` } })
            );
        }

        await Promise.all(updates);
        if (typeof serviceAccount === "string" && serviceAccount !== MASKED) {
            await clearNotificationProviderBlocks(db, { channel: "push" });
        }

        return ok(c, { message: "Settings saved successfully" });
});

export { app as systemSettingsRoutes };
