import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";
import { finalizeOpenApiContract, type OpenApiDocument } from "../../openapi-contract";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

const mocks = vi.hoisted(() => ({
    getAnalyticsProviderHealth: vi.fn(),
    createAnalyticsScript: vi.fn(),
    updateAnalyticsScript: vi.fn(),
}));

vi.mock("@scalius/core/modules/analytics", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/analytics")>();
    return {
        ...actual,
        getAnalyticsProviderHealth: mocks.getAnalyticsProviderHealth,
        createAnalyticsScript: mocks.createAnalyticsScript,
        updateAnalyticsScript: mocks.updateAnalyticsScript,
    };
});

import { adminAnalyticsRoutes } from "./analytics";

function createTestApp(
    db: unknown = { id: "db" },
    permissions = new Set([PERMISSIONS.ANALYTICS_TOGGLE]),
) {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    const env = {
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as unknown as Env;

    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("adminPermissions", permissions);
        await next();
    });
    app.route("/analytics", adminAnalyticsRoutes);

    return { app, env, db };
}

describe("admin analytics routes", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("serves compact provider health without script config", async () => {
        const providerHealth = {
            summary: {
                totalProviders: 6,
                browserReadyProviders: 1,
                draftProviders: 1,
                blockedProviders: 1,
                notConfiguredProviders: 3,
                serverReadyProviders: 1,
            },
            providers: [
                {
                    provider: "facebook_pixel",
                    label: "Facebook Pixel",
                    browser: {
                        status: "ready",
                        configured: true,
                        activeScriptCount: 1,
                        readyScriptCount: 1,
                        draftScriptCount: 0,
                        blockedScriptCount: 0,
                        message: "One active browser snippet is configured.",
                        issues: [],
                    },
                    serverSide: {
                        status: "ready",
                        configured: true,
                        label: "Server ready",
                        message: "Meta CAPI is enabled. No provider test event was sent.",
                    },
                },
            ],
        };
        mocks.getAnalyticsProviderHealth.mockResolvedValue(providerHealth);
        const { app, env, db } = createTestApp();

        const response = await app.request("/api/v1/admin/analytics/health", {
            method: "GET",
        }, env);
        const body = await response.json() as {
            success: true;
            data: typeof providerHealth;
        };

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: providerHealth,
        });
        expect(mocks.getAnalyticsProviderHealth).toHaveBeenCalledWith(db, {
            credentialEncryptionKey: "credential-key",
        });
        const firstProvider = body.data.providers[0];
        if (!firstProvider) {
            throw new Error("Expected provider health payload");
        }
        expect(firstProvider).not.toHaveProperty("config");
        expect(firstProvider.browser).not.toHaveProperty("config");
        expect(firstProvider.serverSide).not.toHaveProperty("config");
        expect(JSON.stringify(body)).not.toContain("accessToken");
    });

    it("documents provider health in the admin analytics OpenAPI contract", () => {
        const { app } = createTestApp();
        const spec = finalizeOpenApiContract(app.getOpenAPIDocument({
            openapi: "3.0.0",
            info: { title: "Admin analytics routes", version: "test" },
        })) as unknown as OpenApiDocument;
        const operation = (
            spec.paths?.["/api/v1/admin/analytics/health"] as
                | { get?: { security?: Array<Record<string, string[]>> } }
                | undefined
        )?.get;

        expect(operation).toBeDefined();
        expect(operation?.security).toEqual([{ adminSession: [] }]);
    });

    it("passes lifecycle authority separately from ordinary script creation", async () => {
        mocks.createAnalyticsScript.mockResolvedValue({
            id: "analytics_1",
            script: { id: "analytics_1", isActive: false },
        });
        const { app, env, db } = createTestApp(undefined, new Set());

        const response = await app.request(
            "/api/v1/admin/analytics",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: "Draft custom script",
                    type: "custom",
                    config: "<script>window.demo = true;</script>",
                    location: "head",
                    usePartytown: true,
                    isActive: false,
                }),
            },
            env,
        );

        expect(response.status).toBe(201);
        expect(mocks.createAnalyticsScript).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ isActive: false }),
            { canToggle: false },
        );
    });
});
