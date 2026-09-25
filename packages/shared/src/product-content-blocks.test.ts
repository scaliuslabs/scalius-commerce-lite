import { describe, expect, it } from "vitest";

import {
  PRODUCT_CONTENT_BLOCK_TYPES,
  isProductContentBlockPlacementAllowed,
  parseProductContentBlock,
  parseStoredProductContentBlock,
  productContentBlockDefault,
} from "./product-content-blocks";

describe("product content blocks", () => {
  it("has a valid starting point for every block that needs no media pick", () => {
    const needsMedia = new Set(["video", "gallery-strip"]);
    for (const type of PRODUCT_CONTENT_BLOCK_TYPES) {
      const result = parseProductContentBlock(productContentBlockDefault(type));
      expect(result.success, type).toBe(!needsMedia.has(type));
    }
  });

  it("rejects unknown types, unknown settings and wrong versions", () => {
    expect(parseProductContentBlock({ type: "marquee", version: 1, settings: {} })).toEqual({
      success: false,
      error: "Unknown content block type.",
    });
    expect(parseProductContentBlock({ type: "guarantee", version: 1, settings: { heading: "", text: "x", extra: 1 } }).success).toBe(false);
    expect(parseProductContentBlock({ type: "guarantee", version: 2, settings: { heading: "", text: "x" } }).success).toBe(false);
  });

  it("keeps landing blocks honest", () => {
    const cta = (endsAt: string | null) => parseProductContentBlock({
      type: "cta-band",
      version: 1,
      settings: { heading: "Order today", text: "", label: "Order now", target: { kind: "order-form" }, endsAt },
    });
    expect(cta(null).success).toBe(true);
    expect(cta("2026-10-01T18:00:00Z").success).toBe(true);
    expect(cta("soon").success).toBe(false);
    expect(parseProductContentBlock({
      type: "video", version: 1, settings: { heading: "", source: { kind: "embed", url: "https://evil.example/v.mp4", posterMediaId: null } },
    }).success).toBe(false);
    expect(parseProductContentBlock({
      type: "video", version: 1, settings: { heading: "", source: { kind: "embed", url: "https://youtu.be/dQw4w9WgXcQ", posterMediaId: null } },
    }).success).toBe(true);
    expect(parseProductContentBlock({
      type: "comparison", version: 1,
      settings: { heading: "", columns: [{ label: "A" }, { label: "B" }], rows: [{ label: "Oil", values: ["Cold pressed"] }] },
    }).success).toBe(false);
    expect(parseProductContentBlock({ type: "statement", version: 1, settings: { text: "Pure mustard oil", accent: "olive" } }).success)
      .toBe(false);
  });

  it("reads rows mirrored from product_rich_content", () => {
    expect(parseStoredProductContentBlock({ type: "rich-text", version: 1, settings: '{"title":"Care","html":"<p>Cold</p>"}' }))
      .toEqual({ type: "rich-text", version: 1, settings: { title: "Care", html: "<p>Cold</p>" } });
    expect(parseStoredProductContentBlock({ type: "rich-text", version: 1, settings: "{" })).toBeNull();
    expect(isProductContentBlockPlacementAllowed("rich-text", "tabs")).toBe(true);
    expect(isProductContentBlockPlacementAllowed("order-form", "tabs")).toBe(false);
  });
});
