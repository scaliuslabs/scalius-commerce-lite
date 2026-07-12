import { describe, expect, it, vi } from "vitest";
import {
  extractKeyFromUrl,
  uploadFile,
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

  it("extracts R2 keys from public, local, optimized, root-relative, and bare URLs", () => {
    expect(
      extractKeyFromUrl("https://cloud.scalius.com/folder/product.webp"),
    ).toBe("folder/product.webp");
    expect(
      extractKeyFromUrl(
        "http://localhost:8787/api/v1/media/folder/product.webp",
      ),
    ).toBe("folder/product.webp");
    expect(
      extractKeyFromUrl(
        "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=400/folder/product.webp",
      ),
    ).toBe("folder/product.webp");
    expect(extractKeyFromUrl("/folder/product.webp")).toBe(
      "folder/product.webp",
    );
    expect(extractKeyFromUrl("folder/product.webp")).toBe(
      "folder/product.webp",
    );
  });
});
