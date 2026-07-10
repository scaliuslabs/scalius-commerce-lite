import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AmbiguousStorageWriteError,
  uploadFile,
} from "./storage";

const FILE_BYTES = new Uint8Array([1, 2, 3, 4]);
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
