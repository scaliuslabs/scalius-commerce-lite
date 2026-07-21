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
            { htmlPaths: ["/"] },
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
