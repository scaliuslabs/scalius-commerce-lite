import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "@scalius/core/utils/credential-encryption";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({

    cacheDelete: vi.fn(async () => undefined),
}));

import { metaConversionsAdminRoutes } from "./meta-conversions-admin";

const CREDENTIAL_ENCRYPTION_KEY = btoa("k".repeat(32));

const settingsRow = {
    pixelId: "1234567890",
    accessToken: "stored-ciphertext",
    testEventCode: "stored-test-code",
    isEnabled: true,
    logRetentionDays: 30,
};

type LogRow = {
    id: string;
    eventId: string;
    eventName: string;
    status: string;
    requestPayload: string;
    responsePayload: string | null;
    errorMessage: string | null;
    eventTime: number;
    createdAt: number;
};

function createDb(options: {
    settings?: typeof settingsRow | null;
    analyticsRows?: Array<{ type: string; config: string }>;
    analyticsError?: Error;
    logs?: LogRow[];
} = {}) {
    const { settings = settingsRow, analyticsRows = [], analyticsError, logs = [] } = options;
    const { sqlite, db } = createSqliteD1Database({
        onQuery: (query) => {
            if (analyticsError && /from "analytics"/.test(query)) throw analyticsError;
        },
    });
    if (settings) {
        sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('meta', 'document', ?, 'json', 'meta_conversions')")
            .run(JSON.stringify(settings));
    }
    analyticsRows.forEach((row, index) => {
        sqlite.prepare("INSERT INTO analytics (id, name, type, config, location) VALUES (?, 'Script', ?, ?, 'head')")
            .run(`analytics_${index}`, row.type, row.config);
    });
    for (const log of logs) {
        sqlite.prepare(`INSERT INTO meta_conversions_logs (id, event_id, event_name, status, request_payload,
            response_payload, error_message, event_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(log.id, log.eventId, log.eventName, log.status, log.requestPayload,
                log.responsePayload, log.errorMessage, log.eventTime, log.createdAt);
    }
    return {
        db,
        /** The stored document (the access token as stored ciphertext). */
        get settings() {
            const row = sqlite.prepare("SELECT value FROM settings WHERE category = 'meta_conversions'").get() as
                | { value: string }
                | undefined;
            return row ? JSON.parse(row.value) as typeof settingsRow : null;
        },
    };
}

function createTestApp(database: ReturnType<typeof createDb>) {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
    const env = {
        CACHE: {
            delete: mocks.cacheDelete,
        },
        CREDENTIAL_ENCRYPTION_KEY,
    } as unknown as Env;

    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", database.db);
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
    // Like the dashboard: send back the revision the settings were loaded at.
    const loaded = await (await app.request("/api/v1/admin/settings/meta-conversions", { method: "GET" }, env))
        .json() as { data: { revision: number } };
    const response = await app.request("/api/v1/admin/settings/meta-conversions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: loaded.data.revision, ...data }),
    }, env);
    const body = await response.json() as {
        success: boolean;
        data?: Record<string, unknown>;
        error?: { message: string };
    };

    return { response, body };
}

beforeEach(() => {

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
        expect(db.settings?.accessToken).not.toContain("live-access-token");
        await expect(decryptCredentials(db.settings!.accessToken.replace(/^enc:/, ""), CREDENTIAL_ENCRYPTION_KEY))
            .resolves.toBe("live-access-token");
        expect(mocks.cacheDelete).toHaveBeenCalledWith("meta-capi:browser-events:circuit");

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
        expect(db.settings?.accessToken).toBe("stored-ciphertext");
        expect(db.settings?.testEventCode).toBe("");
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
            accessToken: "stored-ciphertext",
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
        expect(db.settings?.accessToken).toBe("");
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
        await expect(decryptCredentials(realLookingDb.settings!.accessToken.replace(/^enc:/, ""), CREDENTIAL_ENCRYPTION_KEY))
            .resolves.toBe("EAABtestLiveToken123");
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
            eventTime: new Date(1_797_438_840_000).toISOString(),
            requestPayload: '{"eventCount":1,"events":[{"eventName":"AddToCart","actionSource":"website","source":{"origin":"https://store.example","path":"/products/runners"},"matchSignals":{"count":4,"fields":["client_ip_address","client_user_agent","em","fbp"],"hashedFields":["em"],"ipAddressSupplied":true,"userAgentSupplied":true},"commerce":{"fields":["content_ids","contents","currency","value"],"currency":"BDT","value":1250,"contentType":null,"contentCount":1,"lineCount":1,"quantity":2,"itemCount":null,"orderIdSupplied":false,"searchStringSupplied":false}}],"testMode":true,"truncated":false}',
            responsePayload: '{"eventsReceived":1,"hasError":false,"errorType":null,"errorCode":null,"messageCount":0,"providerTraceId":"trace-safe-2"}',
        });
    });
});
