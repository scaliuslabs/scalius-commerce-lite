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
    testEventCode: "stored-test-code",
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
        eventId: string;
        eventName: string | null;
        status: string | null;
        requestPayload: string | null;
        responsePayload: string | null;
        errorMessage: string | null;
        eventTime: number | null;
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
        expect(body.data.settings?.testEventCode).toBe("••••••••••••");
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
        expect(body.data?.testEventCode).toBe("••••••••••••");
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

    it("preserves the stored test event code when saving its masked marker", async () => {
        const db = createDb();
        const { response, body } = await saveSettings(db, {
            pixelId: "1234567890",
            accessToken: "••••••••••••",
            testEventCode: "••••••••••••",
            isEnabled: true,
            logRetentionDays: 30,
        });

        expect(response.status).toBe(200);
        expect(db.settings?.testEventCode).toBe("stored-test-code");
        expect(body.data?.testEventCode).toBe("••••••••••••");
    });

    it("preserves every omitted setting during a partial agent update", async () => {
        const db = createDb();
        const { response, body } = await saveSettings(db, { isEnabled: false });

        expect(response.status).toBe(200);
        expect(db.settings).toMatchObject({
            pixelId: "1234567890",
            accessToken: "encrypted-token",
            testEventCode: "stored-test-code",
            isEnabled: false,
            logRetentionDays: 30,
        });
        expect(body.data).toMatchObject({
            pixelId: "1234567890",
            accessToken: "••••••••••••",
            testEventCode: "••••••••••••",
            isEnabled: false,
            logRetentionDays: 30,
        });
        expect(mocks.encryptCredentials).not.toHaveBeenCalled();
    });

    it("uses safe defaults only when creating a new settings row", async () => {
        const db = createDb({ settings: null });
        const { response, body } = await saveSettings(db, {});

        expect(response.status).toBe(201);
        expect(body.data).toMatchObject({
            pixelId: null,
            accessToken: null,
            testEventCode: null,
            isEnabled: false,
            logRetentionDays: 30,
        });
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

    it("returns bounded provider summaries instead of stored raw payloads or errors", async () => {
        const db = createDb({
            logs: [{
                id: "log_1",
                eventId: "evt_1",
                eventName: "Purchase",
                status: "failed",
                requestPayload: "raw-secret-that-is-not-json",
                responsePayload: JSON.stringify({
                    error: {
                        message: "Bad token",
                        access_token: "secret-token",
                        nested: { authToken: "another-secret" },
                    },
                }),
                errorMessage: "Upstream rejected owner@example.com with token secret-token",
                eventTime: 123,
                createdAt: 1,
            }],
        });
        const { app, env } = createTestApp(db);

        const response = await app.request("/api/v1/admin/settings/meta-conversions/logs", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            data: {
                logs: Array<{
                    requestPayload: string;
                    responsePayload: string;
                    errorMessage: string;
                }>;
            };
        };

        expect(response.status).toBe(200);
        expect(body.data.logs[0]?.requestPayload).toBe('{"available":false}');
        expect(body.data.logs[0]?.responsePayload).toBe(
            '{"eventsReceived":null,"hasError":true,"errorType":null,"errorCode":null,"messageCount":null,"providerTraceId":null}',
        );
        expect(body.data.logs[0]?.errorMessage).toContain("Meta delivery failed");
        expect(JSON.stringify(body)).not.toContain("secret-token");
        expect(JSON.stringify(body)).not.toContain("owner@example.com");
    });

    it("preserves already-redacted delivery summaries, event identity, and event time", async () => {
        const db = createDb({
            logs: [{
                id: "log_2",
                eventId: "evt_safe_2",
                eventName: "AddToCart",
                status: "success",
                requestPayload: JSON.stringify({
                    eventCount: 1,
                    events: [{
                        eventName: "AddToCart",
                        actionSource: "website",
                        source: {
                            origin: "https://store.example",
                            path: "/products/runners?receiptToken=must-not-survive",
                        },
                        matchSignals: {
                            fields: ["client_ip_address", "client_user_agent", "em", "fbp"],
                        },
                        commerce: {
                            fields: ["content_ids", "contents", "currency", "value"],
                            currency: "BDT",
                            value: 1_250,
                            contentIdCount: 1,
                            lineCount: 1,
                            quantity: 2,
                        },
                    }],
                    testMode: true,
                    truncated: false,
                }),
                responsePayload: JSON.stringify({
                    eventsReceived: 1,
                    hasError: false,
                    errorType: null,
                    errorCode: null,
                    messageCount: 0,
                    providerTraceId: "trace-safe-2",
                }),
                errorMessage: null,
                eventTime: 1_797_438_840,
                createdAt: 1_797_438_841,
            }],
        });
        const { app, env } = createTestApp(db);

        const response = await app.request("/api/v1/admin/settings/meta-conversions/logs", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            data: { logs: Array<Record<string, unknown>> };
        };
        const log = body.data.logs[0];

        expect(response.status).toBe(200);
        expect(log).toMatchObject({
            eventId: "evt_safe_2",
            eventTime: 1_797_438_840,
            requestPayload: '{"eventCount":1,"events":[{"eventName":"AddToCart","actionSource":"website","source":{"origin":"https://store.example","path":"/products/runners"},"matchSignals":{"count":4,"fields":["client_ip_address","client_user_agent","em","fbp"],"hashedFields":["em"],"ipAddressSupplied":true,"userAgentSupplied":true},"commerce":{"fields":["content_ids","contents","currency","value"],"currency":"BDT","value":1250,"contentType":null,"contentCount":1,"lineCount":1,"quantity":2,"itemCount":null,"orderIdSupplied":false,"searchStringSupplied":false}}],"testMode":true,"truncated":false}',
            responsePayload: '{"eventsReceived":1,"hasError":false,"errorType":null,"errorCode":null,"messageCount":0,"providerTraceId":"trace-safe-2"}',
        });
    });
});
