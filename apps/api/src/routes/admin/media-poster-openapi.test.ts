import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { adminMediaRoutes } from "./media";

type OpenApiDocument = {
    paths?: Record<string, Record<string, unknown>>;
};

function operationJson(spec: OpenApiDocument, path: string, method: string): string {
    const operation = spec.paths?.[path]?.[method];
    if (!operation) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
    return JSON.stringify(operation);
}

describe("admin media poster OpenAPI contract", () => {
    it("returns a nullable poster URL from every media file projection", () => {
        const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
        app.route("/media", adminMediaRoutes);
        const spec = app.getOpenAPIDocument({
            openapi: "3.0.0",
            info: { title: "Media", version: "test" },
        }) as unknown as OpenApiDocument;

        for (const [path, method] of [
            ["/api/v1/admin/media", "get"],
            ["/api/v1/admin/media/uploads/{id}/complete", "post"],
            ["/api/v1/admin/media/{id}", "patch"],
            ["/api/v1/admin/media/{id}/trash", "post"],
            ["/api/v1/admin/media/{id}/restore", "post"],
        ] as const) {
            const json = operationJson(spec, path, method);
            expect(json, `${method.toUpperCase()} ${path}`).toContain('"posterUrl"');
            expect(json, `${method.toUpperCase()} ${path}`).toContain('"nullable":true');
        }
    });
});
