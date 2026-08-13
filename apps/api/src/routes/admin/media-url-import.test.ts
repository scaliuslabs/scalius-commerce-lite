import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    initiateMediaUpload,
    uploadMediaPart,
    completeMediaUpload,
    abortMediaUpload,
} = vi.hoisted(() => ({
    initiateMediaUpload: vi.fn(),
    uploadMediaPart: vi.fn(),
    completeMediaUpload: vi.fn(),
    abortMediaUpload: vi.fn(),
}));

vi.mock("@scalius/core/modules/media", () => ({
    initiateMediaUpload,
    uploadMediaPart,
    completeMediaUpload,
    abortMediaUpload,
}));

import { importMediaFromUrl } from "./media-url-import";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const db = {} as never;
const bucket = {} as R2Bucket;

function response(bytes: Uint8Array, headers: Record<string, string> = {}) {
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { headers: {
        "Content-Type": "image/png",
        "Content-Length": String(bytes.byteLength),
        ...headers,
    } });
}

describe("remote media import", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        initiateMediaUpload.mockResolvedValue({ id: "mup_remote", expectedParts: 1 });
        uploadMediaPart.mockResolvedValue({ partNumber: 1, size: png.byteLength });
        completeMediaUpload.mockResolvedValue({ id: "media_remote", mimeType: "image/png" });
        abortMediaUpload.mockResolvedValue(undefined);
    });

    it("imports through the existing durable upload authority", async () => {
        const fetcher = vi.fn().mockResolvedValue(response(png));
        await expect(importMediaFromUrl({
            db, bucket, sourceUrl: "https://cdn.example.test/image.png", filename: "image.png", fetcher,
        })).resolves.toMatchObject({ id: "media_remote" });
        expect(fetcher).toHaveBeenCalledWith(new URL("https://cdn.example.test/image.png"), expect.objectContaining({
            redirect: "manual", cache: "no-store",
        }));
        expect(initiateMediaUpload).toHaveBeenCalledWith(db, expect.objectContaining({
            filename: "image.png", mimeType: "image/png", size: 8,
        }), bucket);
        expect(uploadMediaPart).toHaveBeenCalledWith(db, expect.objectContaining({
            sessionId: "mup_remote", partNumber: 1, size: 8,
        }), bucket);
        expect(completeMediaUpload).toHaveBeenCalledWith(db, "mup_remote", bucket);
        expect(abortMediaUpload).not.toHaveBeenCalled();
    });

    it.each([
        "http://cdn.example.test/image.png",
        "https://127.0.0.1/image.png",
        "https://[::1]/image.png",
        "https://metadata.internal/image.png",
        "https://user:secret@cdn.example.test/image.png",
        "https://cdn.example.test:8443/image.png",
    ])("rejects non-public source %s before fetching", async (sourceUrl) => {
        const fetcher = vi.fn();
        await expect(importMediaFromUrl({ db, bucket, sourceUrl, fetcher })).rejects.toMatchObject({
            message: "Media import requires an absolute public HTTPS URL.",
        });
        expect(fetcher).not.toHaveBeenCalled();
        expect(initiateMediaUpload).not.toHaveBeenCalled();
    });

    it("revalidates redirects and never forwards credentials", async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://assets.example.test/final.png" } }))
            .mockResolvedValueOnce(response(png));
        await importMediaFromUrl({ db, bucket, sourceUrl: "https://cdn.example.test/start", fetcher });
        expect(fetcher).toHaveBeenNthCalledWith(2, new URL("https://assets.example.test/final.png"), expect.objectContaining({
            redirect: "manual",
        }));
        for (const [, init] of fetcher.mock.calls) {
            expect(new Headers(init.headers).has("authorization")).toBe(false);
            expect(new Headers(init.headers).has("cookie")).toBe(false);
        }
    });

    it.each([
        [{ "Content-Length": "" }, "exact Content-Length"],
        [{ "Content-Length": "8.0" }, "exact Content-Length"],
        [{ "Content-Encoding": "gzip" }, "compressed transfer encoding"],
        [{ "Content-Type": "image/svg+xml" }, "unsupported Content-Type"],
    ])("rejects ambiguous remote metadata %o", async (headers, message) => {
        await expect(importMediaFromUrl({
            db, bucket, sourceUrl: "https://cdn.example.test/image", fetcher: vi.fn().mockResolvedValue(response(png, headers)),
        })).rejects.toThrow(message);
        expect(initiateMediaUpload).not.toHaveBeenCalled();
    });

    it("rejects files larger than the MIME-specific policy before creating a session", async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(png.buffer as ArrayBuffer, { headers: {
            "Content-Type": "image/png",
            "Content-Length": String(20 * 1024 * 1024 + 1),
        } }));
        await expect(importMediaFromUrl({
            db, bucket, sourceUrl: "https://cdn.example.test/oversize.png", fetcher,
        })).rejects.toThrow("exceeds the 20 MB image limit");
        expect(initiateMediaUpload).not.toHaveBeenCalled();
    });

    it("splits at the exact five MiB upload boundary", async () => {
        const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
        bytes.set(png);
        await importMediaFromUrl({
            db, bucket, sourceUrl: "https://cdn.example.test/large.png", filename: "large.png",
            fetcher: vi.fn().mockResolvedValue(response(bytes)),
        });
        expect(uploadMediaPart.mock.calls.map((call) => ({
            partNumber: call[1].partNumber, size: call[1].size,
        }))).toEqual([{ partNumber: 1, size: 5 * 1024 * 1024 }, { partNumber: 2, size: 1 }]);
    });

    it("aborts the durable session when streamed bytes violate the declaration", async () => {
        const short = response(png, { "Content-Length": "9" });
        await expect(importMediaFromUrl({
            db, bucket, sourceUrl: "https://cdn.example.test/short.png", fetcher: vi.fn().mockResolvedValue(short),
        })).rejects.toThrow("ended before Content-Length");
        expect(abortMediaUpload).toHaveBeenCalledWith(db, "mup_remote", bucket);
        expect(completeMediaUpload).not.toHaveBeenCalled();
    });

    it("aborts when a storage part fails and preserves the authoritative error", async () => {
        uploadMediaPart.mockRejectedValueOnce(new Error("storage failed"));
        await expect(importMediaFromUrl({
            db, bucket, sourceUrl: "https://cdn.example.test/image.png", fetcher: vi.fn().mockResolvedValue(response(png)),
        })).rejects.toThrow("storage failed");
        expect(abortMediaUpload).toHaveBeenCalledWith(db, "mup_remote", bucket);
    });
});
