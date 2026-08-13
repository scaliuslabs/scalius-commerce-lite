import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
    getBusinessSettings: vi.fn(),
    saveBusinessSettings: vi.fn(),
    invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/business-settings.service", () => ({
    getBusinessSettings: mocks.getBusinessSettings,
    saveBusinessSettings: mocks.saveBusinessSettings,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
    invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

import { businessSettingsRoutes } from "./business";

function createTestApp() {
    const db = { id: "db" };
    const env = {
        CACHE: { id: "api-cache-kv" },
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
        STOREFRONT_URL: "https://storefront.example.com",
    } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

    mocks.saveBusinessSettings.mockResolvedValue(undefined);
    mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);

    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    app.route("/admin/settings", businessSettingsRoutes);
    return { app, env };
}

describe("business settings cache invalidation", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns a bounded merchant projection without redacting usable business fields", async () => {
        mocks.getBusinessSettings.mockResolvedValue({
            companyName: `Scalius ${"c".repeat(1_000)}`,
            legalName: "Scalius Commerce Ltd",
            addressLine1: "123 Merchant Street",
            addressLine2: "",
            city: "Dhaka",
            stateRegion: "Dhaka",
            postalCode: "1200",
            country: "Bangladesh",
            phone: "+8801700000000",
            email: "merchant@example.com",
            taxId: "TAX-123",
            invoicePrefix: "INV",
            invoiceFooterText: "f".repeat(100_000),
            invoiceLogoUrl: "https://images.example.com/logo.png",
            providerSecret: "must-not-project",
        });
        const { app, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/settings/business",
            { method: "GET" },
            env,
        );
        const responseText = await response.text();
        const body = JSON.parse(responseText);

        expect(response.status).toBe(200);
        expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
        expect(body.data.companyName).toHaveLength(200);
        expect(body.data.invoiceFooterText).toHaveLength(4_000);
        expect(body.data.email).toBe("merchant@example.com");
        expect(responseText).not.toContain("must-not-project");
    });

    it("invalidates layout caches after business identity saves", async () => {
        const { app, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/settings/business",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    companyName: "Scalius Demo",
                    legalName: "Scalius Demo Ltd",
                    country: "BD",
                }),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.saveBusinessSettings).toHaveBeenCalledWith(
            expect.objectContaining({ id: "db" }),
            expect.objectContaining({
                companyName: "Scalius Demo",
                legalName: "Scalius Demo Ltd",
                country: "BD",
            }),
        );
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
            ["layout"],
            expect.anything(),
        );
    });

    it.each([
        "http://images.example.com/logo.png",
        "//images.example.com/logo.png",
        "https://user:pass@images.example.com/logo.png",
        "javascript:alert(1)",
    ])("rejects an unsafe invoice logo source: %s", async (invoiceLogoUrl) => {
        const { app, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/settings/business",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ invoiceLogoUrl }),
            },
            env,
        );

        expect(response.status).toBe(400);
        expect(mocks.saveBusinessSettings).not.toHaveBeenCalled();
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
    });
});
