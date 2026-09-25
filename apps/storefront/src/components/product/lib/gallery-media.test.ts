import { describe, expect, it } from "vitest";
import type { ProductMedia } from "@/lib/api";
import { featuredGalleryItem, formatVideoDuration, productGalleryItems } from "./gallery-media";

const item = (id: string, kind: "image" | "video", sortOrder: number, extra: Partial<ProductMedia> = {}) =>
  ({
    id, mediaId: `m_${id}`, kind, url: `https://cdn.test/${id}`, posterUrl: null, altText: null,
    durationMs: null, isPrimary: false, sortOrder, ...extra,
  }) as ProductMedia;

describe("gallery media", () => {
  it("orders media, keeps a video's poster and features the primary item", () => {
    const items = productGalleryItems({ name: "Mug", imageAlt: null }, [
      item("b", "image", 2),
      item("v", "video", 1, { posterUrl: "https://cdn.test/poster", durationMs: 32_000, isPrimary: true }),
      item("a", "image", 0),
    ]);
    expect(items.map((entry) => entry.id)).toEqual(["a", "v", "b"]);
    expect(items[1]).toMatchObject({ kind: "video", duration: "0:32", altText: "Mug" });
    expect(items[1]!.posterUrl).toContain("poster");
    expect(featuredGalleryItem(items, null)?.id).toBe("v");
  });

  it("features a ?variant= SKU photo over the primary, never a video", () => {
    const items = productGalleryItems({ name: "Mug", imageAlt: null }, [
      item("v", "video", 0, { isPrimary: true }),
      item("a", "image", 1),
    ]);
    expect(featuredGalleryItem(items, "a")?.id).toBe("a");
    expect(featuredGalleryItem(items, "v")?.id).toBe("v");
    expect(formatVideoDuration(null)).toBeNull();
  });
});
