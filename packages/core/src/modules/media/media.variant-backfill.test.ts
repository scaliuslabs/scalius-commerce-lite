import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillMissingMediaVariants, updateMediaFile } from "./media.service";

const WEBP = new TextEncoder().encode("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ").buffer as ArrayBuffer;
const HOURS_AGO = (hours: number) => Math.floor(Date.now() / 1000) - hours * 3600;

/** R2 holds each original as its own key text; the fake Images binding reads that text back. */
function storage() {
    const objects = new Map<string, ArrayBuffer>();
    const bucket = {
        get: async (key: string) => {
            const body = objects.get(key);
            return body ? { arrayBuffer: async () => body } : null;
        },
        put: async (key: string, value: ArrayBuffer) => {
            objects.set(key, value);
            return {};
        },
        delete: async (keys: string | string[]) => {
            for (const key of [keys].flat()) objects.delete(key);
        },
    } as unknown as R2Bucket;
    const transforms: string[] = [];
    const images = {
        info: async (stream: ReadableStream) => {
            const source = await new Response(stream).text();
            if (source.includes("broken")) throw new Error("undecodable");
            return { format: "image/jpeg", fileSize: source.length, width: 700, height: 350 };
        },
        input: (stream: ReadableStream) => ({
            transform: ({ width }: { width: number }) => ({
                output: async () => {
                    transforms.push(`${await new Response(stream).text()}@${width}`);
                    return { response: () => new Response(WEBP) };
                },
            }),
        }),
    } as unknown as ImagesBinding;
    return { objects, bucket, images, transforms };
}

describe("scheduled media rendition backfill", () => {
    let db: Database;
    let sqlite: DatabaseSync;
    let store: ReturnType<typeof storage>;

    beforeEach(() => {
        ({ db, sqlite } = createSqliteD1Database());
        store = storage();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        sqlite.close();
        vi.restoreAllMocks();
    });

    function seed(id: string, options: {
        mime?: string;
        kind?: "image" | "video";
        status?: "ready" | "trashed" | "deleted";
        touchedHoursAgo?: number;
        variantWidth?: number;
        stored?: boolean;
    } = {}) {
        const mime = options.mime ?? "image/jpeg";
        const objectKey = `media/${id}.${mime.split("/")[1]}`;
        const status = options.status ?? "ready";
        const touched = HOURS_AGO(options.touchedHoursAgo ?? 48);
        sqlite.prepare(`
            INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, variant_width,
                created_at, updated_at, trashed_at, deleted_at)
            VALUES (?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, `${id}.jpg`, options.kind ?? "image", objectKey, mime, status, options.variantWidth ?? null,
            touched, touched, status === "ready" ? null : touched, status === "deleted" ? touched : null,
        );
        if (options.stored !== false) store.objects.set(objectKey, new TextEncoder().encode(id).buffer as ArrayBuffer);
        return objectKey;
    }

    const row = (id: string) => sqlite.prepare("SELECT variant_width, version, updated_at FROM media WHERE id = ?")
        .get(id) as { variant_width: number | null; version: number; updated_at: number };
    const run = (limit = 10) => backfillMissingMediaVariants(db, store.bucket, store.images, { limit });

    it("renders the ladder for old original-only still images, oldest first and within the limit", async () => {
        seed("media_newer_jpeg", { touchedHoursAgo: 5 });
        const oldest = seed("media_oldest_png", { mime: "image/png", touchedHoursAgo: 50 });
        seed("media_trashed_webp", { mime: "image/webp", status: "trashed", touchedHoursAgo: 30 });

        await expect(run(2)).resolves.toEqual({ scanned: 2, generated: 2, failed: 0 });

        expect(row("media_oldest_png")).toMatchObject({ variant_width: 700, version: 1 });
        expect(row("media_trashed_webp")).toMatchObject({ variant_width: 700 });
        expect(row("media_newer_jpeg").variant_width).toBeNull();
        expect([160, 320, 480, 640, 700].every((width) => store.objects.has(`${oldest}/${width}.webp`))).toBe(true);

        await expect(run(2)).resolves.toEqual({ scanned: 1, generated: 1, failed: 0 });
        store.transforms.length = 0;
        await expect(run()).resolves.toEqual({ scanned: 0, generated: 0, failed: 0 });
        expect(store.transforms).toEqual([]);
    });

    it("leaves fresh uploads, animated GIFs, videos, finished and deleted media alone", async () => {
        seed("media_fresh_upload", { touchedHoursAgo: 0 });
        seed("media_animated_gif", { mime: "image/gif" });
        seed("media_clip_video", { mime: "video/mp4", kind: "video" });
        seed("media_already_done", { variantWidth: 960 });
        seed("media_deleted_jpeg", { status: "deleted" });

        await expect(run()).resolves.toEqual({ scanned: 0, generated: 0, failed: 0 });
        expect(store.transforms).toEqual([]);
    });

    it("keeps going past a broken image and holds it back for the quiet period without a version bump", async () => {
        seed("media_broken_jpeg", { touchedHoursAgo: 72 });
        seed("media_missing_blob", { touchedHoursAgo: 60, stored: false });
        seed("media_healthy_jpeg", { touchedHoursAgo: 24 });

        await expect(run()).resolves.toEqual({ scanned: 3, generated: 1, failed: 2 });
        expect(row("media_healthy_jpeg").variant_width).toBe(700);
        for (const id of ["media_broken_jpeg", "media_missing_blob"]) {
            expect(row(id)).toMatchObject({ variant_width: null, version: 1 });
            expect(row(id).updated_at).toBeGreaterThan(HOURS_AGO(1));
        }
        expect(console.warn).toHaveBeenCalledWith("[media] rendition backfill failed", { mediaId: "media_broken_jpeg", error: "Error" });
        expect(console.warn).toHaveBeenCalledWith("[media] rendition backfill failed", { mediaId: "media_missing_blob", error: "NotFoundError" });

        await expect(run()).resolves.toEqual({ scanned: 0, generated: 0, failed: 0 });

        // A later candidate still goes first once the broken ones are eligible again.
        sqlite.prepare("UPDATE media SET updated_at = ? WHERE id IN ('media_broken_jpeg', 'media_missing_blob')").run(HOURS_AGO(2));
        seed("media_older_backlog", { touchedHoursAgo: 3 });
        await expect(run(1)).resolves.toEqual({ scanned: 1, generated: 1, failed: 0 });
        expect(row("media_older_backlog").variant_width).toBe(700);
    });

    it("does not conflict with a merchant edit opened before the renditions were saved", async () => {
        seed("media_edited_later");
        await run();

        await expect(updateMediaFile(db, "media_edited_later", { expectedVersion: 1, altText: "Blue shirt" }))
            .resolves.toMatchObject({ altText: "Blue shirt", variantWidth: 700, version: 2 });
    });
});
