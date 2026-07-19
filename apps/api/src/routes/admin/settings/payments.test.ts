import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";
import { ServiceUnavailableError } from "../../../utils/api-error";

const mocks = vi.hoisted(() => {
    const stripePlaceholders = new Set([
        "dummy",
        "placeholder",
        "example",
        "demo",
        "test",
        "stripe_secret_key",
        "stripe_publishable_key",
        "stripe_webhook_secret",
        "your_stripe_secret_key",
        "your_stripe_publishable_key",
        "your_stripe_webhook_secret",
        "sk_test_your_key_here",
        "pk_test_your_key_here",
        "whsec_your_webhook_secret",
    ]);
    const isStripePlaceholder = (value: unknown) =>
        typeof value === "string" && stripePlaceholders.has(value.trim().toLowerCase());
    const stripeKeyEnvironment = (value: unknown, prefix: "sk" | "pk") => {
        if (typeof value !== "string") return "unknown";
        const normalized = value.trim().toLowerCase();
        if (normalized === `${prefix}_test` || normalized.startsWith(`${prefix}_test_`)) return "test";
        if (normalized === `${prefix}_live` || normalized.startsWith(`${prefix}_live_`)) return "live";
        return "unknown";
    };
    const sslPlaceholders = new Set([
        "dummy",
        "test",
        "testbox",
        "qwerty",
        "password",
        "store_id",
        "storeid",
        "store_password",
        "storepass",
        "example",
        "placeholder",
        "demo",
        "123456",
        "000000",
        "xxxxxx",
        "__stored__",
    ]);
    const isSslPlaceholder = (value: unknown) =>
        typeof value === "string" && sslPlaceholders.has(value.trim().toLowerCase());
    const polarPlaceholders = new Set([
        "dummy",
        "placeholder",
        "example",
        "demo",
        "test",
        "polar_access_token",
        "polar_product_id",
        "polar_webhook_secret",
        "your_polar_token",
        "your_polar_access_token",
        "your_polar_product_id",
        "your_polar_webhook_secret",
    ]);
    const isPolarPlaceholder = (value: unknown) =>
        typeof value === "string" && polarPlaceholders.has(value.trim().toLowerCase());

    return {
        getKv: vi.fn(),
        getCredentialEncryptionKey: vi.fn(),
        requireEncryptionKey: vi.fn(),
        invalidateApiAndScheduleStorefrontGroups: vi.fn(),
        safeBatch: vi.fn(),
        upsertSetting: vi.fn(),
        upsertEncryptedSetting: vi.fn(),
        getPaymentMethodPreferences: vi.fn(),
        getActivePaymentMethods: vi.fn(),
        getStripeSettings: vi.fn(),
        getStripeCheckoutReadiness: vi.fn((settings: {
            enabled?: boolean;
            secretKey?: string;
            publishableKey?: string;
            webhookSecret?: string;
        } | null | undefined) => {
            const missingFields = [
                !settings?.secretKey?.trim() ? "secretKey" : null,
                !settings?.publishableKey?.trim() ? "publishableKey" : null,
                !settings?.webhookSecret?.trim() ? "webhookSecret" : null,
            ].filter((field): field is string => Boolean(field));
            const secretEnvironment = stripeKeyEnvironment(settings?.secretKey, "sk");
            const publishableEnvironment = stripeKeyEnvironment(settings?.publishableKey, "pk");
            const environmentMismatch = secretEnvironment !== "unknown"
                && publishableEnvironment !== "unknown"
                && secretEnvironment !== publishableEnvironment;
            const credentialErrors = [
                isStripePlaceholder(settings?.secretKey)
                    ? "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account."
                    : null,
                isStripePlaceholder(settings?.publishableKey)
                    ? "Stripe publishable key looks like a placeholder. Enter the real Stripe publishable key from your merchant account."
                    : null,
                isStripePlaceholder(settings?.webhookSecret)
                    ? "Stripe webhook secret looks like a placeholder. Enter the real Stripe webhook secret from your merchant account."
                    : null,
                environmentMismatch
                    ? "Stripe secret and publishable keys use different test/live environments. Choose a matching key pair."
                    : null,
            ].filter((error): error is string => Boolean(error));
            const labels: Record<string, string> = {
                secretKey: "secret key",
                publishableKey: "publishable key",
                webhookSecret: "webhook secret",
            };
            const enabled = settings?.enabled === true;
            return {
                configured: missingFields.length === 0 && credentialErrors.length === 0,
                enabled,
                usable: enabled && missingFields.length === 0 && credentialErrors.length === 0,
                missingFields,
                credentialErrors,
                blockedReason: credentialErrors[0] ?? (missingFields.length > 0
                    ? `Stripe needs ${missingFields.map((field) => labels[field] ?? field).join(", ")} before it can be shown at checkout.`
                    : undefined),
            };
        }),
        isStripeCheckoutUsable: vi.fn((settings: {
            enabled?: boolean;
            secretKey?: string;
            publishableKey?: string;
            webhookSecret?: string;
        } | null | undefined) => (
            settings?.enabled === true &&
            Boolean(settings.secretKey?.trim()) &&
            Boolean(settings.publishableKey?.trim()) &&
            Boolean(settings.webhookSecret?.trim()) &&
            !isStripePlaceholder(settings.secretKey) &&
            !isStripePlaceholder(settings.publishableKey) &&
            !isStripePlaceholder(settings.webhookSecret)
        )),
        isStripePlaceholderCredential: vi.fn(isStripePlaceholder),
        getSSLCommerzCheckoutReadiness: vi.fn((settings: {
            enabled?: boolean;
            storeId?: string;
            storePassword?: string;
            credentialErrors?: string[];
        } | null | undefined) => {
            const missingFields = [
                !settings?.storeId?.trim() ? "storeId" : null,
                !settings?.storePassword?.trim() ? "storePassword" : null,
            ].filter((field): field is string => Boolean(field));
            const credentialErrors = [
                ...(settings?.credentialErrors ?? []),
                isSslPlaceholder(settings?.storeId)
                    ? "SSLCommerz store ID looks like a placeholder. Enter the real SSLCommerz store ID from your merchant account."
                    : null,
                isSslPlaceholder(settings?.storePassword)
                    ? "SSLCommerz store password looks like a placeholder. Enter the real SSLCommerz store password from your merchant account."
                    : null,
            ].filter((error): error is string => Boolean(error));
            const labels: Record<string, string> = {
                storeId: "store ID",
                storePassword: "store password",
            };
            const enabled = settings?.enabled === true;
            return {
                configured: missingFields.length === 0 && credentialErrors.length === 0,
                enabled,
                usable: enabled && missingFields.length === 0 && credentialErrors.length === 0,
                missingFields,
                credentialErrors,
                blockedReason: credentialErrors[0] ?? (missingFields.length > 0
                    ? `SSLCommerz needs ${missingFields.map((field) => labels[field] ?? field).join(", ")} before it can be shown at checkout.`
                    : undefined),
            };
        }),
        isSSLCommerzCheckoutUsable: vi.fn((settings: {
            enabled?: boolean;
            storeId?: string;
            storePassword?: string;
        } | null | undefined) => (
            settings?.enabled === true &&
            Boolean(settings.storeId?.trim()) &&
            Boolean(settings.storePassword?.trim()) &&
            !isSslPlaceholder(settings.storeId) &&
            !isSslPlaceholder(settings.storePassword)
        )),
        getSSLCommerzSettings: vi.fn(),
        isSSLCommerzPlaceholderCredential: vi.fn(isSslPlaceholder),
        getPolarCheckoutReadiness: vi.fn((settings: {
            enabled?: boolean;
            accessToken?: string;
            productId?: string;
            webhookSecret?: string;
        } | null | undefined) => {
            const missingFields = [
                !settings?.accessToken?.trim() ? "accessToken" : null,
                !settings?.productId?.trim() ? "productId" : null,
                !settings?.webhookSecret?.trim() ? "webhookSecret" : null,
            ].filter((field): field is string => Boolean(field));
            const credentialErrors = [
                isPolarPlaceholder(settings?.accessToken)
                    ? "Polar access token looks like a placeholder. Enter the real Polar access token from your merchant account."
                    : null,
                isPolarPlaceholder(settings?.productId)
                    ? "Polar product ID looks like a placeholder. Enter the real Polar product ID from your merchant account."
                    : null,
                isPolarPlaceholder(settings?.webhookSecret)
                    ? "Polar webhook secret looks like a placeholder. Enter the real Polar webhook secret from your merchant account."
                    : null,
            ].filter((error): error is string => Boolean(error));
            const labels: Record<string, string> = {
                accessToken: "access token",
                productId: "product ID",
                webhookSecret: "webhook secret",
            };
            const enabled = settings?.enabled === true;
            return {
                configured: missingFields.length === 0 && credentialErrors.length === 0,
                enabled,
                usable: enabled && missingFields.length === 0 && credentialErrors.length === 0,
                missingFields,
                credentialErrors,
                blockedReason: credentialErrors[0] ?? (missingFields.length > 0
                    ? `Polar needs ${missingFields.map((field) => labels[field] ?? field).join(", ")} before it can be shown at checkout.`
                    : undefined),
            };
        }),
        isPolarCheckoutUsable: vi.fn((settings: {
            enabled?: boolean;
            accessToken?: string;
            productId?: string;
            webhookSecret?: string;
        } | null | undefined) => (
            settings?.enabled === true &&
            Boolean(settings.accessToken?.trim()) &&
            Boolean(settings.productId?.trim()) &&
            Boolean(settings.webhookSecret?.trim()) &&
            !isPolarPlaceholder(settings.accessToken) &&
            !isPolarPlaceholder(settings.productId) &&
            !isPolarPlaceholder(settings.webhookSecret)
        )),
        getPolarSettings: vi.fn(),
        isPolarPlaceholderCredential: vi.fn(isPolarPlaceholder),
        invalidatePaymentMethodsCache: vi.fn(),
        invalidateStripeCache: vi.fn(),
        invalidateSSLCommerzCache: vi.fn(),
        invalidatePolarCache: vi.fn(),
    };
});

vi.mock("../../../utils/kv-cache", () => ({
    getKv: mocks.getKv,
}));

vi.mock("../../../utils/encryption-key", () => ({
    getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
    requireEncryptionKey: mocks.requireEncryptionKey,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
    invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/database/client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@scalius/database/client")>()),
    safeBatch: mocks.safeBatch,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
    upsertSetting: mocks.upsertSetting,
    upsertEncryptedSetting: mocks.upsertEncryptedSetting,
    getPaymentMethodPreferences: mocks.getPaymentMethodPreferences,
    getActivePaymentMethods: mocks.getActivePaymentMethods,
    getStripeSettings: mocks.getStripeSettings,
    getStripeCheckoutReadiness: mocks.getStripeCheckoutReadiness,
    isStripeCheckoutUsable: mocks.isStripeCheckoutUsable,
    isStripePlaceholderCredential: mocks.isStripePlaceholderCredential,
    getSSLCommerzCheckoutReadiness: mocks.getSSLCommerzCheckoutReadiness,
    isSSLCommerzCheckoutUsable: mocks.isSSLCommerzCheckoutUsable,
    getSSLCommerzSettings: mocks.getSSLCommerzSettings,
    isSSLCommerzPlaceholderCredential: mocks.isSSLCommerzPlaceholderCredential,
    getPolarCheckoutReadiness: mocks.getPolarCheckoutReadiness,
    isPolarCheckoutUsable: mocks.isPolarCheckoutUsable,
    isPolarPlaceholderCredential: mocks.isPolarPlaceholderCredential,
    getPolarSettings: mocks.getPolarSettings,
    invalidatePaymentMethodsCache: mocks.invalidatePaymentMethodsCache,
    invalidateStripeCache: mocks.invalidateStripeCache,
    invalidateSSLCommerzCache: mocks.invalidateSSLCommerzCache,
    invalidatePolarCache: mocks.invalidatePolarCache,
}));

import { paymentSettingsRoutes } from "./payments";

function createTestApp(
    siteSettingsOverrides: Record<string, unknown> = {},
    settingRows: Array<{ key: string; value: string }> = [],
) {
    const db = {
        id: "db",
        select: vi.fn(() => ({
            from: vi.fn(() => ({
                limit: vi.fn(async () => [{
                    checkoutMode: "all",
                    partialPaymentEnabled: false,
                    partialPaymentAmount: 0,
                    ...siteSettingsOverrides,
                }]),
                where: vi.fn(() => ({
                    all: vi.fn(async () => settingRows),
                })),
            })),
        })),
        insert: vi.fn(() => ({
            values: vi.fn(() => ({
                onConflictDoUpdate: vi.fn(() => ({ statement: "upsert-payment-method-setting" })),
            })),
        })),
    };
    const kv = { id: "gateway-kv" };
    const env = {
        CACHE: { id: "api-cache-kv" },
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
        JWT_SECRET: "test-jwt-secret",
    } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

    mocks.getKv.mockReturnValue(kv);
    mocks.getCredentialEncryptionKey.mockReturnValue("enc-key");
    mocks.requireEncryptionKey.mockReturnValue("credential-key");
    mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
    mocks.safeBatch.mockResolvedValue([]);
    mocks.upsertSetting.mockResolvedValue(undefined);
    mocks.upsertEncryptedSetting.mockResolvedValue(undefined);
    mocks.invalidatePaymentMethodsCache.mockResolvedValue(undefined);
    mocks.invalidateStripeCache.mockResolvedValue(undefined);
    mocks.invalidateSSLCommerzCache.mockResolvedValue(undefined);
    mocks.invalidatePolarCache.mockResolvedValue(undefined);
    mocks.getPaymentMethodPreferences.mockResolvedValue({
        enabledMethods: ["cod"],
        defaultMethod: "cod",
        hasExplicitEnabledMethods: true,
    });
    mocks.getActivePaymentMethods.mockResolvedValue({ enabledMethods: ["cod"], defaultMethod: "cod" });
    mocks.getStripeSettings.mockResolvedValue(null);
    mocks.getSSLCommerzSettings.mockResolvedValue(null);
    mocks.getPolarSettings.mockResolvedValue(null);

    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    app.route("/admin/settings", paymentSettingsRoutes);
    return { app, env, kv };
}

async function postJson(app: OpenAPIHono<{ Bindings: Env }>, env: Env, path: string, body: unknown) {
    return app.request(
        `/api/v1/admin/settings${path}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
        env,
    );
}

async function getJson(app: OpenAPIHono<{ Bindings: Env }>, env: Env, path: string) {
    return app.request(
        `/api/v1/admin/settings${path}`,
        { method: "GET" },
        env,
    );
}

describe("payment settings cache invalidation", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("invalidates API and storefront checkout caches after payment method saves", async () => {
        const { app, env, kv } = createTestApp();
        mocks.getStripeSettings.mockResolvedValueOnce({
            enabled: true,
            secretKey: "sk_live_existing",
            publishableKey: "pk_live_existing",
            webhookSecret: "whsec_existing",
        });

        const response = await postJson(app, env, "/payment-methods", {
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        });

        expect(response.status).toBe(200);
        expect(mocks.safeBatch).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            expect.arrayContaining([
                expect.objectContaining({ statement: "upsert-payment-method-setting" }),
            ]),
        );
        expect(mocks.safeBatch.mock.calls[0]?.[1]).toHaveLength(2);
        expect(mocks.invalidatePaymentMethodsCache).toHaveBeenCalledWith(kv);
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["checkout"],
            expect.objectContaining({ env }),
        );
    });

    it("allows an intentional COD-only save in standard checkout mode", async () => {
        const { app, env } = createTestApp();

        const response = await postJson(app, env, "/payment-methods", {
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        expect(response.status, await response.clone().text()).toBe(200);
        expect(mocks.safeBatch).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            expect.arrayContaining([
                expect.objectContaining({ statement: "upsert-payment-method-setting" }),
            ]),
        );
        expect(mocks.safeBatch.mock.calls[0]?.[1]).toHaveLength(2);
    });

    it("reports Stripe as not checkout-configured without a publishable key", async () => {
        const { app, env } = createTestApp();
        mocks.getStripeSettings.mockResolvedValueOnce({
            enabled: true,
            secretKey: "sk_live_existing",
            publishableKey: "",
            webhookSecret: "whsec_existing",
        });

        const response = await getJson(app, env, "/payment-methods");

        expect(response.status, await response.clone().text()).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            data: {
                gatewayStatus: {
                    stripe: {
                        configured: false,
                        enabled: true,
                        usable: false,
                        environment: "live",
                        missingFields: ["publishableKey"],
                    },
                },
            },
        });
    });

    it("returns raw selected methods separately from effective active checkout methods", async () => {
        const { app, env } = createTestApp();
        mocks.getPaymentMethodPreferences.mockResolvedValueOnce({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
            hasExplicitEnabledMethods: true,
        });
        mocks.getActivePaymentMethods.mockResolvedValueOnce({
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });
        mocks.getStripeSettings.mockResolvedValueOnce({
            enabled: true,
            secretKey: "sk_live_existing",
            publishableKey: "",
            webhookSecret: "whsec_existing",
        });

        const response = await getJson(app, env, "/payment-methods");

        expect(response.status, await response.clone().text()).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            data: {
                enabledMethods: ["stripe", "cod"],
                defaultMethod: "stripe",
                activeMethods: ["cod"],
                activeDefaultMethod: "cod",
                gatewayStatus: {
                    stripe: {
                        configured: false,
                        enabled: true,
                        usable: false,
                        checkoutSelected: true,
                        checkoutVisible: false,
                        missingFields: ["publishableKey"],
                    },
                    cod: {
                        checkoutSelected: true,
                        checkoutVisible: true,
                    },
                },
            },
        });
    });

    it("filters buyer-visible active methods through checkout flow rules", async () => {
        const { app, env } = createTestApp({
            partialPaymentEnabled: true,
            partialPaymentAmount: 500,
        });
        mocks.getPaymentMethodPreferences.mockResolvedValueOnce({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "cod",
            hasExplicitEnabledMethods: true,
        });
        mocks.getActivePaymentMethods.mockResolvedValueOnce({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "cod",
        });
        mocks.getStripeSettings.mockResolvedValueOnce({
            enabled: true,
            secretKey: "sk_live_existing",
            publishableKey: "pk_live_existing",
            webhookSecret: "whsec_existing",
        });

        const response = await getJson(app, env, "/payment-methods");

        expect(response.status, await response.clone().text()).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            data: {
                enabledMethods: ["stripe", "cod"],
                defaultMethod: "cod",
                activeMethods: ["stripe"],
                activeDefaultMethod: "stripe",
                gatewayStatus: {
                    stripe: {
                        checkoutSelected: true,
                        checkoutVisible: true,
                        environment: "live",
                    },
                    cod: {
                        checkoutSelected: true,
                        checkoutVisible: false,
                        environment: "not_applicable",
                    },
                },
            },
        });
    });

    it("rejects removing every configured online gateway while partial payments are enabled", async () => {
        const { app, env } = createTestApp({
            partialPaymentEnabled: true,
            partialPaymentAmount: 500,
        });

        const response = await postJson(app, env, "/payment-methods", {
            enabledMethods: ["cod"],
            defaultMethod: "cod",
        });

        expect(response.status, await response.clone().text()).toBe(400);
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.invalidatePaymentMethodsCache).not.toHaveBeenCalled();
    });

    it("rejects saving a default method hidden by the current checkout flow", async () => {
        const { app, env } = createTestApp({
            partialPaymentEnabled: true,
            partialPaymentAmount: 500,
        });
        mocks.getStripeSettings.mockResolvedValueOnce({
            enabled: true,
            secretKey: "sk_live_existing",
            publishableKey: "pk_live_existing",
            webhookSecret: "whsec_existing",
        });

        const response = await postJson(app, env, "/payment-methods", {
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "cod",
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "Default method is hidden by the current checkout flow settings.",
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.safeBatch).not.toHaveBeenCalled();
        expect(mocks.invalidatePaymentMethodsCache).not.toHaveBeenCalled();
    });

    it("invalidates API and storefront checkout caches after Stripe saves", async () => {
        const { app, env, kv } = createTestApp({}, [
            { key: "secret_key", value: "encrypted-secret" },
            { key: "webhook_secret", value: "encrypted-webhook" },
        ]);

        const response = await postJson(app, env, "/stripe", {
            publishableKey: "pk_test",
            enabled: true,
        });

        expect(response.status).toBe(200);
        expect(mocks.invalidateStripeCache).toHaveBeenCalledWith(kv);
        expect(mocks.invalidatePaymentMethodsCache).toHaveBeenCalledWith(kv);
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["checkout"],
            expect.objectContaining({ env }),
        );
        expect(mocks.requireEncryptionKey).not.toHaveBeenCalled();
    });

    it("rejects enabling Stripe when the effective publishable key is missing", async () => {
        const { app, env } = createTestApp({}, [
            { key: "secret_key", value: "encrypted-secret" },
            { key: "webhook_secret", value: "encrypted-webhook" },
        ]);

        const response = await postJson(app, env, "/stripe", {
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("publishable key"),
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateStripeCache).not.toHaveBeenCalled();
    });

    it("rejects enabling Stripe with submitted placeholder credentials", async () => {
        const { app, env } = createTestApp();

        const response = await postJson(app, env, "/stripe", {
            secretKey: "stripe_secret_key",
            publishableKey: "pk_live_public",
            webhookSecret: "whsec_live",
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account.",
            },
        });
        expect(mocks.requireEncryptionKey).not.toHaveBeenCalled();
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.upsertEncryptedSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateStripeCache).not.toHaveBeenCalled();
    });

    it("rejects a new live publishable key paired with a retained test secret", async () => {
        const { app, env } = createTestApp({}, [
            { key: "secret_key", value: "encrypted-secret" },
            { key: "publishable_key", value: "pk_test_existing" },
            { key: "webhook_secret", value: "encrypted-webhook" },
            { key: "enabled", value: "true" },
        ]);
        mocks.getStripeSettings.mockResolvedValueOnce({
            secretKey: "sk_test_existing",
            publishableKey: "pk_test_existing",
            webhookSecret: "whsec_existing",
            enabled: true,
        });

        const response = await postJson(app, env, "/stripe", {
            publishableKey: "pk_live_replacement",
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "Stripe secret and publishable keys use different test/live environments. Choose a matching key pair.",
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateStripeCache).not.toHaveBeenCalled();
    });

    it("rejects enabling Stripe when a masked stored credential is a placeholder", async () => {
        const { app, env } = createTestApp({}, [
            { key: "secret_key", value: "sk_test_your_key_here" },
            { key: "publishable_key", value: "pk_live_public" },
            { key: "webhook_secret", value: "whsec_live" },
            { key: "enabled", value: "false" },
        ]);

        const response = await postJson(app, env, "/stripe", {
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account.",
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.upsertEncryptedSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateStripeCache).not.toHaveBeenCalled();
    });

    it("requires the credential encryption key before saving Stripe secrets", async () => {
        const { app, env } = createTestApp();

        const response = await postJson(app, env, "/stripe", {
            secretKey: "sk_live_new",
            webhookSecret: "whsec_new",
        });

        expect(response.status, await response.clone().text()).toBe(200);
        expect(mocks.requireEncryptionKey).toHaveBeenCalledWith(env);
        expect(mocks.upsertEncryptedSetting).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            "stripe",
            "secret_key",
            "sk_live_new",
            "credential-key",
        );
        expect(mocks.upsertEncryptedSetting).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            "stripe",
            "webhook_secret",
            "whsec_new",
            "credential-key",
        );
    });

    it("rejects disabling the last configured online gateway while partial payments are enabled", async () => {
        const { app, env } = createTestApp({
            partialPaymentEnabled: true,
            partialPaymentAmount: 500,
        });
        mocks.getActivePaymentMethods.mockResolvedValueOnce({
            enabledMethods: ["stripe", "cod"],
            defaultMethod: "stripe",
        });

        const response = await postJson(app, env, "/stripe", {
            enabled: false,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateStripeCache).not.toHaveBeenCalled();
    });

    it("allows disabling one online gateway while partial payments still have another online gateway", async () => {
        const { app, env, kv } = createTestApp({
            partialPaymentEnabled: true,
            partialPaymentAmount: 500,
        });
        mocks.getActivePaymentMethods.mockResolvedValueOnce({
            enabledMethods: ["stripe", "sslcommerz", "cod"],
            defaultMethod: "sslcommerz",
        });

        const response = await postJson(app, env, "/stripe", {
            enabled: false,
        });

        expect(response.status, await response.clone().text()).toBe(200);
        expect(mocks.upsertSetting).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            "stripe",
            "enabled",
            "false",
        );
        expect(mocks.invalidateStripeCache).toHaveBeenCalledWith(kv);
    });

    it("invalidates API and storefront checkout caches after SSLCommerz saves", async () => {
        const { app, env, kv } = createTestApp({}, [
            { key: "store_password", value: "encrypted-password" },
        ]);
        mocks.getSSLCommerzSettings.mockResolvedValueOnce({
            enabled: true,
            storeId: "store-id",
            storePassword: "stored-real-password",
            sandbox: true,
        });

        const response = await postJson(app, env, "/sslcommerz", {
            storeId: "store-id",
            sandbox: true,
            enabled: true,
        });

        expect(response.status).toBe(200);
        expect(mocks.invalidateSSLCommerzCache).toHaveBeenCalledWith(kv);
        expect(mocks.invalidatePaymentMethodsCache).toHaveBeenCalledWith(kv);
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["checkout"],
            expect.objectContaining({ env }),
        );
        expect(mocks.requireEncryptionKey).not.toHaveBeenCalled();
    });

    it("rejects enabling SSLCommerz when the effective store password is missing", async () => {
        const { app, env } = createTestApp();

        const response = await postJson(app, env, "/sslcommerz", {
            storeId: "store-id",
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("store password"),
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateSSLCommerzCache).not.toHaveBeenCalled();
    });

    it("rejects enabling SSLCommerz with submitted placeholder credentials", async () => {
        const { app, env } = createTestApp();

        const response = await postJson(app, env, "/sslcommerz", {
            storeId: "dummy",
            storePassword: "real-store-password",
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "SSLCommerz store ID looks like a placeholder. Enter the real SSLCommerz store ID from your merchant account.",
            },
        });
        expect(mocks.requireEncryptionKey).not.toHaveBeenCalled();
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.upsertEncryptedSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateSSLCommerzCache).not.toHaveBeenCalled();
    });

    it("rejects enabling SSLCommerz when a masked stored credential is a placeholder", async () => {
        const { app, env } = createTestApp({}, [
            { key: "store_id", value: "real_store_123" },
            { key: "store_password", value: "password" },
            { key: "enabled", value: "false" },
        ]);
        mocks.getSSLCommerzSettings.mockResolvedValueOnce({
            enabled: false,
            storeId: "real_store_123",
            storePassword: "password",
            sandbox: true,
        });

        const response = await postJson(app, env, "/sslcommerz", {
            storePassword: "\u2022".repeat(12),
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "SSLCommerz store password looks like a placeholder. Enter the real SSLCommerz store password from your merchant account.",
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.upsertEncryptedSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateSSLCommerzCache).not.toHaveBeenCalled();
    });

    it("requires the credential encryption key before saving SSLCommerz secrets", async () => {
        const { app, env } = createTestApp();

        const response = await postJson(app, env, "/sslcommerz", {
            storePassword: "ssl_secret",
        });

        expect(response.status, await response.clone().text()).toBe(200);
        expect(mocks.requireEncryptionKey).toHaveBeenCalledWith(env);
        expect(mocks.upsertEncryptedSetting).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            "sslcommerz",
            "store_password",
            "ssl_secret",
            "credential-key",
        );
    });

    it("invalidates API and storefront checkout caches after Polar saves", async () => {
        const { app, env, kv } = createTestApp({}, [
            { key: "access_token", value: "encrypted-token" },
            { key: "webhook_secret", value: "encrypted-webhook" },
        ]);

        const response = await postJson(app, env, "/polar", {
            productId: "product-id",
            sandbox: true,
            enabled: true,
        });

        expect(response.status).toBe(200);
        expect(mocks.invalidatePolarCache).toHaveBeenCalledWith(kv);
        expect(mocks.invalidatePaymentMethodsCache).toHaveBeenCalledWith(kv);
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["checkout"],
            expect.objectContaining({ env }),
        );
        expect(mocks.requireEncryptionKey).not.toHaveBeenCalled();
    });

    it("rejects enabling Polar when the effective webhook secret is missing", async () => {
        const { app, env } = createTestApp({}, [
            { key: "access_token", value: "encrypted-token" },
            { key: "product_id", value: "product-id" },
        ]);

        const response = await postJson(app, env, "/polar", {
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("webhook secret"),
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.invalidatePolarCache).not.toHaveBeenCalled();
    });

    it("rejects enabling Polar with submitted placeholder credentials", async () => {
        const { app, env } = createTestApp();

        const response = await postJson(app, env, "/polar", {
            accessToken: "polar_access_token",
            productId: "polar_product_live",
            webhookSecret: "polar_webhook_live",
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "Polar access token looks like a placeholder. Enter the real Polar access token from your merchant account.",
            },
        });
        expect(mocks.requireEncryptionKey).not.toHaveBeenCalled();
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.upsertEncryptedSetting).not.toHaveBeenCalled();
        expect(mocks.invalidatePolarCache).not.toHaveBeenCalled();
    });

    it("rejects enabling Polar when a masked stored credential is a placeholder", async () => {
        const { app, env } = createTestApp({}, [
            { key: "access_token", value: "your_polar_token" },
            { key: "product_id", value: "polar_product_live" },
            { key: "webhook_secret", value: "polar_webhook_live" },
            { key: "enabled", value: "false" },
        ]);

        const response = await postJson(app, env, "/polar", {
            enabled: true,
        });

        expect(response.status, await response.clone().text()).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "Polar access token looks like a placeholder. Enter the real Polar access token from your merchant account.",
            },
        });
        expect(mocks.upsertSetting).not.toHaveBeenCalled();
        expect(mocks.upsertEncryptedSetting).not.toHaveBeenCalled();
        expect(mocks.invalidatePolarCache).not.toHaveBeenCalled();
    });

    it("requires the credential encryption key before saving Polar secrets", async () => {
        const { app, env } = createTestApp();

        const response = await postJson(app, env, "/polar", {
            accessToken: "polar_token",
            webhookSecret: "polar_webhook",
        });

        expect(response.status, await response.clone().text()).toBe(200);
        expect(mocks.requireEncryptionKey).toHaveBeenCalledWith(env);
        expect(mocks.upsertEncryptedSetting).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            "polar",
            "access_token",
            "polar_token",
            "credential-key",
        );
        expect(mocks.upsertEncryptedSetting).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            "polar",
            "webhook_secret",
            "polar_webhook",
            "credential-key",
        );
    });

    it.each([
        ["/stripe", { secretKey: "sk_live_missing_key" }],
        ["/sslcommerz", { storePassword: "ssl_secret_missing_key" }],
        ["/polar", { accessToken: "polar_token_missing_key" }],
    ])("fails closed before saving %s secrets when CREDENTIAL_ENCRYPTION_KEY is missing", async (path, body) => {
        const { app, env } = createTestApp();
        mocks.requireEncryptionKey.mockImplementationOnce(() => {
            throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
        });

        const response = await postJson(app, env, path, body);

        expect(response.status, await response.clone().text()).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: {
                code: "SERVICE_UNAVAILABLE",
                message: "CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.",
            },
        });
        expect(mocks.upsertEncryptedSetting).not.toHaveBeenCalled();
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
    });
});
