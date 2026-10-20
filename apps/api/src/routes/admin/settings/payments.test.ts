import { DEFAULT_NET_TERMS_SETTINGS } from "@scalius/shared/payment-terms";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { BUILT_IN_PAYMENT_PROVIDERS, getStripeSettings, type PaymentProviders } from "@scalius/core/modules/payments";
import { createFakeGateway } from "@scalius/core/testing";
import { installPlugin } from "@scalius/core/modules/plugins";
import { WALLET_FIXTURE_ID, WALLET_FIXTURE_MANIFEST } from "../../../plugins/testing/provider-fixture";
import {
    checkoutDocument,
    currencyDocument,
    paymentMethodsDocument,
    stripeDocument,
} from "@scalius/core/modules/settings";

// The request's gateways: built in, unless a test installs the Bangladesh pack's SSLCommerz.
const appProviders = vi.hoisted(() => ({ current: null as PaymentProviders | null }));
vi.mock("../../../plugins/providers/payment", () => ({
    requestPaymentProviders: async () => appProviders.current ?? BUILT_IN_PAYMENT_PROVIDERS,
}));
const PACK_SSLCOMMERZ = "scalius.bangladesh:sslcommerz";

import { errorResponseFromError } from "../../../utils/api-response";

import { paymentSettingsRoutes } from "./payments";

const CREDENTIAL_ENCRYPTION_KEY = btoa("p".repeat(32));
const MASKED = "••••••••••••";
const liveStripe = { secretKey: "sk_live_existing", publishableKey: "pk_live_existing", webhookSecret: "whsec_existing", enabled: true };

type Stored = {
    stripe?: Partial<typeof liveStripe>;
    payment_methods?: { enabledMethods: string[]; defaultMethod: string };
    currency?: { currencyCode: string };
};

async function createTestApp(stored: Stored = {}, site: { partialPaymentEnabled?: boolean } = {}) {
    let failNextWrite = false;
    const { sqlite, db } = createSqliteD1Database({
        onQuery: (query) => {
            if (!failNextWrite || !/^(insert into|update) "settings"/i.test(query)) return;
            failNextWrite = false;
            throw new Error("settings write failed");
        },
    });
    const ctx = { encryptionKey: CREDENTIAL_ENCRYPTION_KEY };
    await checkoutDocument.write(db, {
        partialPaymentEnabled: site.partialPaymentEnabled === true,
        partialPaymentAmount: site.partialPaymentEnabled ? 500 : 0,
    });
    if (stored.stripe) await stripeDocument.write(db, stored.stripe, ctx);
    if (stored.payment_methods) await paymentMethodsDocument.write(db, stored.payment_methods);
    if (stored.currency) await currencyDocument.write(db, stored.currency as never);

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

    // Like the dashboard, a save sends the revision it loaded unless a test sets one.
    const loadedRevision = (path: string) => (sqlite.prepare(
        "SELECT revision FROM settings WHERE key = 'document' AND category = ?",
    ).get(path.slice(1).replace("-", "_")) as { revision: number } | undefined)?.revision ?? 0;
    const request = (path: string, body?: unknown, requestEnv: Env = env) => app.request(
        `/api/v1/admin/settings${path}`,
        body === undefined
            ? { method: "GET" }
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedRevision: loadedRevision(path), ...(body as object) }),
            },
        requestEnv,
    );
    const remove = (path: string, expectedRevision = loadedRevision(path)) => app.request(
        `/api/v1/admin/settings${path}`,
        { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision }) },
        env,
    );
    return { request, remove, db, sqlite, failNextWrite: () => { failNextWrite = true; } };
}

/** The raw stored document (secrets as ciphertext), or `{}` before the first save. */
function storedRows(sqlite: DatabaseSync, category: string): Record<string, unknown> {
    const row = sqlite.prepare("SELECT value FROM settings WHERE category = ? AND key = 'document'").get(category) as
        | { value: string }
        | undefined;
    return row ? JSON.parse(row.value) as Record<string, unknown> : {};
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
        appProviders.current = null;
    });

    describe("reads", () => {
        it("never returns stored gateway secrets from configuration reads", async () => {
            const { request } = await createTestApp({ stripe: liveStripe });

            const stripeResponse = await request("/stripe");

            await expect(stripeResponse.json()).resolves.toMatchObject({
                data: { secretKey: MASKED, publishableKey: "pk_live_existing", webhookSecret: MASKED },
            });
        });

        it("returns raw selected methods separately from effective active checkout methods", async () => {
            const { request } = await createTestApp({
                stripe: { ...liveStripe, publishableKey: "" },
                payment_methods: { enabledMethods: ["stripe", "cod"], defaultMethod: "stripe" },
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
                payment_methods: { enabledMethods: ["stripe", "cod"], defaultMethod: "cod" },
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

        it("lists the pack's SSLCommerz with its charge limits and excludes it outside BDT", async () => {
            appProviders.current = createFakeGateway(PACK_SSLCOMMERZ).providers;
            const { request } = await createTestApp({
                currency: { currencyCode: "USD" },
                payment_methods: { enabledMethods: [PACK_SSLCOMMERZ, "cod"], defaultMethod: PACK_SSLCOMMERZ },
            });

            const body = await (await request("/payment-methods")).json() as { data: { gateways: Array<Record<string, unknown>> } };
            expect(body).toMatchObject({
                data: {
                    activeMethods: ["cod"],
                    gatewayStatus: {
                        [PACK_SSLCOMMERZ]: {
                            configured: true,
                            usable: false,
                            checkoutVisible: false,
                            blockedReason: "FakePay checkout requires the store currency to be BDT. Current currency: USD.",
                        },
                    },
                },
            });
            expect(body.data.gateways.find((gateway) => gateway.id === PACK_SSLCOMMERZ)).toMatchObject({
                pluginId: "scalius.bangladesh",
                amountLimits: { currency: "BDT", min: 10, max: 100_000 },
            });
        });
    });

    describe("payment method saves", () => {
        it("persists methods after the save", async () => {
            const { request, sqlite } = await createTestApp({ stripe: liveStripe });

            const response = await request("/payment-methods", { enabledMethods: ["stripe", "cod"], defaultMethod: "stripe" });

            expect(response.status).toBe(200);
            expect(storedRows(sqlite, "payment_methods")).toEqual({
                enabledMethods: ["stripe", "cod"],
                defaultMethod: "stripe",
                netTerms: DEFAULT_NET_TERMS_SETTINGS,
            });

        });

        it("allows an intentional COD-only save in standard checkout mode", async () => {
            const { request } = await createTestApp();
            expect((await request("/payment-methods", { enabledMethods: ["cod"], defaultMethod: "cod" })).status).toBe(200);
        });

        it.each([
            ["duplicate methods", {}, {}, { enabledMethods: ["cod", "cod"], defaultMethod: "cod" }, undefined],
            ["an app method whose app is not active", {}, {},
                { enabledMethods: [PACK_SSLCOMMERZ, "cod"], defaultMethod: PACK_SSLCOMMERZ },
                "Unsupported payment gateway: scalius.bangladesh:sslcommerz"],
            ["removing every online gateway under partial payments", {}, { partialPaymentEnabled: true },
                { enabledMethods: ["cod"], defaultMethod: "cod" }, undefined],
            ["a default method hidden by the checkout flow", { stripe: liveStripe }, { partialPaymentEnabled: true },
                { enabledMethods: ["stripe", "cod"], defaultMethod: "cod" },
                "Default method is hidden by the current checkout flow settings."],
        ] as const)("rejects %s without persisting", async (_, stored, site, body, message) => {
            const { request, sqlite } = await createTestApp(stored as Stored, site);

            await expectValidationError(await request("/payment-methods", body), message);
            expect(storedRows(sqlite, "payment_methods")).toEqual({});

        });
    });

    describe("saved methods whose app is gone or off", () => {
        // bKash's id before it moved into the Bangladesh pack: no installed app declares it.
        const ORPHAN = "scalius.bkash:bkash";
        const WALLET = `${WALLET_FIXTURE_ID}:wallet`;

        it("leaves a removed app's method out of the read, so it never shows as on", async () => {
            const { request } = await createTestApp({ payment_methods: { enabledMethods: [ORPHAN, "cod"], defaultMethod: ORPHAN } });

            await expect((await request("/payment-methods")).json()).resolves.toMatchObject({
                data: { enabledMethods: ["cod"], defaultMethod: "cod", activeMethods: ["cod"] },
            });
        });

        it("drops a removed app's saved method on the next save instead of refusing it", async () => {
            const { request, sqlite } = await createTestApp({ payment_methods: { enabledMethods: [ORPHAN, "cod"], defaultMethod: "cod" } });

            const response = await request("/payment-methods", { enabledMethods: [ORPHAN, "cod"], defaultMethod: "cod" });

            expect(response.status, await response.clone().text()).toBe(200);
            expect(storedRows(sqlite, "payment_methods")).toEqual({ enabledMethods: ["cod"], defaultMethod: "cod", netTerms: DEFAULT_NET_TERMS_SETTINGS });
        });

        it("keeps an installed but inactive app's saved method without blocking the save, and refuses it as the default", async () => {
            const { request, db, sqlite } = await createTestApp({ payment_methods: { enabledMethods: [WALLET, "cod"], defaultMethod: "cod" } });
            await installPlugin(db, { manifest: WALLET_FIXTURE_MANIFEST, source: "upload", bundleSha256: "a".repeat(64) });

            await expect((await request("/payment-methods")).json()).resolves.toMatchObject({
                data: { enabledMethods: [WALLET, "cod"], activeMethods: ["cod"] },
            });
            expect((await request("/payment-methods", { enabledMethods: ["cod", WALLET], defaultMethod: "cod" })).status).toBe(200);
            expect(storedRows(sqlite, "payment_methods")).toEqual({ enabledMethods: ["cod", WALLET], defaultMethod: "cod", netTerms: DEFAULT_NET_TERMS_SETTINGS });
            await expectValidationError(await request("/payment-methods", { enabledMethods: ["cod", WALLET], defaultMethod: WALLET }));
        });
    });

    describe("gateway credential saves", () => {
        it("encrypts a complete Stripe credential rotation in one document write", async () => {
            const { request, db, sqlite } = await createTestApp();

            const response = await request("/stripe", {
                secretKey: "sk_test_replacement",
                publishableKey: "pk_test_replacement",
                webhookSecret: "whsec_replacement",
                enabled: true,
            });

            expect(response.status, await response.clone().text()).toBe(200);
            const raw = storedRows(sqlite, "stripe");
            expect(raw.secretKey).not.toContain("sk_test_replacement");
            expect(raw.webhookSecret).not.toContain("whsec_replacement");
            await expect(getStripeSettings(db, CREDENTIAL_ENCRYPTION_KEY)).resolves.toMatchObject({
                secretKey: "sk_test_replacement",
                publishableKey: "pk_test_replacement",
                webhookSecret: "whsec_replacement",
                enabled: true,
            });

        });

        it("turns Stripe on and offers it at checkout in one save", async () => {
            const { request, sqlite } = await createTestApp({ payment_methods: { enabledMethods: ["cod"], defaultMethod: "cod" } });
            const response = await request("/stripe", {
                secretKey: "sk_test_replacement",
                publishableKey: "pk_test_replacement",
                webhookSecret: "whsec_replacement",
                enabled: true,
                showAtCheckout: true,
            });
            expect(response.status, await response.clone().text()).toBe(200);
            expect(storedRows(sqlite, "payment_methods")).toEqual({ enabledMethods: ["cod", "stripe"], defaultMethod: "cod" });
            // Saying it again changes nothing; it is refused while Stripe would stay off.
            expect((await request("/stripe", { enabled: true, showAtCheckout: true })).status).toBe(200);
            expect(storedRows(sqlite, "payment_methods")).toEqual({ enabledMethods: ["cod", "stripe"], defaultMethod: "cod" });
            await expectValidationError(await request("/stripe", { showAtCheckout: true }));
        });

        it("offers Stripe at checkout only once its keys are complete", async () => {
            const { request, sqlite } = await createTestApp({ payment_methods: { enabledMethods: ["cod"], defaultMethod: "cod" } });
            await expectValidationError(await request("/stripe", { secretKey: "sk_test_replacement", enabled: true, showAtCheckout: true }));
            expect(storedRows(sqlite, "payment_methods")).toEqual({ enabledMethods: ["cod"], defaultMethod: "cod" });
            expect(storedRows(sqlite, "stripe")).toEqual({});
        });

        it.each([
            ["/stripe", { secretKey: "sk_live_missing_key" }],
        ])("fails closed before saving %s secrets when CREDENTIAL_ENCRYPTION_KEY is missing", async (path, body) => {
            const { request, sqlite } = await createTestApp();

            const response = await request(path, body, {} as Env);

            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toMatchObject({
                error: { code: "SERVICE_UNAVAILABLE", message: "CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials." },
            });
            expect(storedRows(sqlite, path.slice(1))).toEqual({});

        });

        it("reports failure when the gateway save fails", async () => {
            const { request, sqlite, failNextWrite } = await createTestApp({ stripe: liveStripe });
            failNextWrite();

            const response = await request("/stripe", { publishableKey: "pk_live_replacement" });

            expect(response.status).toBe(500);
            expect(storedRows(sqlite, "stripe").publishableKey).toBe("pk_live_existing");

        });

        it.each([
            ["Stripe without an effective publishable key", "/stripe",
                { stripe: { secretKey: "sk_live_existing", webhookSecret: "whsec_existing", enabled: false } }, { enabled: true },
                undefined],
            ["Stripe with submitted placeholder credentials", "/stripe", {},
                { secretKey: "stripe_secret_key", publishableKey: "pk_live_public", webhookSecret: "whsec_live", enabled: true },
                "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account."],
            ["a live publishable key paired with a retained test secret", "/stripe",
                { stripe: { ...liveStripe, secretKey: "sk_test_existing", publishableKey: "pk_test_existing" } },
                { publishableKey: "pk_live_replacement", enabled: true },
                "Stripe secret and publishable keys use different test/live environments. Choose a matching key pair."],
            ["Stripe when a masked stored credential is a placeholder", "/stripe",
                { stripe: { ...liveStripe, secretKey: "sk_test_your_key_here", enabled: false } }, { enabled: true },
                "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account."],
        ] as const)("rejects enabling %s without persisting", async (_, path, stored, body, message) => {
            const { request, sqlite } = await createTestApp(stored as Stored);
            const before = storedRows(sqlite, path.slice(1));

            await expectValidationError(await request(path, body), message);
            expect(storedRows(sqlite, path.slice(1))).toEqual(before);

        });

        it("saves a partial Stripe setup while it stays off, then names the missing keys when turning it on", async () => {
            const { request, db } = await createTestApp();

            expect((await request("/stripe", { secretKey: "sk_test_first", enabled: false })).status).toBe(200);
            await expect(getStripeSettings(db, CREDENTIAL_ENCRYPTION_KEY)).resolves.toMatchObject({
                secretKey: "sk_test_first",
                enabled: false,
            });

            const turnOn = await request("/stripe", { secretKey: MASKED, enabled: true });
            expect(turnOn.status).toBe(400);
            const message = "Add the publishable key and webhook secret to turn on Stripe.";
            await expect(turnOn.json()).resolves.toMatchObject({
                error: {
                    message,
                    details: { issues: [{ path: ["publishableKey"], message }, { path: ["webhookSecret"], message }] },
                },
            });
            await expect(getStripeSettings(db, CREDENTIAL_ENCRYPTION_KEY)).resolves.toMatchObject({ enabled: false });
        });

        it.each([
            ["/stripe", { stripe: liveStripe }, { secretKey: "", publishableKey: "", webhookSecret: "", enabled: false }],
        ] as const)("removes every saved %s key, turns it off and takes it out of checkout", async (path, stored, cleared) => {
            const gateway = path.slice(1);
            const { request, remove, sqlite } = await createTestApp({
                ...stored,
                payment_methods: { enabledMethods: [gateway, "cod"], defaultMethod: gateway },
            } as Stored);

            const response = await remove(path);

            expect(response.status, await response.clone().text()).toBe(200);
            expect(storedRows(sqlite, gateway)).toEqual(cleared);
            expect(storedRows(sqlite, "payment_methods")).toEqual({ enabledMethods: ["cod"], defaultMethod: "cod", netTerms: DEFAULT_NET_TERMS_SETTINGS });
            // Nothing reads as saved any more.
            const read = await (await request(path)).json() as { data: Record<string, unknown> };
            expect(JSON.stringify(read.data)).not.toContain(MASKED);

        });

        it("refuses to remove the keys of the last payment method checkout can use, like turning it off", async () => {
            const { remove, sqlite } = await createTestApp({
                stripe: liveStripe,
                payment_methods: { enabledMethods: ["stripe"], defaultMethod: "stripe" },
            });
            const before = storedRows(sqlite, "stripe");

            await expectValidationError(await remove("/stripe"));
            expect(storedRows(sqlite, "stripe")).toEqual(before);
            expect(storedRows(sqlite, "payment_methods")).toEqual({ enabledMethods: ["stripe"], defaultMethod: "stripe", netTerms: DEFAULT_NET_TERMS_SETTINGS });

        });

        it("refuses a removal based on keys someone else has since changed", async () => {
            const { remove, sqlite } = await createTestApp({ stripe: liveStripe });
            const before = storedRows(sqlite, "stripe");

            const response = await remove("/stripe", 0);

            expect(response.status).toBe(409);
            expect(storedRows(sqlite, "stripe")).toEqual(before);

        });

        it("keeps a compatible online gateway when partial payments require one", async () => {
            const lastGateway = await createTestApp({
                stripe: liveStripe,
                payment_methods: { enabledMethods: ["stripe", "cod"], defaultMethod: "stripe" },
            }, { partialPaymentEnabled: true });
            await expectValidationError(await lastGateway.request("/stripe", { enabled: false }));
            expect(storedRows(lastGateway.sqlite, "stripe").enabled).toBe(true);

            // The fallback may be an app's gateway (the Bangladesh pack's SSLCommerz).
            appProviders.current = createFakeGateway(PACK_SSLCOMMERZ).providers;
            const withFallback = await createTestApp({
                stripe: liveStripe,
                payment_methods: { enabledMethods: ["stripe", PACK_SSLCOMMERZ, "cod"], defaultMethod: PACK_SSLCOMMERZ },
            }, { partialPaymentEnabled: true });
            expect((await withFallback.request("/stripe", { enabled: false })).status).toBe(200);
            expect(storedRows(withFallback.sqlite, "stripe").enabled).toBe(false);
        });
    });
});
