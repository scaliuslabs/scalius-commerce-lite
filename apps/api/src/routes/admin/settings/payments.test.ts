import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
    getKv: vi.fn(),
    getEncryptionKey: vi.fn(),
    invalidateApiAndScheduleStorefrontGroups: vi.fn(),
    upsertSetting: vi.fn(),
    upsertEncryptedSetting: vi.fn(),
    getActivePaymentMethods: vi.fn(),
    getStripeSettings: vi.fn(),
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
}));

vi.mock("../../../utils/cache-invalidation", () => ({
    invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
    upsertSetting: mocks.upsertSetting,
    upsertEncryptedSetting: mocks.upsertEncryptedSetting,
    getActivePaymentMethods: mocks.getActivePaymentMethods,
    getStripeSettings: mocks.getStripeSettings,
    getSSLCommerzSettings: mocks.getSSLCommerzSettings,
    getPolarSettings: mocks.getPolarSettings,
    invalidatePaymentMethodsCache: mocks.invalidatePaymentMethodsCache,
    invalidateStripeCache: mocks.invalidateStripeCache,
    invalidateSSLCommerzCache: mocks.invalidateSSLCommerzCache,
    invalidatePolarCache: mocks.invalidatePolarCache,
}));

import { paymentSettingsRoutes } from "./payments";

function createTestApp() {
    const db = { id: "db" };
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
    mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
    mocks.upsertSetting.mockResolvedValue(undefined);
    mocks.upsertEncryptedSetting.mockResolvedValue(undefined);
    mocks.invalidatePaymentMethodsCache.mockResolvedValue(undefined);
    mocks.invalidateStripeCache.mockResolvedValue(undefined);
    mocks.invalidateSSLCommerzCache.mockResolvedValue(undefined);
    mocks.invalidatePolarCache.mockResolvedValue(undefined);

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

describe("payment settings cache invalidation", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("invalidates API and storefront checkout caches after payment method saves", async () => {
        const { app, env, kv } = createTestApp();

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

    it("invalidates API and storefront checkout caches after Stripe saves", async () => {
        const { app, env, kv } = createTestApp();

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
    });
});
