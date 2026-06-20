import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { settings, siteSettings } from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { getKv } from "../../../utils/kv-cache";
import { invalidateSiteSettingsCache } from "@scalius/core/modules/settings";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { getEmailProviderReadiness, getEmailRuntimeSettings, readEmailSetting } from "@scalius/core/integrations/email";
import { getSmsProviderReadiness } from "@scalius/core/integrations/sms";
import {
    normalizeFirebaseServiceAccountJson,
    saveFirebaseServiceAccountJson,
} from "@scalius/core/integrations/firebase/settings";
import { getWhatsAppCloudApiSettings, saveWhatsAppAccessToken } from "@scalius/core/integrations/whatsapp";
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
import { getCheckoutFlowValidationIssues } from "@scalius/core/modules/settings/checkout-flow";
import { getCheckoutReadiness } from "@scalius/core/modules/settings/checkout-readiness";
import {
    getOptionalExecutionContext,
    invalidateApiAndScheduleStorefrontGroups,
} from "../../../utils/cache-invalidation";

import { ok } from "../../../utils/api-response";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED = "••••••••••••";
const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;
const LAYOUT_CACHE_GROUPS = ["layout"] as const;

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
    tags: ["Admin - Settings"],
    summary: "Get checkout readiness",
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
    return ok(c, await getCheckoutReadiness(db));
});

const authSettingsResponseSchema = z.object({
    authVerificationMethod: z.enum(CUSTOMER_AUTH_METHODS),
    customerAuthPolicy: customerAuthPolicySchema,
    guestCheckoutEnabled: z.boolean(),
    whatsappAccessToken: z.string(),
    whatsappPhoneNumberId: z.string(),
    whatsappTemplateName: z.string(),
    checkoutMode: z.string(),
    partialPaymentEnabled: z.boolean(),
    partialPaymentAmount: z.number().nullable(),
});

const getAuthRoute = createRoute({
    method: "get",
    path: "/auth",
    tags: ["Admin - Settings"],
    summary: "Get auth/checkout settings",
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
	            guestCheckoutEnabled: row.guestCheckoutEnabled,
            whatsappAccessToken: whatsapp.accessTokenConfigured ? MASKED : "",
            whatsappPhoneNumberId: whatsapp.phoneNumberId || "",
            whatsappTemplateName: whatsapp.authTemplateName || "",
            checkoutMode: row.checkoutMode,
            partialPaymentEnabled: row.partialPaymentEnabled,
            partialPaymentAmount: row.partialPaymentAmount
        });
});

const saveAuthSchema = z.object({
    authVerificationMethod: z.enum(CUSTOMER_AUTH_METHODS).optional(),
    customerAuthPolicy: customerAuthPolicySchema.optional(),
    guestCheckoutEnabled: z.boolean().optional(),
    whatsappAccessToken: z.string().optional(),
    whatsappPhoneNumberId: z.string().nullable().optional(),
    whatsappTemplateName: z.string().nullable().optional(),
    checkoutMode: z.enum(["guest_cod_only", "gateways_only", "all"]).optional(),
    partialPaymentEnabled: z.boolean().optional(),
    partialPaymentAmount: z.number().optional(),
});

const saveAuthRoute = createRoute({
    method: "post",
    path: "/auth",
    tags: ["Admin - Settings"],
    summary: "Save auth/checkout settings",
    request: { body: { content: { "application/json": { schema: saveAuthSchema } } } },
    responses: {
        200: { description: "Auth settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
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
        const credentialWriteKey =
            typeof body.whatsappAccessToken === "string" &&
            body.whatsappAccessToken !== MASKED &&
            body.whatsappAccessToken.trim()
                ? requireEncryptionKey(c.env as Record<string, unknown>)
                : undefined;

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
        if (typeof body.guestCheckoutEnabled === "boolean") updates.guestCheckoutEnabled = body.guestCheckoutEnabled;
        if (typeof body.whatsappPhoneNumberId === "string" || body.whatsappPhoneNumberId === null) {
            updates.whatsappPhoneNumberId = body.whatsappPhoneNumberId;
        }
        if (typeof body.whatsappTemplateName === "string" || body.whatsappTemplateName === null) {
            updates.whatsappTemplateName = body.whatsappTemplateName;
        }
        if (body.checkoutMode) {
            updates.checkoutMode = body.checkoutMode;
        }
        if (typeof body.partialPaymentEnabled === "boolean") updates.partialPaymentEnabled = body.partialPaymentEnabled;
        if (typeof body.partialPaymentAmount === "number") updates.partialPaymentAmount = body.partialPaymentAmount;

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

        const shouldValidateCheckoutFlow =
            body.checkoutMode !== undefined ||
            typeof body.partialPaymentEnabled === "boolean" ||
            typeof body.partialPaymentAmount === "number";
        if (shouldValidateCheckoutFlow) {
            const nextCheckoutMode = updates.checkoutMode ?? existingSettings.checkoutMode;
            const nextPartialPaymentEnabled = updates.partialPaymentEnabled ?? existingSettings.partialPaymentEnabled;
            const nextPartialPaymentAmount = updates.partialPaymentAmount ?? existingSettings.partialPaymentAmount;
            const activePaymentMethods = await getActivePaymentMethods(
                db,
                getKv(),
                credentialEncryptionKey,
                { bypassMemoryCache: true },
            );
            const checkoutFlowIssues = getCheckoutFlowValidationIssues({
                checkoutMode: nextCheckoutMode,
                partialPaymentEnabled: nextPartialPaymentEnabled,
                partialPaymentAmount: nextPartialPaymentAmount,
                availablePaymentMethods: activePaymentMethods?.enabledMethods,
            });
            if (checkoutFlowIssues.length > 0) {
                throw new ValidationError(checkoutFlowIssues.join(" "));
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

        await invalidateSiteSettingsCache(getKv());
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
    responses: {
        200: { description: "Security settings", content: { "application/json": { schema: successEnvelope(z.object({ cspAllowedDomains: z.string() })) } } },
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

        return ok(c, { cspAllowedDomains: row?.value || "" });
});

const saveSecuritySchema = z.object({
    cspAllowedDomains: z.string().optional(),
});

const saveSecurityRoute = createRoute({
    method: "post",
    path: "/security",
    tags: ["Admin - Settings"],
    summary: "Save security settings",
    request: { body: { content: { "application/json": { schema: saveSecuritySchema } } } },
    responses: {
        200: { description: "Security settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
    }
});

app.openapi(saveSecurityRoute, async (c) => {
    const db = c.get("db");
    const { cspAllowedDomains } = c.req.valid("json");

        if (typeof cspAllowedDomains === "string") {
            await db
                .insert(settings)
                .values({
                    id: `set_${nanoid(10)}`,
                    key: "csp_allowed_domains",
                    value: cspAllowedDomains,
                    type: "string",
                    category: "security"
                })
                .onConflictDoUpdate({
                    target: [settings.key, settings.category],
                    set: { value: cspAllowedDomains, updatedAt: sql`(unixepoch())` }
                });

            const env = c.env as Env | undefined;
            if (env?.CACHE) {
                const cacheWrite = env.CACHE
                    .put("security:csp_allowed_domains", cspAllowedDomains)
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
    tags: ["Admin - Settings"],
    summary: "Get email settings (system)",
    responses: {
        200: { description: "Email settings", content: { "application/json": { schema: successEnvelope(z.object({
            provider: z.enum(["cloudflare", "resend"]),
            apiKey: z.string(),
            sender: z.string(),
            senderConfigured: z.boolean(),
            cloudflareBindingConfigured: z.boolean(),
            resendConfigured: z.boolean(),
            ready: z.boolean(),
            readinessError: z.string().nullable(),
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
            sender: sender || "",
            senderConfigured: emailReadiness.senderConfigured,
            cloudflareBindingConfigured: emailSettings.cloudflareBindingConfigured,
            resendConfigured: emailSettings.hasResendApiKey,
            ready: emailReadiness.configured,
            readinessError: emailReadiness.error,
        });
});

const saveEmailSchema = z.object({
    provider: z.enum(["cloudflare", "resend"]).optional(),
    apiKey: z.string().max(512).optional(),
    sender: z.string().max(320).refine(
        (value) => value.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        "Sender must be a valid email address",
    ).optional(),
});

const saveEmailRoute = createRoute({
    method: "post",
    path: "/email",
    tags: ["Admin - Settings"],
    summary: "Save email settings (system)",
    request: { body: { content: { "application/json": { schema: saveEmailSchema } } } },
    responses: {
        200: { description: "Email settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
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
        return ok(c, { message: "Email settings saved successfully" });
});

// ─────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────

const getFirebaseRoute = createRoute({
    method: "get",
    path: "/firebase",
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
    tags: ["Admin - Settings"],
    summary: "Save Firebase settings (system)",
    request: { body: { content: { "application/json": { schema: saveFirebaseSchema } } } },
    responses: {
        200: { description: "Firebase settings saved", content: { "application/json": { schema: messageResponse } } },
        ...errorResponses,
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

        const { layoutCache, CACHE_KEYS } = await import("@scalius/shared/layout-cache");
        layoutCache.invalidate(CACHE_KEYS.FIREBASE_CONFIG);

        return ok(c, { message: "Settings saved successfully" });
});

export { app as systemSettingsRoutes };
