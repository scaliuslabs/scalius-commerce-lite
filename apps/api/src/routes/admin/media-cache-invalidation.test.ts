import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    updateMediaFile: vi.fn(),
    trashMediaFile: vi.fn(),
    restoreMediaFile: vi.fn(),
    invalidateMediaDependentProductCaches: vi.fn(),
}));

vi.mock("@scalius/core/modules/media", async () => {
    const actual = await vi.importActual<typeof import("@scalius/core/modules/media")>(
        "@scalius/core/modules/media",
    );
    return {
        ...actual,
        updateMediaFile: mocks.updateMediaFile,
        trashMediaFile: mocks.trashMediaFile,
        restoreMediaFile: mocks.restoreMediaFile,
    };
});

vi.mock("../../utils/media-cache-invalidation", () => ({
    invalidateMediaDependentProductCaches: mocks.invalidateMediaDependentProductCaches,
}));

import { adminMediaRoutes } from "./media";

const presentedMedia = {
    id: "media_123",
    filename: "lamp.webp",
    url: "https://cdn.example.com/media/lamp.webp",
    kind: "image" as const,
    objectKey: "media/lamp.webp",
    size: 1024,
    mimeType: "image/webp",
    altText: "A lamp",
    caption: null,
    width: 800,
    height: 800,
    durationMs: null,
    posterMediaId: null,
    posterUrl: null,
    folderId: null,
    status: "ready" as const,
    version: 2,
    createdAt: 1,
    updatedAt: 2,
    trashedAt: null,
    deletedAt: null,
};

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    const db = { id: "db" };
    const env = {
        CACHE: { id: "api-cache-kv" },
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
    } as unknown as Env;

    mocks.updateMediaFile.mockResolvedValue(presentedMedia);
    mocks.trashMediaFile.mockResolvedValue({
        ...presentedMedia,
        status: "trashed",
        trashedAt: 2,
    });
    mocks.restoreMediaFile.mockResolvedValue(presentedMedia);
    mocks.invalidateMediaDependentProductCaches.mockResolvedValue(undefined);

    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    app.route("/admin/media", adminMediaRoutes);
    return { app, db, env };
}

async function mutate(
    app: OpenAPIHono<{ Bindings: Env }>,
    env: Env,
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
) {
    return app.request(`/api/v1/admin/media${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }, env);
}

describe("admin media cache invalidation", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        {
            label: "metadata update",
            path: "/media_123",
            method: "PATCH" as const,
            body: { expectedVersion: 1, altText: "A lamp" },
            coreCall: () => mocks.updateMediaFile,
        },
        {
            label: "trash",
            path: "/media_123/trash",
            method: "POST" as const,
            body: { expectedVersion: 1 },
            coreCall: () => mocks.trashMediaFile,
        },
        {
            label: "restore",
            path: "/media_123/restore",
            method: "POST" as const,
            body: { expectedVersion: 1 },
            coreCall: () => mocks.restoreMediaFile,
        },
    ])("invalidates dependent products after $label commits", async ({ path, method, body, coreCall }) => {
        const { app, db, env } = createTestApp();

        const response = await mutate(app, env, path, method, body);

        expect(response.status).toBe(200);
        expect(coreCall()).toHaveBeenCalled();
        expect(mocks.invalidateMediaDependentProductCaches).toHaveBeenCalledWith(
            db,
            "media_123",
            expect.objectContaining({ env }),
        );
        expect(coreCall().mock.invocationCallOrder[0]).toBeLessThan(
            mocks.invalidateMediaDependentProductCaches.mock.invocationCallOrder[0]!,
        );
    });

    it("does not invalidate when a media write fails", async () => {
        const { app, env } = createTestApp();
        mocks.updateMediaFile.mockRejectedValueOnce(new Error("conflict"));

        const response = await mutate(app, env, "/media_123", "PATCH", {
            expectedVersion: 1,
            caption: "Updated",
        });

        expect(response.status).toBe(500);
        expect(mocks.invalidateMediaDependentProductCaches).not.toHaveBeenCalled();
    });
});
