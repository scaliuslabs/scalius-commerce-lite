import { describe, expect, it, vi } from "vitest";
import {
  deleteMediaVariants,
  extractKeyFromUrl,
  getCurrentMediaUrl,
  uploadFile,
  validateMediaObjectKey,
  withPublicMediaUrl,
} from "../../../../packages/core/src/integrations/storage";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
  0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function createBucket() {
  return {
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as R2Bucket;
}

describe("R2 storage URL handling", () => {
  it("stores a bare key when no public URL is configured", async () => {
    const bucket = createBucket();
    const file = new File([PNG_BYTES], "product.png", {
      type: "image/png",
    });

    const result = await uploadFile(file, bucket, "");

    expect(result.key).toMatch(/^media\//);
    expect(result.key).toMatch(/\.png$/);
    expect(result.url).toBe(result.key);
    expect(result.url.startsWith("/")).toBe(false);
  });

  it("stores a local media route URL without double slashes", async () => {
    const bucket = createBucket();
    const file = new File([PNG_BYTES], "product.png", {
      type: "image/png",
    });

    const result = await uploadFile(
      file,
      bucket,
      "http://localhost:8787/api/v1/media/",
    );

    expect(result.url).toBe(`http://localhost:8787/api/v1/media/${result.key}`);
  });

  it("extracts R2 keys from public, local, root-relative, and bare URLs", () => {
    expect(
      extractKeyFromUrl("https://cloud.scalius.com/folder/product.webp"),
    ).toBe("folder/product.webp");
    expect(
      extractKeyFromUrl(
        "http://localhost:8787/api/v1/media/folder/product.webp",
      ),
    ).toBe("folder/product.webp");
    expect(extractKeyFromUrl("/folder/product.webp")).toBe(
      "folder/product.webp",
    );
    expect(extractKeyFromUrl("folder/product.webp")).toBe(
      "folder/product.webp",
    );
  });

  it("publishes the largest rendition and accepts only well-formed rendition keys", () => {
    expect(withPublicMediaUrl("https://media.example.com", () =>
      getCurrentMediaUrl("media/media_abc12345.jpg", 1600),
    )).toBe("https://media.example.com/media/media_abc12345.jpg/1600.webp");
    expect(withPublicMediaUrl("https://media.example.com", () =>
      getCurrentMediaUrl("media/media_abc12345.jpg", null),
    )).toBe("https://media.example.com/media/media_abc12345.jpg");

    expect(validateMediaObjectKey("media/media_abc12345.jpg/640.webp")).toBe(
      "media/media_abc12345.jpg/640.webp",
    );
    expect(validateMediaObjectKey("media/folder/1600.webp")).toBe("media/folder/1600.webp");
    for (const key of [
      "media/media_abc12345.jpg/9999.webp",
      "media/media_abc12345.jpg/640.png",
      "media/../x.jpg/640.webp",
    ]) {
      expect(() => validateMediaObjectKey(key)).toThrow();
    }
    expect(() => validateMediaObjectKey("media/media_abc12345.jpg/640.webp", "image/jpeg")).toThrow();
  });

  it("deletes exactly the recorded renditions", async () => {
    const bucket = createBucket();
    await deleteMediaVariants("media/media_abc12345.png", null, bucket);
    expect(bucket.delete).not.toHaveBeenCalled();

    await deleteMediaVariants("media/media_abc12345.png", 500, bucket);
    expect(bucket.delete).toHaveBeenCalledWith([
      "media/media_abc12345.png/144.webp",
      "media/media_abc12345.png/172.webp",
      "media/media_abc12345.png/206.webp",
      "media/media_abc12345.png/247.webp",
      "media/media_abc12345.png/296.webp",
      "media/media_abc12345.png/355.webp",
      "media/media_abc12345.png/426.webp",
      "media/media_abc12345.png/500.webp",
    ]);
  });
});
