import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "media.service.ts"),
    "utf8",
);

describe("media poster projection query boundaries", () => {
    it("joins posters into a list page instead of enriching each row", () => {
        const start = source.indexOf("export async function listMediaFiles");
        const end = source.indexOf("export async function initiateMediaUpload", start);
        const list = source.slice(start, end);

        expect(list).toContain(".leftJoin(poster, eq(poster.id, media.posterMediaId))");
        expect(list).toContain("pageRows.map(presentMediaProjection)");
        expect(list).not.toContain("Promise.all");
        expect(list).not.toContain("pageRows.map(async");
    });

    it("uses one joined projection read for mutation responses", () => {
        const start = source.indexOf("async function readPresentedMedia");
        const end = source.indexOf("function expectedPartCount", start);
        const read = source.slice(start, end);

        expect(read).toContain(".leftJoin(poster, eq(poster.id, media.posterMediaId))");
        expect(read).toContain("presentMediaProjection(row)");
    });
});
