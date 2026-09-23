import { describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { MEDIA_MULTIPART_PART_SIZE_BYTES } from "@scalius/shared/media-policy";
import { errorResponseFromError } from "../../utils/api-response";
import { adminMediaRoutes } from "./media";

describe("admin media upload transport boundaries", () => {
    it("publishes an exact bounded octet-stream request contract", () => {
        const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
        app.route("/admin/media", adminMediaRoutes);
        const document = app.getOpenAPIDocument({
            openapi: "3.0.0",
            info: { title: "Media upload", version: "test" },
        }) as unknown as {
            paths: Record<string, Record<string, {
                operationId?: string;
                requestBody?: {
                    required?: boolean;
                    content?: Record<string, { schema?: Record<string, unknown> }>;
                };
            }>>;
        };
        const operation = document.paths[
            "/api/v1/admin/media/uploads/{id}/parts/{partNumber}"
        ]?.put;
        expect(operation?.operationId).toBe("dashboard.media.upload_part");
        expect(operation?.requestBody).toEqual({
            required: true,
            content: {
                "application/octet-stream": {
                    schema: {
                        type: "string",
                        format: "binary",
                        minLength: 1,
                        maxLength: 5_242_880,
                    },
                },
            },
        });
    });

    it.each([
        ["an oversized declared length", "application/octet-stream", String(MEDIA_MULTIPART_PART_SIZE_BYTES + 1)],
        ["a missing declared length", "application/octet-stream", undefined],
        ["a non-binary content type", "multipart/form-data", "4"],
    ])("rejects %s before touching the request stream or storage", async (_, contentType, contentLength) => {
        const pulled = vi.fn();
        const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
        app.onError((error, c) => {
            const { body, status } = errorResponseFromError(error);
            return c.json(body, status);
        });
        app.use("*", async (c, next) => {
            c.set("db", new Proxy({}, { get: () => { throw new Error("db touched"); } }) as never);
            await next();
        });
        app.route("/admin/media", adminMediaRoutes);
        const headers: Record<string, string> = { "Content-Type": contentType };
        if (contentLength) headers["Content-Length"] = contentLength;

        const response = await app.request("/api/v1/admin/media/uploads/upload_1234/parts/1", {
            method: "PUT",
            headers,
            body: new ReadableStream({ pull: pulled }, { highWaterMark: 0 }),
            duplex: "half",
        } as RequestInit);

        expect(response.status).toBe(400);
        expect(pulled).not.toHaveBeenCalled();
    });
});
