import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";
import { finalizeOpenApiContract, type OpenApiDocument } from "../../openapi-contract";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

const mocks = vi.hoisted(() => ({
    createAnalyticsScript: vi.fn(),
}));

vi.mock("@scalius/core/modules/analytics", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/analytics")>();
    return {
        ...actual,
        createAnalyticsScript: mocks.createAnalyticsScript,
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
        expect(operation?.security).toEqual([
            { adminSession: [] },
            { agentBearer: [] },
        ]);
    });

    it("passes lifecycle authority separately from ordinary script creation", async () => {
        mocks.createAnalyticsScript.mockResolvedValue({
            id: "analytics_1",
            revision: 1,
            script: {
                id: "analytics_1",
                name: "Draft custom script",
                type: "custom",
                config: "<script>window.demo = true;</script>",
                isActive: false,
                usePartytown: true,
                location: "head",
                revision: 1,
                createdAt: "2026-07-01T00:00:00.000Z",
                updatedAt: "2026-07-01T00:00:00.000Z",
                deletedAt: null,
            },
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
