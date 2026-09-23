import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getSSLCommerzSettings, getStripeSettings } from "@scalius/core/modules/payments/gateway-settings";
import { saveSettingAggregate } from "@scalius/core/modules/settings/settings-write";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
    bumpCacheGeneration: vi.fn(async () => undefined),
}));

vi.mock("../../../utils/cache-generation", () => ({
    bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import { paymentSettingsRoutes } from "./payments";

const CREDENTIAL_ENCRYPTION_KEY = btoa("p".repeat(32));
const MASKED = "••••••••••••";
const SECRET_KEYS = new Set(["secret_key", "webhook_secret", "store_password"]);

const liveStripe = { secret_key: "sk_live_existing", publishable_key: "pk_live_existing", webhook_secret: "whsec_existing", enabled: "true" };
const liveSsl = { store_id: "real_store_123", store_password: "stored-real-password", sandbox: "false", enabled: "true" };

type Stored = Partial<Record<"stripe" | "sslcommerz" | "payment_methods" | "currency", Record<string, string>>>;

async function createTestApp(stored: Stored = {}, site: { partialPaymentEnabled?: boolean } = {}) {
    let failNextBatch = false;
    const { sqlite, db } = createSqliteD1Database({
        beforeBatch: () => {
            if (!failNextBatch) return;
            failNextBatch = false;
            throw new Error("atomic batch failed");
        },
    });
    sqlite.prepare(`INSERT INTO site_settings (id, site_name, header_config, footer_config, checkout_mode,
        partial_payment_enabled, partial_payment_amount) VALUES ('default', 'Store', '{}', '{}', 'all', ?, ?)`)
        .run(site.partialPaymentEnabled ? 1 : 0, site.partialPaymentEnabled ? 500 : 0);
    const writes = Object.entries(stored).flatMap(([category, values]) =>
        Object.entries(values).map(([key, value]) => ({ category, key, value, encrypted: SECRET_KEYS.has(key) })));
    await saveSettingAggregate(db, writes, CREDENTIAL_ENCRYPTION_KEY);

    const env = { CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db);
        await next();
    });
    app.route("/admin/settings", paymentSettingsRoutes);

    const request = (path: string, body?: unknown, requestEnv: Env = env) => app.request(
        `/api/v1/admin/settings${path}`,
        body === undefined
            ? { method: "GET" }
            : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        requestEnv,
    );
    return { request, db, sqlite, failNextBatch: () => { failNextBatch = true; } };
}

function storedRows(sqlite: DatabaseSync, category: string) {
    return Object.fromEntries((sqlite.prepare("SELECT key, value FROM settings WHERE category = ?").all(category) as Array<{
        key: string;
        value: string;
    }>).map((row) => [row.key, row.value]));
}

async function expectValidationError(response: Response, message?: string) {
    expect(response.status, await response.clone().text()).toBe(400);
    if (message) {
        await expect(response.json()).resolves.toMatchObject({
            success: false,
            error: { code: "VALIDATION_ERROR", message },
        });
    }
}

describe("payment settings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("reads", () => {
        it("never returns stored gateway secrets from configuration reads", async () => {
            const { request } = await createTestApp({ stripe: liveStripe, sslcommerz: liveSsl });

            const [stripeResponse, sslResponse] = await Promise.all([request("/stripe"), request("/sslcommerz")]);

            await expect(stripeResponse.json()).resolves.toMatchObject({
                data: { secretKey: MASKED, publishableKey: "pk_live_existing", webhookSecret: MASKED },
            });
            const ssl = await sslResponse.json() as { data: Record<string, unknown> };
            expect(ssl.data).toMatchObject({ storeId: "real_store_123", storePassword: MASKED });
            expect(JSON.stringify(ssl)).not.toContain("stored-real-password");
        });

        it("returns raw selected methods separately from effective active checkout methods", async () => {
            const { request } = await createTestApp({
                stripe: { ...liveStripe, publishable_key: "" },
                payment_methods: { enabled_methods: JSON.stringify(["stripe", "cod"]), default_method: "stripe" },
            });

            const response = await request("/payment-methods");

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
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
                            environment: "live",
                            missingFields: ["publishableKey"],
                            checkoutSelected: true,
                            checkoutVisible: false,
                        },
                        cod: { checkoutSelected: true, checkoutVisible: true },
                    },
                },
            });
        });

        it("filters buyer-visible active methods through checkout flow rules", async () => {
            const { request } = await createTestApp({
                stripe: liveStripe,
                payment_methods: { enabled_methods: JSON.stringify(["stripe", "cod"]), default_method: "cod" },
            }, { partialPaymentEnabled: true });

            await expect((await request("/payment-methods")).json()).resolves.toMatchObject({
                data: {
                    activeMethods: ["stripe"],
                    activeDefaultMethod: "stripe",
                    gatewayStatus: {
                        stripe: { checkoutSelected: true, checkoutVisible: true, environment: "live" },
                        cod: { checkoutSelected: true, checkoutVisible: false, environment: "not_applicable" },
                    },
                },
            });
        });

        it("excludes a configured SSLCommerz method from dashboard checkout readiness outside BDT", async () => {
            const { request } = await createTestApp({
                sslcommerz: liveSsl,
                currency: { currency_code: "USD" },
                payment_methods: { enabled_methods: JSON.stringify(["sslcommerz", "cod"]), default_method: "sslcommerz" },
            });

            await expect((await request("/payment-methods")).json()).resolves.toMatchObject({
                data: {
                    activeMethods: ["cod"],
                    activeDefaultMethod: "cod",
                    gatewayStatus: {
                        sslcommerz: {
                            configured: true,
                            usable: false,
                            checkoutVisible: false,
                            blockedReason: "SSLCommerz checkout requires the store currency to be BDT. Current currency: USD.",
                        },
                    },
                },
            });
        });
    });

    describe("payment method saves", () => {
        it("persists methods and invalidates checkout caches only after the save", async () => {
            const { request, sqlite } = await createTestApp({ stripe: liveStripe });

            const response = await request("/payment-methods", { enabledMethods: ["stripe", "cod"], defaultMethod: "stripe" });

            expect(response.status).toBe(200);
            expect(storedRows(sqlite, "payment_methods")).toEqual({
                enabled_methods: JSON.stringify(["stripe", "cod"]),
                default_method: "stripe",
            });
            expect(mocks.bumpCacheGeneration).toHaveBeenCalledWith(expect.anything());
        });

        it("allows an intentional COD-only save in standard checkout mode", async () => {
            const { request } = await createTestApp();
            expect((await request("/payment-methods", { enabledMethods: ["cod"], defaultMethod: "cod" })).status).toBe(200);
        });

        it.each([
            ["duplicate methods", {}, {}, { enabledMethods: ["cod", "cod"], defaultMethod: "cod" }, undefined],
            ["SSLCommerz outside BDT", { sslcommerz: liveSsl, currency: { currency_code: "USD" } }, {},
                { enabledMethods: ["sslcommerz", "cod"], defaultMethod: "sslcommerz" },
                "SSLCommerz checkout requires the store currency to be BDT. Current currency: USD."],
            ["removing every online gateway under partial payments", {}, { partialPaymentEnabled: true },
                { enabledMethods: ["cod"], defaultMethod: "cod" }, undefined],
            ["a default method hidden by the checkout flow", { stripe: liveStripe }, { partialPaymentEnabled: true },
                { enabledMethods: ["stripe", "cod"], defaultMethod: "cod" },
                "Default method is hidden by the current checkout flow settings."],
        ] as const)("rejects %s without persisting", async (_, stored, site, body, message) => {
            const { request, sqlite } = await createTestApp(stored as Stored, site);

            await expectValidationError(await request("/payment-methods", body), message);
            expect(storedRows(sqlite, "payment_methods")).toEqual({});
            expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
        });
    });

    describe("gateway credential saves", () => {
        it("encrypts a complete Stripe credential rotation in one atomic aggregate", async () => {
            const { request, db, sqlite } = await createTestApp();

            const response = await request("/stripe", {
                secretKey: "sk_test_replacement",
                publishableKey: "pk_test_replacement",
                webhookSecret: "whsec_replacement",
                enabled: true,
            });

            expect(response.status, await response.clone().text()).toBe(200);
            const raw = storedRows(sqlite, "stripe");
            expect(raw.secret_key).not.toContain("sk_test_replacement");
            expect(raw.webhook_secret).not.toContain("whsec_replacement");
            await expect(getStripeSettings(db, CREDENTIAL_ENCRYPTION_KEY)).resolves.toMatchObject({
                secretKey: "sk_test_replacement",
                publishableKey: "pk_test_replacement",
                webhookSecret: "whsec_replacement",
                enabled: true,
            });
            expect(mocks.bumpCacheGeneration).toHaveBeenCalledWith(expect.anything());
        });

        it("encrypts SSLCommerz store passwords and keeps masked updates on the stored secret", async () => {
            const { request, db, sqlite } = await createTestApp();

            expect((await request("/sslcommerz", { storeId: "real_store_123", storePassword: "ssl_secret" })).status).toBe(200);
            expect((await request("/sslcommerz", { storePassword: MASKED, sandbox: true, enabled: true })).status).toBe(200);

            expect(storedRows(sqlite, "sslcommerz").store_password).not.toContain("ssl_secret");
            await expect(getSSLCommerzSettings(db, CREDENTIAL_ENCRYPTION_KEY)).resolves.toMatchObject({
                storeId: "real_store_123",
                storePassword: "ssl_secret",
                sandbox: true,
                enabled: true,
            });
        });

        it.each([
            ["/stripe", { secretKey: "sk_live_missing_key" }],
            ["/sslcommerz", { storePassword: "ssl_secret_missing_key" }],
        ])("fails closed before saving %s secrets when CREDENTIAL_ENCRYPTION_KEY is missing", async (path, body) => {
            const { request, sqlite } = await createTestApp();

            const response = await request(path, body, {} as Env);

            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toMatchObject({
                error: { code: "SERVICE_UNAVAILABLE", message: "CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials." },
            });
            expect(storedRows(sqlite, path.slice(1))).toEqual({});
            expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
        });

        it("does not invalidate checkout caches when the atomic gateway save fails", async () => {
            const { request, sqlite, failNextBatch } = await createTestApp({ stripe: liveStripe });
            failNextBatch();

            const response = await request("/stripe", { publishableKey: "pk_live_replacement" });

            expect(response.status).toBe(500);
            expect(storedRows(sqlite, "stripe").publishable_key).toBe("pk_live_existing");
            expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
        });

        it.each([
            ["Stripe without an effective publishable key", "/stripe",
                { stripe: { secret_key: "sk_live_existing", webhook_secret: "whsec_existing" } }, { enabled: true },
                undefined],
            ["Stripe with submitted placeholder credentials", "/stripe", {},
                { secretKey: "stripe_secret_key", publishableKey: "pk_live_public", webhookSecret: "whsec_live", enabled: true },
                "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account."],
            ["a live publishable key paired with a retained test secret", "/stripe",
                { stripe: { ...liveStripe, secret_key: "sk_test_existing", publishable_key: "pk_test_existing" } },
                { publishableKey: "pk_live_replacement", enabled: true },
                "Stripe secret and publishable keys use different test/live environments. Choose a matching key pair."],
            ["Stripe when a masked stored credential is a placeholder", "/stripe",
                { stripe: { ...liveStripe, secret_key: "sk_test_your_key_here", enabled: "false" } }, { enabled: true },
                "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account."],
            ["SSLCommerz without an effective store password", "/sslcommerz", {},
                { storeId: "store-id", enabled: true }, undefined],
            ["SSLCommerz with submitted placeholder credentials", "/sslcommerz", {},
                { storeId: "dummy", storePassword: "real-store-password", enabled: true },
                "SSLCommerz store ID looks like a placeholder. Enter the real SSLCommerz store ID from your merchant account."],
            ["SSLCommerz when a masked stored credential is a placeholder", "/sslcommerz",
                { sslcommerz: { ...liveSsl, store_password: "password", enabled: "false" } }, { storePassword: MASKED, enabled: true },
                "SSLCommerz store password looks like a placeholder. Enter the real SSLCommerz store password from your merchant account."],
        ] as const)("rejects enabling %s without persisting", async (_, path, stored, body, message) => {
            const { request, sqlite } = await createTestApp(stored as Stored);
            const before = storedRows(sqlite, path.slice(1));

            await expectValidationError(await request(path, body), message);
            expect(storedRows(sqlite, path.slice(1))).toEqual(before);
            expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
        });

        it("keeps a compatible online gateway when partial payments require one", async () => {
            const lastGateway = await createTestApp({
                stripe: liveStripe,
                payment_methods: { enabled_methods: JSON.stringify(["stripe", "cod"]), default_method: "stripe" },
            }, { partialPaymentEnabled: true });
            await expectValidationError(await lastGateway.request("/stripe", { enabled: false }));
            expect(storedRows(lastGateway.sqlite, "stripe").enabled).toBe("true");

            const withFallback = await createTestApp({
                stripe: liveStripe,
                sslcommerz: liveSsl,
                payment_methods: { enabled_methods: JSON.stringify(["stripe", "sslcommerz", "cod"]), default_method: "sslcommerz" },
            }, { partialPaymentEnabled: true });
            expect((await withFallback.request("/stripe", { enabled: false })).status).toBe(200);
            expect(storedRows(withFallback.sqlite, "stripe").enabled).toBe("false");
        });
    });
});
