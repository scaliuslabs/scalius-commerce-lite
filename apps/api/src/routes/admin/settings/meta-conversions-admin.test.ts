import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
    encryptCredentials: vi.fn(async (value: string) => `encrypted:${value}`),
    requireEncryptionKey: vi.fn(() => "credential-key"),
    invalidateApiAndScheduleStorefrontGroups: vi.fn(async () => undefined),
    cacheDelete: vi.fn(async () => undefined),
}));

vi.mock("@scalius/core/utils/credential-encryption", () => ({
    encryptCredentials: mocks.encryptCredentials,
}));

vi.mock("../../../utils/encryption-key", () => ({
    requireEncryptionKey: mocks.requireEncryptionKey,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
    invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

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
    logs?: Array<{
        id: string;
        eventName: string | null;
        status: string | null;
        requestPayload: string | null;
        responsePayload: string | null;
        errorMessage: string | null;
        createdAt: number | null;
    }>;
} = {}) {
    const {
        settings = settingsRow,
        analyticsRows = [],
        analyticsError,
        logs = [],
    } = options;
    let currentSettings = settings ? { ...settings } : null;

    return {
        get settings() {
            return currentSettings;
        },
        select: vi.fn((shape?: unknown) => ({
            from: vi.fn(() => ({
                get: vi.fn(async () => ({ count: logs.length })),
                orderBy: vi.fn(() => ({
                    limit: vi.fn(() => ({
                        offset: vi.fn(() => ({
                            all: vi.fn(async () => logs),
                        })),
                    })),
                })),
                where: vi.fn(() => ({
                    get: vi.fn(async () => currentSettings),
                    all: vi.fn(async () => {
                        if (shape && analyticsError) {
                            throw analyticsError;
                        }
                        return analyticsRows;
                    }),
                })),
            })),
        })),
        update: vi.fn(() => ({
            set: vi.fn((values: Partial<typeof settingsRow>) => ({
                where: vi.fn(() => ({
                    returning: vi.fn(async () => {
                        if (!currentSettings) {
                            return [];
                        }
                        currentSettings = {
                            ...currentSettings,
                            ...Object.fromEntries(
                                Object.entries(values).filter(([, value]) => value !== undefined),
                            ),
                        };
                        return [currentSettings];
                    }),
                })),
            })),
        })),
        insert: vi.fn(() => ({
            values: vi.fn((values: typeof settingsRow) => ({
                returning: vi.fn(async () => {
                    currentSettings = {
                        ...settingsRow,
                        ...values,
                    };
                    return [currentSettings];
                }),
            })),
        })),
    };
}

function createTestApp(db: ReturnType<typeof createDb>) {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
    const env = {
        CACHE: {
            delete: mocks.cacheDelete,
        },
    } as unknown as Env;

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

async function saveSettings(
    db: ReturnType<typeof createDb>,
    data: Record<string, unknown>,
) {
    const { app, env } = createTestApp(db);
    const response = await app.request("/api/v1/admin/settings/meta-conversions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
    }, env);
    const body = await response.json() as {
        success: boolean;
        data?: typeof settingsRow;
        error?: { message: string };
    };

    return { response, body };
}

beforeEach(() => {
    mocks.encryptCredentials.mockClear();
    mocks.requireEncryptionKey.mockClear();
    mocks.invalidateApiAndScheduleStorefrontGroups.mockClear();
    mocks.cacheDelete.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

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

    it("trims credentials before storing and masks the saved access token response", async () => {
        const db = createDb({ settings: null });
        const { response, body } = await saveSettings(db, {
            pixelId: " 1234567890 ",
            accessToken: " live-access-token ",
            testEventCode: " TEST12345 ",
            isEnabled: true,
            logRetentionDays: 45,
        });

        expect(response.status).toBe(201);
        expect(body.data?.pixelId).toBe("1234567890");
        expect(body.data?.accessToken).toBe("••••••••••••");
        expect(body.data?.testEventCode).toBe("TEST12345");
        expect(db.settings?.accessToken).toBe("encrypted:live-access-token");
        expect(mocks.cacheDelete).toHaveBeenCalledWith("meta-capi:browser-events:circuit");
        expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalled();
    });

    it("reuses the stored encrypted token when saving the masked token value", async () => {
        const db = createDb();
        const { response } = await saveSettings(db, {
            pixelId: "9876543210",
            accessToken: "••••••••••••",
            testEventCode: "",
            isEnabled: true,
            logRetentionDays: 30,
        });

        expect(response.status).toBe(200);
        expect(db.settings?.pixelId).toBe("9876543210");
        expect(db.settings?.accessToken).toBe("encrypted-token");
        expect(db.settings?.testEventCode).toBeNull();
        expect(mocks.encryptCredentials).not.toHaveBeenCalled();
    });

    it("rejects enabling with a masked token when no stored token exists", async () => {
        const db = createDb({ settings: null });
        const { response, body } = await saveSettings(db, {
            pixelId: "1234567890",
            accessToken: "••••••••••••",
            isEnabled: true,
            logRetentionDays: 30,
        });

        expect(response.status).toBe(400);
        expect(body.error?.message).toContain("access token before it can be enabled");
        expect(db.settings).toBeNull();
    });

    it("does not store the masked token marker when no stored token exists", async () => {
        const db = createDb({ settings: null });
        const { response } = await saveSettings(db, {
            pixelId: "1234567890",
            accessToken: "••••••••••••",
            isEnabled: false,
            logRetentionDays: 30,
        });

        expect(response.status).toBe(201);
        expect(db.settings?.accessToken).toBeNull();
        expect(mocks.encryptCredentials).not.toHaveBeenCalled();
    });

    it("rejects obvious placeholder credentials without substring matching real-looking tokens", async () => {
        const placeholderDb = createDb({ settings: null });
        const placeholder = await saveSettings(placeholderDb, {
            pixelId: "pixel_123",
            accessToken: "EAABtestLiveToken123",
            testEventCode: "TEST12345",
            isEnabled: false,
            logRetentionDays: 30,
        });

        expect(placeholder.response.status).toBe(400);
        expect(placeholder.body.error?.message).toContain("Pixel ID looks like a dummy");

        const realLookingDb = createDb({ settings: null });
        const realLooking = await saveSettings(realLookingDb, {
            pixelId: "1234567890",
            accessToken: "EAABtestLiveToken123",
            testEventCode: "TEST12345",
            isEnabled: true,
            logRetentionDays: 30,
        });

        expect(realLooking.response.status).toBe(201);
        expect(realLookingDb.settings?.accessToken).toBe("encrypted:EAABtestLiveToken123");
    });

    it("redacts token-like fields from stored response payloads", async () => {
        const db = createDb({
            logs: [{
                id: "log_1",
                eventName: "Purchase",
                status: "failed",
                requestPayload: null,
                responsePayload: JSON.stringify({
                    error: {
                        message: "Bad token",
                        access_token: "secret-token",
                        nested: { authToken: "another-secret" },
                    },
                }),
                errorMessage: null,
                createdAt: 1,
            }],
        });
        const { app, env } = createTestApp(db);

        const response = await app.request("/api/v1/admin/settings/meta-conversions/logs", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            data: {
                logs: Array<{ responsePayload: string }>;
            };
        };

        expect(response.status).toBe(200);
        expect(body.data.logs[0]?.responsePayload).toContain('"access_token": "[redacted]"');
        expect(body.data.logs[0]?.responsePayload).toContain('"authToken": "[redacted]"');
        expect(body.data.logs[0]?.responsePayload).not.toContain("secret-token");
    });
});
