import { describe, expect, it } from "vitest";

import { partytownConfig } from "./partytown-config";

describe("partytownConfig", () => {
  it("proxies TikTok Pixel scripts and forwards ttq methods", () => {
    const originalUrl = new URL(
      "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=PIXEL_ID&lib=ttq",
    );
    const resolved = partytownConfig.resolveUrl(
      originalUrl,
      { origin: "https://store.example.com" } as Location,
      "script",
    );

    expect(resolved.origin).toBe("https://store.example.com");
    expect(resolved.pathname).toBe("/api/ptproxy");
    expect(resolved.searchParams.get("url")).toBe(originalUrl.href);
    expect(partytownConfig.forward).toEqual(
      expect.arrayContaining(["ttq.load", "ttq.page", "ttq.track"]),
    );
  });
});
