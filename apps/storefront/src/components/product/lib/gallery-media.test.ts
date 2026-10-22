import { describe, expect, it } from "vitest";
import type { ProductMedia } from "@/lib/api";
import { featuredGalleryItem, formatVideoDuration, mediaAspectRatio, productGalleryItems } from "./gallery-media";

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

  it("names a SKU photo without its own words by the choice it shows", () => {
    const option = (definition: string, value: string) => ({
      optionDefinitionId: definition, optionValueId: `${definition}:${value}`, name: definition, value,
      position: 0, valuePosition: 0, standardMapping: null,
    }) as never;
    const items = productGalleryItems({ name: "Echo Mini", imageAlt: null }, [item("a", "image", 0), item("b", "image", 1)], [
      { imageId: "a", selectedOptions: [option("colour", "Black"), option("size", "S")] },
      { imageId: "a", selectedOptions: [option("colour", "Black"), option("size", "M")] },
    ]);
    expect(items.map((entry) => entry.altText)).toEqual(["Echo Mini, Black", "Echo Mini"]);
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

  it("carries each item's stored ratio, null when a side is unknown", () => {
    const items = productGalleryItems({ name: "Mug", imageAlt: null }, [
      item("a", "image", 0, { width: 1200, height: 1200 }),
      item("b", "image", 1, { width: 1200, height: 1600 }),
      item("c", "image", 2, { width: null, height: 900 }),
    ]);
    expect(items.map((entry) => entry.aspectRatio)).toEqual([1, 0.75, null]);
    expect(mediaAspectRatio({ width: 0, height: 10 })).toBeNull();
  });
});
