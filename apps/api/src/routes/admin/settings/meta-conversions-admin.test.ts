import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";
import { metaConversionsAdminRoutes } from "./meta-conversions-admin";

const settingsRow = {
    id: "singleton",
    singletonKey: "default",
    pixelId: "1234567890",
    accessToken: "encrypted-token",
    testEventCode: null,
    isEnabled: true,
    logRetentionDays: 30,
    createdAt: 1,
    updatedAt: 1,
};

function createDb(options: {
    settings?: typeof settingsRow | null;
    analyticsRows?: Array<{ type: string; config: string }>;
    analyticsError?: Error;
} = {}) {
    const {
        settings = settingsRow,
        analyticsRows = [],
        analyticsError,
    } = options;

    return {
        select: vi.fn((shape?: unknown) => ({
            from: vi.fn(() => ({
                where: vi.fn(() => ({
                    get: vi.fn(async () => settings),
                    all: vi.fn(async () => {
                        if (shape && analyticsError) {
                            throw analyticsError;
                        }
                        return analyticsRows;
                    }),
                })),
            })),
        })),
    };
}

function createTestApp(db: ReturnType<typeof createDb>) {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
    const env = {} as Env;

    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    app.route("/meta-conversions", metaConversionsAdminRoutes);

    return { app, env };
}

async function getSettings(db: ReturnType<typeof createDb>) {
    const { app, env } = createTestApp(db);
    const response = await app.request("/api/v1/admin/settings/meta-conversions", {
        method: "GET",
    }, env);
    const body = await response.json() as {
        success: boolean;
        data: {
            settings: typeof settingsRow | null;
            pixelParity: {
                status: string;
                severity: string;
                capiPixelId: string | null;
                activeBrowserPixelIds: string[];
                activeFacebookPixelScriptCount: number;
            };
        };
    };

    return { response, body };
}

describe("Meta Conversions admin settings", () => {
    it("returns ok parity when CAPI and active browser Pixel match", async () => {
        const { response, body } = await getSettings(createDb({
            analyticsRows: [
                { type: "facebook_pixel", config: "fbq('init', '1234567890');" },
            ],
        }));

        expect(response.status).toBe(200);
        expect(body.data.settings?.accessToken).toBe("••••••••••••");
        expect(body.data.pixelParity).toMatchObject({
            status: "ok",
            severity: "success",
            capiPixelId: "1234567890",
            activeBrowserPixelIds: ["1234567890"],
        });
    });

    it("warns when the active browser Pixel does not match CAPI", async () => {
        const { body } = await getSettings(createDb({
            analyticsRows: [
                { type: "facebook_pixel", config: "fbq('init', '9876543210');" },
            ],
        }));

        expect(body.data.pixelParity).toMatchObject({
            status: "mismatch",
            severity: "warning",
            activeBrowserPixelIds: ["9876543210"],
        });
    });

    it("treats unrelated active analytics as no browser Pixel", async () => {
        const { body } = await getSettings(createDb({
            analyticsRows: [
                { type: "google_analytics", config: "gtag('config', 'G-1');" },
            ],
        }));

        expect(body.data.pixelParity).toMatchObject({
            status: "no_browser_pixel",
            severity: "warning",
            activeBrowserPixelIds: [],
            activeFacebookPixelScriptCount: 0,
        });
    });

    it("keeps the settings response available when parity diagnostics fail", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const { response, body } = await getSettings(createDb({
                analyticsError: new Error("d1 overloaded"),
            }));

            expect(response.status).toBe(200);
            expect(body.data.settings?.pixelId).toBe("1234567890");
            expect(body.data.pixelParity).toMatchObject({
                status: "unavailable",
                severity: "warning",
                capiPixelId: "1234567890",
            });
        } finally {
            warnSpy.mockRestore();
        }
    });
});
