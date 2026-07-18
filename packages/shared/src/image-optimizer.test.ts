import { describe, expect, it } from "vitest";

import {
  getOptimizedImageUrl,
  getResponsiveSrcSet,
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

  it("preserves an explicit relative focal point in a cover transform", () => {
    const url = getOptimizedImageUrl(
      "https://cdn.example.com/heroes/summer.jpg",
      { width: 1920, height: 600, fit: "cover", gravity: "0.25x0.7" },
      imageContext,
    );

    expect(url).toContain("fit=cover,gravity=0.25x0.7");
  });

  it("does not rewrite an existing transform without a new presentation request", () => {
    const existing =
      "https://cdn.example.com/cdn-cgi/image/width=320,fit=contain/products/item.jpg";

    expect(getOptimizedImageUrl(existing, undefined, imageContext)).toBe(existing);
  });

  it("does not force natural responsive images into square transforms", () => {
    const srcset = getResponsiveSrcSet(
      "https://cdn.example.com/content/wide-story.jpg",
      [320, 640],
      { height: null, fit: "scale-down" },
      imageContext,
    );

    expect(srcset).toContain("width=320");
    expect(srcset).toContain("width=640");
    expect(srcset).not.toContain("height=");
  });

  it("preserves an explicit responsive crop ratio at every width", () => {
    const srcset = getResponsiveSrcSet(
      "https://cdn.example.com/heroes/summer.jpg",
      [650, 1_300],
      { width: 1_300, height: 500, fit: "cover" },
      imageContext,
    );

    expect(srcset).toContain("width=650,height=250");
    expect(srcset).toContain("width=1300,height=500");
    expect(srcset).not.toContain("width=650,height=650");
  });
});
