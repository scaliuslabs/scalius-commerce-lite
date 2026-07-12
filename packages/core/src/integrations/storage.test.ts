import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AmbiguousStorageWriteError,
  abortMediaMultipartUpload,
  buildMediaObjectKey,
  completeMediaMultipartUpload,
  createMediaMultipartUpload,
  getCurrentPublicMediaUrl,
  getPublicMediaUrl,
  headMediaObject,
  uploadFile,
  uploadMediaMultipartPart,
} from "./storage";

const FILE_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const SHA256 = new Uint8Array(32).fill(7);

function r2Object(overrides: Partial<R2Object> = {}): R2Object {
  return {
    key: "generated/aig_abcdefghijklmnop.png",
    version: "v1",
    size: FILE_BYTES.byteLength,
    etag: "etag",
    httpEtag: '"etag"',
    uploaded: new Date(),
    checksums: {
      sha256: SHA256.buffer,
      toJSON: () => ({}),
    },
    storageClass: "Standard",
    writeHttpMetadata: vi.fn(),
    ...overrides,
  } as R2Object;
}

describe("R2 upload reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles a timed-out deterministic put only when size and SHA-256 match", async () => {
    vi.useFakeTimers();
    const bucket = {
      put: vi.fn(() => new Promise<R2Object>(() => undefined)),
      head: vi.fn().mockResolvedValue(r2Object()),
    } as unknown as R2Bucket;
    const upload = uploadFile(
      new File([FILE_BYTES], "generated.png", { type: "image/png" }),
      bucket,
      "https://cdn.example.test",
      {
        objectKey: "generated/aig_abcdefghijklmnop.png",
        sha256: SHA256,
      },
    );

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(upload).resolves.toMatchObject({
      key: "generated/aig_abcdefghijklmnop.png",
      url: "https://cdn.example.test/generated/aig_abcdefghijklmnop.png",
    });
  });

  it("keeps an ambiguous late put distinguishable instead of accepting size alone", async () => {
    vi.useFakeTimers();
    let resolvePut: ((value: R2Object) => void) | undefined;
    const latePut = new Promise<R2Object>((resolve) => {
      resolvePut = resolve;
    });
    const bucket = {
      put: vi.fn(() => latePut),
      head: vi.fn().mockResolvedValue(
        r2Object({
          checksums: {
            sha256: new Uint8Array(32).fill(8).buffer,
            toJSON: () => ({}),
          },
        }),
      ),
      delete: vi.fn(),
    } as unknown as R2Bucket;
    const upload = uploadFile(
      new File([FILE_BYTES], "generated.png", { type: "image/png" }),
      bucket,
      undefined,
      {
        objectKey: "generated/aig_abcdefghijklmnop.png",
        sha256: SHA256,
      },
    );
    const rejection = expect(upload).rejects.toBeInstanceOf(
      AmbiguousStorageWriteError,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    resolvePut?.(r2Object());
    await latePut;
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});

describe("R2 media multipart primitives", () => {
  function fixture() {
    const multipart = {
      key: "media/med_abcdefghijklmnop.mp4",
      uploadId: "upload_abcdefghijklmnop",
      uploadPart: vi.fn().mockResolvedValue({ partNumber: 1, etag: "etag-1" }),
      complete: vi.fn().mockResolvedValue(
        r2Object({
          key: "media/med_abcdefghijklmnop.mp4",
          size: 24 * 1024 * 1024,
        }),
      ),
      abort: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2MultipartUpload;
    const bucket = {
      createMultipartUpload: vi.fn().mockResolvedValue(multipart),
      resumeMultipartUpload: vi.fn().mockReturnValue(multipart),
      head: vi.fn().mockResolvedValue(
        r2Object({ key: "media/med_abcdefghijklmnop.mp4" }),
      ),
    } as unknown as R2Bucket;
    return { bucket, multipart };
  }

  it("builds deterministic policy-bound keys and public URLs", () => {
    expect(buildMediaObjectKey("med_abcdefghijklmnop", "video/mp4")).toBe(
      "media/med_abcdefghijklmnop.mp4",
    );
    expect(
      getPublicMediaUrl(
        "https://cdn.example.test/",
        "media/med_abcdefghijklmnop.mp4",
      ),
    ).toBe("https://cdn.example.test/media/med_abcdefghijklmnop.mp4");
    expect(
      getCurrentPublicMediaUrl("media/med_abcdefghijklmnop.mp4", "/api/v1/media"),
    ).toBe("/api/v1/media/media/med_abcdefghijklmnop.mp4");
    expect(() => buildMediaObjectKey("../escape", "video/mp4")).toThrow();
  });

  it("creates a bounded video upload without buffering the object", async () => {
    const { bucket } = fixture();
    await expect(
      createMediaMultipartUpload(
        {
          objectKey: "media/med_abcdefghijklmnop.mp4",
          filename: "Cafeteria walkthrough.mp4",
          mimeType: "video/mp4",
          size: 24 * 1024 * 1024,
        },
        bucket,
        "https://cdn.example.test",
      ),
    ).resolves.toEqual({
      key: "media/med_abcdefghijklmnop.mp4",
      uploadId: "upload_abcdefghijklmnop",
      url: "https://cdn.example.test/media/med_abcdefghijklmnop.mp4",
    });
    expect(bucket.createMultipartUpload).toHaveBeenCalledWith(
      "media/med_abcdefghijklmnop.mp4",
      expect.objectContaining({
        httpMetadata: expect.objectContaining({ contentType: "video/mp4" }),
        customMetadata: expect.objectContaining({
          originalFilename: "Cafeteria walkthrough.mp4",
          mediaKind: "video",
          declaredSize: String(24 * 1024 * 1024),
        }),
      }),
    );
  });

  it("enforces uniform 5 MiB non-final parts and permits a smaller final part", async () => {
    const { bucket, multipart } = fixture();
    const finalBody = new Uint8Array([1, 2, 3]);
    await expect(
      uploadMediaMultipartPart({
        objectKey: "media/med_abcdefghijklmnop.mp4",
        uploadId: "upload_abcdefghijklmnop",
        partNumber: 2,
        size: finalBody.byteLength,
        isFinal: true,
        value: finalBody,
        bucket,
      }),
    ).resolves.toEqual({ partNumber: 1, etag: "etag-1" });
    expect(multipart.uploadPart).toHaveBeenCalledWith(2, finalBody);

    await expect(
      uploadMediaMultipartPart({
        objectKey: "media/med_abcdefghijklmnop.mp4",
        uploadId: "upload_abcdefghijklmnop",
        partNumber: 1,
        size: finalBody.byteLength,
        isFinal: false,
        value: finalBody,
        bucket,
      }),
    ).rejects.toThrow("part size");
  });

  it("sorts completion parts and exposes abort/head operations", async () => {
    const { bucket, multipart } = fixture();
    await completeMediaMultipartUpload({
      objectKey: "media/med_abcdefghijklmnop.mp4",
      uploadId: "upload_abcdefghijklmnop",
      parts: [
        { partNumber: 2, etag: "etag-2" },
        { partNumber: 1, etag: "etag-1" },
      ],
      bucket,
    });
    expect(multipart.complete).toHaveBeenCalledWith([
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
    ]);

    await abortMediaMultipartUpload({
      objectKey: "media/med_abcdefghijklmnop.mp4",
      uploadId: "upload_abcdefghijklmnop",
      bucket,
    });
    expect(multipart.abort).toHaveBeenCalledOnce();
    await expect(
      headMediaObject("media/med_abcdefghijklmnop.mp4", bucket),
    ).resolves.toMatchObject({ key: "media/med_abcdefghijklmnop.mp4" });
  });

  it("rejects duplicate completion parts and mismatched known part lengths", async () => {
    const { bucket } = fixture();
    await expect(
      completeMediaMultipartUpload({
        objectKey: "media/med_abcdefghijklmnop.mp4",
        uploadId: "upload_abcdefghijklmnop",
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 1, etag: "etag-again" },
        ],
        bucket,
      }),
    ).rejects.toThrow("completion parts");

    await expect(
      completeMediaMultipartUpload({
        objectKey: "media/med_abcdefghijklmnop.mp4",
        uploadId: "upload_abcdefghijklmnop",
        parts: [{ partNumber: 2, etag: "etag-2" }],
        bucket,
      }),
    ).rejects.toThrow("completion parts");

    await expect(
      uploadMediaMultipartPart({
        objectKey: "media/med_abcdefghijklmnop.mp4",
        uploadId: "upload_abcdefghijklmnop",
        partNumber: 1,
        size: 2,
        isFinal: true,
        value: new Uint8Array([1]),
        bucket,
      }),
    ).rejects.toThrow("length does not match");
  });
});
