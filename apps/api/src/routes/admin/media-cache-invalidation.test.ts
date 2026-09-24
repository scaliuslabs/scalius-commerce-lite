import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    updateMediaFile: vi.fn(),
    trashMediaFile: vi.fn(),
    restoreMediaFile: vi.fn(),
    saveMediaVariants: vi.fn(),
    completeMediaUpload: vi.fn(),
    bumpCacheGeneration: vi.fn(),
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
        saveMediaVariants: mocks.saveMediaVariants,
        completeMediaUpload: mocks.completeMediaUpload,
    };
});

vi.mock("../../utils/cache-generation", () => ({
    bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import { MEDIA_VARIANTS_JOB_DELAY_SECONDS } from "@scalius/core/modules/media";
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
    } as unknown as Env;

    mocks.updateMediaFile.mockResolvedValue(presentedMedia);
    mocks.trashMediaFile.mockResolvedValue({
        ...presentedMedia,
        status: "trashed",
        trashedAt: 2,
    });
    mocks.restoreMediaFile.mockResolvedValue(presentedMedia);
    mocks.saveMediaVariants.mockResolvedValue({ ...presentedMedia, variantWidth: 800 });
    mocks.completeMediaUpload.mockResolvedValue(presentedMedia);
    mocks.bumpCacheGeneration.mockResolvedValue(undefined);

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
        const { app, env } = createTestApp();

        const response = await mutate(app, env, path, method, body);

        expect(response.status).toBe(200);
        expect(coreCall()).toHaveBeenCalled();
        expect(mocks.bumpCacheGeneration).toHaveBeenCalledWith(expect.objectContaining({ env }));
        expect(coreCall().mock.invocationCallOrder[0]).toBeLessThan(
            mocks.bumpCacheGeneration.mock.invocationCallOrder[0]!,
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
        expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
    });

    it("stores browser renditions from the multipart form and invalidates dependent products", async () => {
        const { app, db, env } = createTestApp();
        const form = new FormData();
        form.set("width", "800");
        form.set("height", "600");
        form.set("w160", new Blob(["a"], { type: "image/webp" }), "160.webp");
        form.set("w800", new Blob(["bb"], { type: "image/webp" }), "800.webp");
        form.set("note", "ignored");

        const response = await app.request("/api/v1/admin/media/media_123/variants", {
            method: "POST",
            body: form,
        }, env);

        expect(response.status).toBe(200);
        const [, id, input, bucket] = mocks.saveMediaVariants.mock.calls[0]!;
        expect(id).toBe("media_123");
        expect(bucket).toBe(env.BUCKET);
        expect({ width: input.width, height: input.height, widths: [...input.files.keys()] })
            .toEqual({ width: 800, height: 600, widths: [160, 800] });
        expect(input.files.get(800).byteLength).toBe(2);
        expect(mocks.bumpCacheGeneration).toHaveBeenCalledWith(expect.objectContaining({ env }));
    });

    it("renders renditions on the server unless the dashboard uploads its own", async () => {
        const { app, env } = createTestApp();
        const images = { id: "images" };
        const withImages = { ...env, IMAGES: images } as unknown as Env;

        await app.request("/api/v1/admin/media/uploads/mup_12345678/complete", { method: "POST" }, withImages);
        await app.request("/api/v1/admin/media/uploads/mup_12345678/complete?variants=client", { method: "POST" }, withImages);

        expect(mocks.completeMediaUpload.mock.calls.map((call) => call[3])).toEqual([images, undefined]);
    });

    it("schedules exactly one delayed server render when a completed upload still lacks renditions", async () => {
        const { app, env } = createTestApp();
        const send = vi.fn(async () => undefined);
        const withQueue = { ...env, IMAGES: { id: "images" }, JOBS_QUEUE: { send } } as unknown as Env;
        mocks.completeMediaUpload.mockResolvedValueOnce({ ...presentedMedia, variantWidth: null });

        const response = await app.request("/api/v1/admin/media/uploads/mup_12345678/complete?variants=client", { method: "POST" }, withQueue);

        expect(response.status).toBe(200);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(
            { type: "media.render_variants", mediaId: "media_123" },
            { delaySeconds: MEDIA_VARIANTS_JOB_DELAY_SECONDS },
        );
        // A brand-new upload is not referenced yet; the job bumps if it renders.
        expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
    });

    it("schedules nothing when completion already rendered, or without the Images binding", async () => {
        const { app, env } = createTestApp();
        const send = vi.fn(async () => undefined);
        mocks.completeMediaUpload
            .mockResolvedValueOnce({ ...presentedMedia, variantWidth: 800 })
            .mockResolvedValueOnce({ ...presentedMedia, variantWidth: null });

        await app.request("/api/v1/admin/media/uploads/mup_12345678/complete", { method: "POST" },
            { ...env, IMAGES: { id: "images" }, JOBS_QUEUE: { send } } as unknown as Env);
        await app.request("/api/v1/admin/media/uploads/mup_12345678/complete?variants=client", { method: "POST" },
            { ...env, JOBS_QUEUE: { send } } as unknown as Env);

        expect(send).not.toHaveBeenCalled();
    });

    it("still returns the committed upload when the queue rejects", async () => {
        const { app, env } = createTestApp();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const send = vi.fn(async () => { throw new Error("queue down"); });
        mocks.completeMediaUpload.mockResolvedValueOnce({ ...presentedMedia, variantWidth: null });

        const response = await app.request("/api/v1/admin/media/uploads/mup_12345678/complete?variants=client", { method: "POST" },
            { ...env, IMAGES: { id: "images" }, JOBS_QUEUE: { send } } as unknown as Env);

        expect(response.status).toBe(200);
        expect(send).toHaveBeenCalledTimes(1);
    });
});
