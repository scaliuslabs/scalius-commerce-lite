import { describe, expect, it, vi } from "vitest";
import {
  extractKeyFromUrl,
  uploadFile,
} from "../../../../packages/core/src/integrations/storage";

function createBucket() {
  return {
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as R2Bucket;
}

describe("R2 storage URL handling", () => {
  it("stores a bare key when no public URL is configured", async () => {
    const bucket = createBucket();
    const file = new File(["image-bytes"], "product.webp", {
      type: "image/webp",
    });

    const result = await uploadFile(file, bucket, "");

    expect(result.key).toMatch(/\.webp$/);
    expect(result.url).toBe(result.key);
    expect(result.url.startsWith("/")).toBe(false);
  });

  it("stores a local media route URL without double slashes", async () => {
    const bucket = createBucket();
    const file = new File(["image-bytes"], "product.webp", {
      type: "image/webp",
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
