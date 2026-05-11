import { describe, expect, it } from "vitest";
import { getOptimizedImageUrl } from "../../../packages/shared/src/image-optimizer";

describe("rich content image optimization behavior", () => {
  it("canonicalizes configured alias URLs through the shared optimizer", () => {
    const optimized = getOptimizedImageUrl(
      "https://old-cdn.example.com/cms/banner.jpg",
      { width: 600, quality: 85, format: "auto", fit: "scale-down" },
      {
        cdnBase: "https://cdn.example.com",
        cdnHosts: ["cdn.example.com"],
        cdnHostAliases: ["old-cdn.example.com"],
        isDev: false,
      },
    );

    expect(optimized).toBe(
      "https://cdn.example.com/cdn-cgi/image/onerror=redirect,width=600,height=600,quality=85,format=auto,fit=scale-down,sharpen=1/cms/banner.jpg",
    );
  });
});
