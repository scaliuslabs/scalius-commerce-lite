import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptimizedImageUrl: vi.fn(),
}));

vi.mock("./image-optimizer", () => ({
  getOptimizedImageUrl: mocks.getOptimizedImageUrl,
}));

import type { ProductPageData } from "./api";
import { withOptimizedProductPageImages } from "./serialized-media";

describe("product media serialization", () => {
  beforeEach(() => {
    mocks.getOptimizedImageUrl.mockReset();
    mocks.getOptimizedImageUrl.mockImplementation((url: string) =>
      url.includes("poster") ? null : `optimized:${url}`
    );
  });

  it("never sends video content through image optimization and preserves a valid poster fallback", () => {
    const page = {
      product: { imageUrl: null },
      category: null,
      variants: [],
      relatedProducts: [],
      media: [
        {
          id: "pmed_video",
          mediaId: "med_video",
          kind: "video",
          url: "https://media.example.test/demo.mp4",
          posterMediaId: "med_poster",
          posterUrl: "https://media.example.test/poster.jpg",
          altText: "Product demonstration",
          caption: null,
          width: 1920,
          height: 1080,
          durationMs: 12_000,
          isPrimary: true,
          sortOrder: 0,
          status: "ready",
        },
      ],
    } as unknown as ProductPageData;

    const serialized = withOptimizedProductPageImages(page);

    expect(serialized.media[0]).toMatchObject({
      url: "https://media.example.test/demo.mp4",
      posterUrl: "https://media.example.test/poster.jpg",
    });
    expect(mocks.getOptimizedImageUrl).toHaveBeenCalledWith(
      "https://media.example.test/poster.jpg",
      expect.any(Object),
    );
    expect(mocks.getOptimizedImageUrl).not.toHaveBeenCalledWith(
      "https://media.example.test/demo.mp4",
      expect.anything(),
    );
  });
});
