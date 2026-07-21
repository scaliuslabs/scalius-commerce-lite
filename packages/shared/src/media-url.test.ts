import { describe, expect, it } from "vitest";

import { normalizePublicMediaUrl, resolveMediaUrl } from "./media-url";

describe("normalizePublicMediaUrl", () => {
  it("accepts HTTPS media and safe root-relative application assets", () => {
    expect(normalizePublicMediaUrl(" https://cdn.example.com/logo.png?width=320 "))
      .toBe("https://cdn.example.com/logo.png?width=320");
    expect(normalizePublicMediaUrl("/assets/invoice-logo.svg")).toBe(
      "/assets/invoice-logo.svg",
    );
  });

  it("keeps HTTP local and rejects unsafe public sources", () => {
    expect(normalizePublicMediaUrl("http://localhost:8787/logo.png")).toBe(
      "http://localhost:8787/logo.png",
    );
    expect(normalizePublicMediaUrl("http://cdn.example.com/logo.png")).toBeNull();
    expect(normalizePublicMediaUrl("//cdn.example.com/logo.png")).toBeNull();
    expect(normalizePublicMediaUrl("https://user:pass@cdn.example.com/logo.png"))
      .toBeNull();
    expect(normalizePublicMediaUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("resolveMediaUrl", () => {
  const cdnBase = "https://cdn.scalius.test";

  it("resolves safe bare R2 object keys through the CDN base", () => {
    expect(resolveMediaUrl("products/sku-1/main.webp", cdnBase)).toBe(
      "https://cdn.scalius.test/products/sku-1/main.webp",
    );
  });

  it("preserves http and https URLs, including canonical CDN aliases", () => {
    expect(
      resolveMediaUrl("https://images.example.com/main.webp", cdnBase),
    ).toBe("https://images.example.com/main.webp");
    expect(resolveMediaUrl("http://images.example.com/main.webp", cdnBase)).toBe(
      "http://images.example.com/main.webp",
    );
    expect(
      resolveMediaUrl(
        "https://old-cdn.example.com/products/main.webp?size=large#photo",
        cdnBase,
        { cdnHostAliases: ["old-cdn.example.com"] },
      ),
    ).toBe("https://cdn.scalius.test/products/main.webp?size=large#photo");
  });

  it("preserves local absolute paths and Cloudflare image paths", () => {
    expect(resolveMediaUrl("/img/no-image.webp", cdnBase)).toBe(
      "/img/no-image.webp",
    );
    expect(
      resolveMediaUrl("/cdn-cgi/image/width=640/products/main.webp", cdnBase),
    ).toBe("/cdn-cgi/image/width=640/products/main.webp");
  });

  it("rejects unsafe non-http schemes instead of resolving them as keys", () => {
    expect(resolveMediaUrl("data:image/svg+xml,<svg></svg>", cdnBase)).toBe("");
    expect(resolveMediaUrl("javascript:alert(1)", cdnBase)).toBe("");
    expect(resolveMediaUrl("ftp://example.com/main.webp", cdnBase)).toBe("");
    expect(resolveMediaUrl("mailto:photo@example.com", cdnBase)).toBe("");
  });

  it("rejects bare object keys with unsafe source characters", () => {
    expect(resolveMediaUrl("products:main.webp", cdnBase)).toBe("");
    expect(resolveMediaUrl("products\\main.webp", cdnBase)).toBe("");
    expect(resolveMediaUrl("products/\u0000main.webp", cdnBase)).toBe("");
  });
});
