import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import {
    completeMediaUpload,
    deleteMediaFolder,
    initiateMediaUpload,
    MediaDependencyConflictError,
    permanentlyDeleteMediaFile,
    uploadMediaPart,
} from "./media.service";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).buffer;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;

function fakeBucket(sqlite: () => DatabaseSync) {
    const calls: string[] = [];
    const objects = new Map<string, number>();
    const sessionStates: string[] = [];
    let failCreate = false;
    let uploads = 0;
    const upload = (key: string, uploadId: string) => ({
        key,
        uploadId,
        uploadPart: async (partNumber: number, value: ArrayBuffer) => {
            calls.push(`uploadPart:${partNumber}`);
            return { partNumber, etag: `etag-${partNumber}`, size: value.byteLength };
        },
        complete: async () => {
            calls.push("complete");
            objects.set(key, PNG.byteLength);
            return { key, size: PNG.byteLength };
        },
        abort: async () => { calls.push("abort"); },
    });
    const bucket = {
        createMultipartUpload: async (key: string) => {
            calls.push("create");
            sessionStates.push(...(sqlite().prepare("SELECT state FROM media_upload_sessions WHERE object_key = ?")
                .all(key) as Array<{ state: string }>).map((row) => row.state));
            if (failCreate) throw new Error("r2 down");
            return upload(key, `upload-${++uploads}`);
        },
        resumeMultipartUpload: (key: string, uploadId: string) => upload(key, uploadId),
        head: async (key: string) => (objects.has(key) ? { key, size: objects.get(key) } : null),
        delete: async (keys: string | string[]) => {
            for (const key of [keys].flat()) {
                calls.push(`delete:${key}`);
                objects.delete(key);
            }
        },
    } as unknown as R2Bucket;
    return { bucket, calls, objects, sessionStates, failNextCreate: () => { failCreate = true; } };
}

function setup() {
    const harness = createSqliteD1Database();
    return { ...harness, storage: fakeBucket(() => harness.sqlite) };
}

const fileInput = { filename: "logo.png", mimeType: "image/png", size: PNG.byteLength };

describe("media upload lifecycle", () => {
    it("claims the durable D1 session before creating the R2 multipart upload", async () => {
        const { sqlite, db, storage } = setup();

        const session = await initiateMediaUpload(db, fileInput, storage.bucket);
        expect(storage.sessionStates).toEqual(["initializing"]);
        expect(session.state).toBe("initiated");

        storage.failNextCreate();
        await expect(initiateMediaUpload(db, fileInput, storage.bucket)).rejects.toThrow();
        expect(sqlite.prepare("SELECT state FROM media_upload_sessions ORDER BY rowid").all())
            .toEqual([{ state: "initiated" }, { state: "failed" }]);
    });

    it("requires matching first-part signature evidence before any R2 part write", async () => {
        const { db, storage } = setup();
        const session = await initiateMediaUpload(db, fileInput, storage.bucket);
        const part = { sessionId: session.id, partNumber: 1, size: PNG.byteLength, value: PNG };

        await expect(uploadMediaPart(db, part, storage.bucket)).rejects.toBeInstanceOf(ValidationError);
        await expect(uploadMediaPart(db, { ...part, signatureBytes: JPEG }, storage.bucket))
            .rejects.toBeInstanceOf(ValidationError);
        expect(storage.calls).toEqual(["create"]);
    });

    it("completes once, reconciles an already-complete R2 object, and keeps committed retries read-only", async () => {
        const { sqlite, db, storage } = setup();
        const first = await initiateMediaUpload(db, fileInput, storage.bucket);
        await uploadMediaPart(db, { sessionId: first.id, partNumber: 1, size: PNG.byteLength, value: PNG, signatureBytes: PNG }, storage.bucket);

        const media = await completeMediaUpload(db, first.id, storage.bucket);
        await expect(completeMediaUpload(db, first.id, storage.bucket)).resolves.toMatchObject({ id: media.id });
        expect(storage.calls.filter((call) => call === "complete")).toHaveLength(1);

        const second = await initiateMediaUpload(db, { ...fileInput, filename: "again.png" }, storage.bucket);
        await uploadMediaPart(db, { sessionId: second.id, partNumber: 1, size: PNG.byteLength, value: PNG, signatureBytes: PNG }, storage.bucket);
        const { object_key: objectKey } = sqlite.prepare("SELECT object_key FROM media_upload_sessions WHERE id = ?")
            .get(second.id) as { object_key: string };
        storage.objects.set(objectKey, PNG.byteLength);
        await expect(completeMediaUpload(db, second.id, storage.bucket)).resolves.toMatchObject({ status: "ready" });
        expect(storage.calls.filter((call) => call === "complete")).toHaveLength(1);
    });
});

describe("media deletion guards", () => {
    it("blocks permanent delete of product media before claiming or deleting the blob", async () => {
        const { sqlite, db, storage } = setup();
        sqlite.exec(`
            INSERT INTO media (id, filename, kind, object_key, size, mime_type, status)
            VALUES ('media_1', 'a.png', 'image', 'media/media_1.png', 12, 'image/png', 'ready');
            INSERT INTO products (id, name, price, slug) VALUES ('prod_1', 'Product', 10, 'product');
            INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_prod_1', 'prod_1', 'media_1', 1, 0);
            UPDATE media SET status = 'trashed', version = 2, trashed_at = unixepoch() WHERE id = 'media_1';
        `);

        await expect(permanentlyDeleteMediaFile(db, "media_1", 2, storage.bucket))
            .rejects.toBeInstanceOf(MediaDependencyConflictError);
        expect(sqlite.prepare("SELECT status FROM media WHERE id = 'media_1'").get()).toEqual({ status: "trashed" });
        expect(storage.calls).toEqual([]);
    });

    it("guards folder deletion before detaching its media", async () => {
        const { sqlite, db } = setup();
        sqlite.exec(`
            INSERT INTO media_folders (id, name, version) VALUES ('folder_1', 'Folder', 2);
            INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, folder_id)
            VALUES ('media_2', 'b.png', 'image', 'media/media_2.png', 12, 'image/png', 'ready', 'folder_1');
        `);

        await expect(deleteMediaFolder(db, "folder_1", 1)).rejects.toBeInstanceOf(ConflictError);
        expect(sqlite.prepare("SELECT folder_id FROM media WHERE id = 'media_2'").get()).toEqual({ folder_id: "folder_1" });

        await deleteMediaFolder(db, "folder_1", 2);
        expect(sqlite.prepare("SELECT folder_id FROM media WHERE id = 'media_2'").get()).toEqual({ folder_id: null });
    });
});
