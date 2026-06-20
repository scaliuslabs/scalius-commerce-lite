import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";
import { ServiceUnavailableError } from "../../../utils/api-error";

const mocks = vi.hoisted(() => ({
    getKv: vi.fn(),
    getEncryptionKey: vi.fn(),
    requireEncryptionKey: vi.fn(),
    invalidateApiAndScheduleStorefrontGroups: vi.fn(),
    upsertSetting: vi.fn(),
    upsertEncryptedSetting: vi.fn(),
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
        const labels: Record<string, string> = {
            secretKey: "secret key",
            publishableKey: "publishable key",
            webhookSecret: "webhook secret",
        };
        const enabled = settings?.enabled === true;
        return {
            configured: missingFields.length === 0,
            enabled,
            usable: enabled && missingFields.length === 0,
            missingFields,
            blockedReason: missingFields.length > 0
                ? `Stripe needs ${missingFields.map((field) => labels[field] ?? field).join(", ")} before it can be shown at checkout.`
                : undefined,
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
        Boolean(settings.webhookSecret?.trim())
    )),
    getSSLCommerzSettings: vi.fn(),
    getPolarSettings: vi.fn(),
    invalidatePaymentMethodsCache: vi.fn(),
    invalidateStripeCache: vi.fn(),
    invalidateSSLCommerzCache: vi.fn(),
    invalidatePolarCache: vi.fn(),
}));

vi.mock("../../../utils/kv-cache", () => ({
    getKv: mocks.getKv,
}));

vi.mock("../../../utils/encryption-key", () => ({
    getEncryptionKey: mocks.getEncryptionKey,
    requireEncryptionKey: mocks.requireEncryptionKey,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
    invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
    upsertSetting: mocks.upsertSetting,
    upsertEncryptedSetting: mocks.upsertEncryptedSetting,
    getActivePaymentMethods: mocks.getActivePaymentMethods,
    getStripeSettings: mocks.getStripeSettings,
    getStripeCheckoutReadiness: mocks.getStripeCheckoutReadiness,
    isStripeCheckoutUsable: mocks.isStripeCheckoutUsable,
    getSSLCommerzSettings: mocks.getSSLCommerzSettings,
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
    mocks.getEncryptionKey.mockReturnValue("enc-key");
    mocks.requireEncryptionKey.mockReturnValue("credential-key");
    mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
    mocks.upsertSetting.mockResolvedValue(undefined);
    mocks.upsertEncryptedSetting.mockResolvedValue(undefined);
    mocks.invalidatePaymentMethodsCache.mockResolvedValue(undefined);
    mocks.invalidateStripeCache.mockResolvedValue(undefined);
    mocks.invalidateSSLCommerzCache.mockResolvedValue(undefined);
    mocks.invalidatePolarCache.mockResolvedValue(undefined);
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
        expect(mocks.invalidatePaymentMethodsCache).toHaveBeenCalledWith(kv);
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["checkout"],
            expect.objectContaining({ env }),
        );
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
                        missingFields: ["publishableKey"],
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
        const { app, env, kv } = createTestApp();

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
        const { app, env, kv } = createTestApp();

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
