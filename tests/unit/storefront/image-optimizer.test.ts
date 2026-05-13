import { describe, expect, it } from "vitest";
import {
  getOptimizedImageUrl,
  getResponsiveSrcSet,
} from "../../../packages/shared/src/image-optimizer";
import { resolveMediaUrl } from "../../../packages/shared/src/media-url";

const cdnBase = "https://cloud.scalius.com";

describe("storefront image optimization URLs", () => {
  it("routes absolute CDN images through Cloudflare Image Resizing", () => {
    const optimized = getOptimizedImageUrl(
      "https://cloud.scalius.com/pages/combo-offer.webp",
      { width: 1280, height: 640, quality: 85, format: "auto", fit: "cover" },
      { cdnBase, cdnHosts: ["cloud.scalius.com"], isDev: false },
    );

    expect(optimized).toBe(
      "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=1280,height=640,quality=85,format=auto,fit=cover,sharpen=1/pages/combo-offer.webp",
    );
  });

  it("resolves bare R2 keys to the CDN before optimizing", () => {
    const optimized = getOptimizedImageUrl(
      "pages/combo-offer.webp",
      { width: 1280, height: 640, quality: 85, format: "auto", fit: "cover" },
      { cdnBase, cdnHosts: ["cloud.scalius.com"], isDev: false },
    );

    expect(optimized).toContain("https://cloud.scalius.com/cdn-cgi/image/");
    expect(optimized).toContain("/pages/combo-offer.webp");
  });

  it("lets callers intentionally omit default dimensions", () => {
    const optimized = getOptimizedImageUrl(
      "https://cloud.scalius.com/pages/freeform.webp",
      { width: 1280, height: null, quality: 85, format: "auto" },
      { cdnBase, cdnHosts: ["cloud.scalius.com"], isDev: false },
    );

    expect(optimized).toContain("width=1280");
    expect(optimized).not.toContain("height=");
  });

  it("keeps an already optimized image unchanged when no new transform is requested", () => {
    const optimized =
      "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=400/image.webp";

    expect(
      getOptimizedImageUrl(optimized, undefined, {
        cdnBase,
        cdnHosts: ["cloud.scalius.com"],
        isDev: false,
      }),
    ).toBe(optimized);
  });

  it("rebuilds an already optimized image when callers request a different transform", () => {
    const stale =
      "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=400,height=400,quality=80,format=auto,fit=contain,sharpen=1/products/fish.webp?version=1";

    const optimized = getOptimizedImageUrl(
      stale,
      { width: 96, height: 96, quality: 75, format: "auto", fit: "cover" },
      {
        cdnBase,
        cdnHosts: ["cloud.scalius.com"],
        isDev: false,
      },
    );

    expect(optimized.match(/\/cdn-cgi\/image\//g)).toHaveLength(1);
    expect(optimized).toContain("width=96");
    expect(optimized).toContain("height=96");
    expect(optimized).toContain("quality=75");
    expect(optimized).not.toContain("width=400");
    expect(optimized).toContain("/products/fish.webp?version=1");
  });

  it("unwraps stale optimized URLs when image optimization is disabled", () => {
    const stale =
      "https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=400,height=400/products/fish.webp";

    expect(
      getOptimizedImageUrl(
        stale,
        { width: 96, height: 96 },
        {
          enabled: false,
          cdnBase,
          cdnHosts: ["cloud.scalius.com"],
          isDev: false,
        },
      ),
    ).toBe("https://cloud.scalius.com/products/fish.webp");
  });

  it("still optimizes remote CDN images in development", () => {
    expect(
      getOptimizedImageUrl("pages/combo-offer.webp", undefined, {
        cdnBase,
        cdnHosts: ["cloud.scalius.com"],
        isDev: true,
      }),
    ).toContain("https://cloud.scalius.com/cdn-cgi/image/");
  });

  it("does not rewrite local HTTP media URLs in development", () => {
    expect(
      getOptimizedImageUrl(
        "http://localhost:8787/api/v1/media/local.webp",
        undefined,
        {
          cdnBase,
          cdnHosts: ["cloud.scalius.com"],
          isDev: true,
        },
      ),
    ).toBe("http://localhost:8787/api/v1/media/local.webp");
  });

  it("does not rewrite absolute URLs from hosts outside the CDN allow-list", () => {
    expect(
      getOptimizedImageUrl(
        "https://example.com/image.webp?signature=abc",
        undefined,
        {
          cdnBase,
          cdnHosts: ["cloud.scalius.com"],
          isDev: false,
        },
      ),
    ).toBe("https://example.com/image.webp?signature=abc");
  });

  it("rewrites additional CDN hosts only when they are explicitly allow-listed", () => {
    const optimized = getOptimizedImageUrl(
      "https://media.example-cdn.com/products/image.webp?version=1",
      { width: 400, height: 400 },
      {
        cdnBase,
        cdnHosts: ["cloud.scalius.com", "media.example-cdn.com"],
        isDev: false,
      },
    );

    expect(optimized).toContain("https://media.example-cdn.com/cdn-cgi/image/");
    expect(optimized).toContain("/products/image.webp?version=1");
  });

  it("canonicalizes configured host aliases onto the canonical CDN host", () => {
    const optimized = getOptimizedImageUrl(
      "https://old-cdn.example.com/products/image.webp?version=1",
      { width: 400, height: 400 },
      {
        cdnBase,
        cdnHosts: ["cloud.scalius.com"],
        cdnHostAliases: ["old-cdn.example.com"],
        isDev: false,
      },
    );

    expect(optimized).toContain("https://cloud.scalius.com/cdn-cgi/image/");
    expect(optimized).toContain("/products/image.webp?version=1");
  });

  it("canonicalizes configured host aliases even when optimization is disabled", () => {
    const raw = getOptimizedImageUrl(
      "https://old-cdn.example.com/products/image.webp?version=1",
      { width: 400, height: 400 },
      {
        enabled: false,
        cdnBase,
        cdnHosts: ["cloud.scalius.com"],
        cdnHostAliases: ["old-cdn.example.com"],
        isDev: false,
      },
    );

    expect(raw).toBe(
      "https://cloud.scalius.com/products/image.webp?version=1",
    );
  });

  it("uses the media resolver to canonicalize configured CDN aliases", () => {
    expect(
      resolveMediaUrl(
        "https://old-cdn.example.com/products/image.webp?version=1#view",
        cdnBase,
        { cdnHostAliases: ["old-cdn.example.com"] },
      ),
    ).toBe("https://cloud.scalius.com/products/image.webp?version=1#view");
  });

  it("honors the dashboard image optimization toggle", () => {
    const raw = getOptimizedImageUrl(
      "products/image.webp",
      { width: 400, height: 400 },
      {
        enabled: false,
        cdnBase,
        cdnHosts: ["cloud.scalius.com"],
        cdnHostAliases: ["old-cdn.example.com"],
        isDev: false,
      },
    );

    expect(raw).toBe("https://cloud.scalius.com/products/image.webp");
  });

  it("does not route vector assets through Cloudflare Image Resizing", () => {
    expect(
      getOptimizedImageUrl(
        "https://cloud.scalius.com/logos/brand.svg?version=1",
        { width: 240, height: 80, fit: "contain" },
        { cdnBase, cdnHosts: ["cloud.scalius.com"], isDev: false },
      ),
    ).toBe("https://cloud.scalius.com/logos/brand.svg?version=1");

    expect(
      getOptimizedImageUrl(
        "legacy/logo.svg",
        { width: 240, height: 80, fit: "contain" },
        { cdnBase, cdnHosts: ["cloud.scalius.com"], isDev: false },
      ),
    ).toBe("https://cloud.scalius.com/legacy/logo.svg");
  });

  it("does not build responsive srcsets for vector assets", () => {
    expect(
      getResponsiveSrcSet(
        "https://cloud.scalius.com/logos/brand.svg",
        [320, 640],
        { fit: "contain" },
        { cdnBase, cdnHosts: ["cloud.scalius.com"], isDev: false },
      ),
    ).toBe("");
  });
});
