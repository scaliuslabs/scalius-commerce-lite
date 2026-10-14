// @vitest-environment node

import { describe, expect, it } from "vitest";

import { requestRuntime } from "./api/runtime";
import {
  getCdnBase,
  getSameOriginMediaSource,
  mediaImageSrcSet,
  mediaImageUrl,
  resolveMediaUrl,
} from "./media-url";

describe("getCdnBase", () => {
  it("prefers the dashboard canonical CDN over the platform media host", () => {
    expect(requestRuntime.run({
      IMAGE_CDN_BASE_URL: "https://images.example.test/",
      CDN_DOMAIN_URL: "cdn.example.test",
    }, () => getCdnBase())).toBe("https://images.example.test");
  });

  it("serves production media hosts over HTTPS", () => {
    expect(requestRuntime.run({ CDN_DOMAIN_URL: "cdn.example.test" }, () => getCdnBase()))
      .toBe("https://cdn.example.test");
  });

  it("keeps plain HTTP only for loopback media hosts used by local development", () => {
    expect(requestRuntime.run({ CDN_DOMAIN_URL: "localhost:8787" }, () => getCdnBase()))
      .toBe("http://localhost:8787");
    expect(requestRuntime.run({ CDN_DOMAIN_URL: "http://127.0.0.1:8787/api/v1/media" }, () => getCdnBase()))
      .toBe("http://127.0.0.1:8787/api/v1/media");
    expect(requestRuntime.run({ CDN_DOMAIN_URL: "localhost.example.test" }, () => getCdnBase()))
      .toBe("https://localhost.example.test");
  });

  it("returns an empty base when nothing is configured", () => {
    expect(requestRuntime.run({}, () => getCdnBase())).toBe("");
  });
});

describe("media on the store's own origin", () => {
  const runtime = {
    MEDIA_URL: "https://cloud.example.test",
    CDN_DOMAIN_URL: "cloud.example.test",
    STOREFRONT_URL: "https://shop.example.test",
  };

  it("serves a media-address file from the store origin, absolute, keeping query and fragment", () => {
    requestRuntime.run(runtime, () => {
      expect(getSameOriginMediaSource()).toBe("https://cloud.example.test");
      expect(resolveMediaUrl("https://cloud.example.test/media/m_abc.jpg/1600.webp?v=2#x"))
        .toBe("https://shop.example.test/media/m_abc.jpg/1600.webp?v=2#x");
      expect(resolveMediaUrl("media/m_abc.jpg")).toBe("https://shop.example.test/media/m_abc.jpg");
    });
  });

  it("derives renditions from the store-origin URL", () => {
    requestRuntime.run(runtime, () => {
      const url = "https://cloud.example.test/media/m_abc.jpg/1600.webp";
      expect(mediaImageUrl(url, 300)).toBe("https://shop.example.test/media/m_abc.jpg/355.webp");
      expect(mediaImageSrcSet(url)).toContain("https://shop.example.test/media/m_abc.jpg/144.webp 144w");
      expect(mediaImageSrcSet(url)).not.toContain("cloud.example.test");
    });
  });

  it("leaves other hosts, other paths and local assets alone", () => {
    requestRuntime.run(runtime, () => {
      expect(resolveMediaUrl("https://elsewhere.example.test/media/a.jpg")).toBe("https://elsewhere.example.test/media/a.jpg");
      expect(resolveMediaUrl("https://cloud.example.test/other/a.jpg")).toBe("https://cloud.example.test/other/a.jpg");
      expect(resolveMediaUrl("/img/no-image.webp")).toBe("/img/no-image.webp");
      expect(resolveMediaUrl("https://shop.example.test/media/a.jpg")).toBe("https://shop.example.test/media/a.jpg");
    });
  });

  it("keeps a merchant-chosen canonical CDN", () => {
    requestRuntime.run({ ...runtime, IMAGE_CDN_BASE_URL: "https://images.example.test" }, () => {
      expect(getSameOriginMediaSource()).toBe("");
      expect(resolveMediaUrl("https://cloud.example.test/media/a.jpg")).toBe("https://cloud.example.test/media/a.jpg");
    });
  });

  it("does nothing without a store origin or media address, or when they share an origin", () => {
    requestRuntime.run({ MEDIA_URL: "https://cloud.example.test" }, () => {
      expect(getSameOriginMediaSource()).toBe("");
    });
    requestRuntime.run({ STOREFRONT_URL: "https://shop.example.test" }, () => {
      expect(getSameOriginMediaSource()).toBe("");
    });
    requestRuntime.run({ MEDIA_URL: "https://shop.example.test/files", STOREFRONT_URL: "https://shop.example.test" }, () => {
      expect(getSameOriginMediaSource()).toBe("");
    });
  });

  it("re-roots a local development media address below a path", () => {
    requestRuntime.run({ MEDIA_URL: "http://localhost:8787/api/v1/media", STOREFRONT_URL: "http://localhost:4321" }, () => {
      expect(resolveMediaUrl("http://localhost:8787/api/v1/media/media/m_abc.jpg/960.webp"))
        .toBe("http://localhost:4321/media/m_abc.jpg/960.webp");
    });
  });
});
