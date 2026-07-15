import { describe, expect, it } from "vitest";

import {
  getOptimizedImageUrl,
  type ImageContext,
} from "./image-optimizer";

const imageContext: ImageContext = {
  enabled: true,
  cdnBase: "https://cdn.example.com",
  cdnHosts: ["cdn.example.com"],
  isDev: false,
};

describe("getOptimizedImageUrl", () => {
  it("preserves the complete asset by default", () => {
    const url = getOptimizedImageUrl(
      "https://cdn.example.com/products/wide-product.jpg",
      undefined,
      imageContext,
    );

    expect(url).toContain("width=600,height=600");
    expect(url).toContain("fit=scale-down");
    expect(url).not.toContain("fit=cover");
  });

  it("keeps cropping an explicit presentation decision", () => {
    const url = getOptimizedImageUrl(
      "https://cdn.example.com/heroes/summer.jpg",
      { width: 1920, height: 600, fit: "cover" },
      imageContext,
    );

    expect(url).toContain("width=1920,height=600");
    expect(url).toContain("fit=cover");
  });

  it("does not rewrite an existing transform without a new presentation request", () => {
    const existing =
      "https://cdn.example.com/cdn-cgi/image/width=320,fit=contain/products/item.jpg";

    expect(getOptimizedImageUrl(existing, undefined, imageContext)).toBe(existing);
  });
});
