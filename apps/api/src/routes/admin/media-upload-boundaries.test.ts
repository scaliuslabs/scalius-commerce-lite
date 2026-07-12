import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "media.ts"),
    "utf8",
);

describe("admin media upload transport boundaries", () => {
    it("rejects oversized parts before touching the request stream", () => {
        const handler = source.indexOf("app.openapi(uploadPartRoute");
        const sizeGuard = source.indexOf("declaredLength > MEDIA_MULTIPART_PART_SIZE_BYTES", handler);
        const bodyRead = source.indexOf("const body = c.req.raw.body", handler);
        const prefixRead = source.indexOf("inspectBodyPrefix", bodyRead);
        expect(sizeGuard).toBeGreaterThan(handler);
        expect(bodyRead).toBeGreaterThan(sizeGuard);
        expect(prefixRead).toBeGreaterThan(bodyRead);
    });

    it("does not parse a multipart form or buffer a complete video", () => {
        expect(source).not.toContain("parseBody(");
        expect(source).not.toContain("arrayBuffer(");
        expect(source).toContain('application/octet-stream');
        expect(source).toContain("actualSize: counted.actualSize");
    });
});
