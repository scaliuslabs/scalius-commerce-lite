import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { adminMediaRoutes } from "./media";

const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "media.ts"),
    "utf8",
);

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

    it("rejects oversized parts before touching the request stream", () => {
        const handler = source.indexOf("app.openapi(uploadPartRoute");
        const sizeGuard = source.indexOf("declaredLength > MEDIA_MULTIPART_PART_SIZE_BYTES", handler);
        const bodyRead = source.indexOf("const body = c.req.raw.body", handler);
        const boundedRead = source.indexOf("readExactMediaPart", bodyRead);
        expect(sizeGuard).toBeGreaterThan(handler);
        expect(bodyRead).toBeGreaterThan(sizeGuard);
        expect(boundedRead).toBeGreaterThan(bodyRead);
    });

    it("buffers only one bounded part into a known-length R2 body", () => {
        expect(source).not.toContain("parseBody(");
        expect(source).not.toContain("arrayBuffer(");
        expect(source).not.toContain("TransformStream");
        expect(source).not.toContain("countBody");
        expect(source).toContain('application/octet-stream');
        expect(source).toContain("const value = await readExactMediaPart(body, declaredLength)");
        expect(source).toContain("value.slice(0, Math.min(declaredLength, MEDIA_SIGNATURE_READ_BYTES))");
    });
});
