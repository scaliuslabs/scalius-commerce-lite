import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    backfillMissingMediaVariants,
    enqueueMediaVariantsBacklog,
    enqueueMediaVariantsJob,
    MEDIA_VARIANTS_JOB_DELAY_SECONDS,
    renderMissingMediaVariants,
    updateMediaFile,
} from "./media.service";

const WEBP = new TextEncoder().encode("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ").buffer as ArrayBuffer;
const MINUTES_AGO = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;
const HOURS_AGO = (hours: number) => MINUTES_AGO(hours * 60);

/** R2 holds each original as its own key text; the fake Images binding reads that text back. */
function storage(options: { onInfo?: (source: string) => Promise<void> | void } = {}) {
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
    const infos: string[] = [];
    const images = {
        info: async (stream: ReadableStream) => {
            const source = await new Response(stream).text();
            infos.push(source);
            await options.onInfo?.(source);
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
    return { objects, bucket, images, transforms, infos };
}

describe("media rendition backfill and delayed render job", () => {
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
        touchedMinutesAgo?: number;
        variantWidth?: number;
        stored?: boolean;
    } = {}) {
        const mime = options.mime ?? "image/jpeg";
        const objectKey = `media/${id}.${mime.split("/")[1]}`;
        const status = options.status ?? "ready";
        const touched = MINUTES_AGO(options.touchedMinutesAgo ?? 48 * 60);
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
    const pending = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM media WHERE variant_width IS NULL").get() as { n: number }).n;
    const run = (options: Partial<Parameters<typeof backfillMissingMediaVariants>[3]> = {}) =>
        backfillMissingMediaVariants(db, store.bucket, store.images, {
            deadline: Date.now() + 60_000,
            concurrency: 2,
            maxImages: 100,
            ...options,
        });

    describe("scheduled backfill", () => {
        it("renders the ladder for original-only still images, oldest first, up to the per-run cap", async () => {
            seed("media_newer_jpeg", { touchedMinutesAgo: 5 * 60 });
            const oldest = seed("media_oldest_png", { mime: "image/png", touchedMinutesAgo: 50 * 60 });
            seed("media_trashed_webp", { mime: "image/webp", status: "trashed", touchedMinutesAgo: 30 * 60 });

            await expect(run({ maxImages: 2, concurrency: 1 }))
                .resolves.toEqual({ scanned: 2, generated: 2, failed: 0, hasMore: true });

            expect(row("media_oldest_png")).toMatchObject({ variant_width: 700, version: 1 });
            expect(row("media_trashed_webp")).toMatchObject({ variant_width: 700 });
            expect(row("media_newer_jpeg").variant_width).toBeNull();
            expect([160, 240, 320, 400, 480, 640, 700].every((width) => store.objects.has(`${oldest}/${width}.webp`))).toBe(true);

            await expect(run()).resolves.toEqual({ scanned: 1, generated: 1, failed: 0, hasMore: false });
            store.transforms.length = 0;
            await expect(run()).resolves.toEqual({ scanned: 0, generated: 0, failed: 0, hasMore: false });
            expect(store.transforms).toEqual([]);
        });

        it("fans the backlog beyond the inline share out to the queue in batches of 100, oldest first", async () => {
            for (let index = 0; index < 260; index += 1) {
                seed(`media_fanout_${String(index).padStart(3, "0")}`, { touchedMinutesAgo: 2_000 - index });
            }
            seed("media_fresh_upload", { touchedMinutesAgo: 1 });
            seed("media_done_already", { variantWidth: 700 });
            const batches: Array<Array<{ body: { type: string; mediaId: string }; delaySeconds?: number }>> = [];
            const queue = { sendBatch: vi.fn(async (messages: Array<{ body: { type: string; mediaId: string }; delaySeconds?: number }>) => {
                batches.push([...messages]);
            }) };

            await expect(enqueueMediaVariantsBacklog(db, queue, { skip: 40, limit: 150 }))
                .resolves.toEqual({ queued: 150, hasMore: true });
            expect(batches.map((batch) => batch.length)).toEqual([100, 50]);
            expect(batches[0]![0]).toEqual({ body: { type: "media.render_variants", mediaId: "media_fanout_040" }, delaySeconds: 0 });
            expect(batches[1]!.at(-1)!.body.mediaId).toBe("media_fanout_189");

            batches.length = 0;
            await expect(enqueueMediaVariantsBacklog(db, queue, { skip: 240, limit: 1_000 }))
                .resolves.toEqual({ queued: 20, hasMore: false });
            // Fresh uploads wait for their own pipeline; done images never queue.
            expect(batches.flat().map((message) => message.body.mediaId)).not.toContain("media_fresh_upload");
            expect(batches.flat().map((message) => message.body.mediaId)).not.toContain("media_done_already");
            expect(await enqueueMediaVariantsBacklog(db, queue, { skip: 300, limit: 1_000 })).toEqual({ queued: 0, hasMore: false });
        });

        it("drains a backlog larger than one candidate page in a single run when under budget", async () => {
            for (let index = 0; index < 45; index += 1) {
                seed(`media_backlog_${String(index).padStart(2, "0")}`, { touchedMinutesAgo: 60 + index });
            }

            await expect(run({ concurrency: 3 })).resolves.toEqual({ scanned: 45, generated: 45, failed: 0, hasMore: false });
            expect(pending()).toBe(0);
        });

        it("starts no new image once the deadline passes and leaves the rest for the next run", async () => {
            const start = Date.now();
            let clock = start;
            store = storage({ onInfo: () => { clock += 1_000; } });
            for (let index = 0; index < 6; index += 1) seed(`media_budget_${index}`, { touchedMinutesAgo: 60 + index });

            const result = await backfillMissingMediaVariants(db, store.bucket, store.images, {
                deadline: start + 2_500,
                concurrency: 1,
                maxImages: 100,
                now: () => clock,
            });

            // Started at +0, +1000 and +2000 ms; the fourth would start at +3000.
            expect(result).toEqual({ scanned: 3, generated: 3, failed: 0, hasMore: true });
            expect(store.infos).toEqual(["media_budget_5", "media_budget_4", "media_budget_3"]);
            expect(pending()).toBe(3);
        });

        it("never has more images in flight than the concurrency cap", async () => {
            let inFlight = 0;
            let peak = 0;
            store = storage({
                onInfo: async () => {
                    inFlight += 1;
                    peak = Math.max(peak, inFlight);
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    inFlight -= 1;
                },
            });
            for (let index = 0; index < 9; index += 1) seed(`media_parallel_${index}`);

            await expect(run({ concurrency: 3 })).resolves.toMatchObject({ scanned: 9, generated: 9 });
            expect(peak).toBe(3);
        });

        it("leaves recently touched uploads, animated GIFs, videos, finished and deleted media alone", async () => {
            seed("media_fresh_upload", { touchedMinutesAgo: 0 });
            seed("media_browser_saving", { touchedMinutesAgo: 5 });
            seed("media_animated_gif", { mime: "image/gif" });
            seed("media_clip_video", { mime: "video/mp4", kind: "video" });
            seed("media_already_done", { variantWidth: 960 });
            seed("media_deleted_jpeg", { status: "deleted" });

            await expect(run()).resolves.toEqual({ scanned: 0, generated: 0, failed: 0, hasMore: false });
            expect(store.transforms).toEqual([]);

            // Past the ten-minute quiet window the server takes over.
            seed("media_abandoned_upload", { touchedMinutesAgo: 15 });
            await expect(run()).resolves.toMatchObject({ scanned: 1, generated: 1 });
        });

        it("keeps going past broken images and holds them back for the quiet window without a version bump", async () => {
            seed("media_broken_jpeg", { touchedMinutesAgo: 72 * 60 });
            seed("media_missing_blob", { touchedMinutesAgo: 60 * 60, stored: false });
            seed("media_healthy_jpeg", { touchedMinutesAgo: 24 * 60 });

            await expect(run({ concurrency: 1 })).resolves.toEqual({ scanned: 3, generated: 1, failed: 2, hasMore: false });
            expect(row("media_healthy_jpeg").variant_width).toBe(700);
            for (const id of ["media_broken_jpeg", "media_missing_blob"]) {
                expect(row(id)).toMatchObject({ variant_width: null, version: 1 });
                expect(row(id).updated_at).toBeGreaterThan(HOURS_AGO(1));
            }
            expect(console.warn).toHaveBeenCalledWith("[media] rendition generation failed", { mediaId: "media_broken_jpeg", error: "Error" });
            expect(console.warn).toHaveBeenCalledWith("[media] rendition generation failed", { mediaId: "media_missing_blob", error: "NotFoundError" });

            await expect(run()).resolves.toEqual({ scanned: 0, generated: 0, failed: 0, hasMore: false });

            // Older backlog still goes first once the broken ones are eligible again.
            sqlite.prepare("UPDATE media SET updated_at = ? WHERE id IN ('media_broken_jpeg', 'media_missing_blob')").run(MINUTES_AGO(20));
            seed("media_older_backlog", { touchedMinutesAgo: 30 });
            await expect(run({ maxImages: 1 })).resolves.toMatchObject({ scanned: 1, generated: 1, hasMore: true });
            expect(row("media_older_backlog").variant_width).toBe(700);
        });

        it("does not conflict with a merchant edit opened before the renditions were saved", async () => {
            seed("media_edited_later");
            await run();

            await expect(updateMediaFile(db, "media_edited_later", { expectedVersion: 1, altText: "Blue shirt" }))
                .resolves.toMatchObject({ altText: "Blue shirt", variantWidth: 700, version: 2 });
        });
    });

    describe("delayed render job", () => {
        it("renders a fresh upload once and skips it on every later delivery", async () => {
            seed("media_fresh_upload", { touchedMinutesAgo: 2 });

            await expect(renderMissingMediaVariants(db, "media_fresh_upload", store.bucket, store.images)).resolves.toBe("generated");
            expect(row("media_fresh_upload")).toMatchObject({ variant_width: 700, version: 1 });
            store.transforms.length = 0;

            await expect(renderMissingMediaVariants(db, "media_fresh_upload", store.bucket, store.images)).resolves.toBe("skipped");
            expect(store.transforms).toEqual([]);
        });

        it("skips media the browser already rendered, cannot render, or that is gone", async () => {
            seed("media_browser_done", { touchedMinutesAgo: 1, variantWidth: 960 });
            seed("media_animated_gif", { mime: "image/gif" });
            seed("media_clip_video", { mime: "video/mp4", kind: "video" });
            seed("media_deleted_jpeg", { status: "deleted" });

            for (const id of ["media_browser_done", "media_animated_gif", "media_clip_video", "media_deleted_jpeg", "media_never_existed"]) {
                await expect(renderMissingMediaVariants(db, id, store.bucket, store.images)).resolves.toBe("skipped");
            }
            expect(store.infos).toEqual([]);
        });

        it("reports a broken upload as failed without throwing and leaves it for the backfill", async () => {
            seed("media_broken_upload", { touchedMinutesAgo: 3 });

            await expect(renderMissingMediaVariants(db, "media_broken_upload", store.bucket, store.images)).resolves.toBe("failed");
            expect(row("media_broken_upload")).toMatchObject({ variant_width: null, version: 1 });
        });
    });

    describe("upload completion enqueue", () => {
        const image = { id: "media_new", kind: "image", mimeType: "image/jpeg", variantWidth: null };

        it("enqueues exactly one delayed render for an original-only still image", async () => {
            const queue = { send: vi.fn(async () => undefined) };

            await expect(enqueueMediaVariantsJob(queue, store.images, image)).resolves.toBe(true);
            expect(queue.send).toHaveBeenCalledTimes(1);
            expect(queue.send).toHaveBeenCalledWith(
                { type: "media.render_variants", mediaId: "media_new" },
                { delaySeconds: MEDIA_VARIANTS_JOB_DELAY_SECONDS },
            );
        });

        it("enqueues nothing for rendered media, GIFs, videos, or without the Images binding", async () => {
            const queue = { send: vi.fn(async () => undefined) };

            for (const file of [
                { ...image, variantWidth: 700 },
                { ...image, mimeType: "image/gif" },
                { ...image, kind: "video", mimeType: "video/mp4" },
            ]) {
                await expect(enqueueMediaVariantsJob(queue, store.images, file)).resolves.toBe(false);
            }
            await expect(enqueueMediaVariantsJob(queue, undefined, image)).resolves.toBe(false);
            await expect(enqueueMediaVariantsJob(undefined, store.images, image)).resolves.toBe(false);
            expect(queue.send).not.toHaveBeenCalled();
        });

        it("never fails the committed upload when the queue rejects", async () => {
            const queue = { send: vi.fn(async () => { throw new Error("queue down"); }) };

            await expect(enqueueMediaVariantsJob(queue, store.images, image)).resolves.toBe(false);
            expect(console.warn).toHaveBeenCalledWith("[media] rendition job enqueue failed", { mediaId: "media_new", error: "Error" });
        });
    });
});
