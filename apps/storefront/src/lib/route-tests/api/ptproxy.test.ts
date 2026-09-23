import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../pages/api/ptproxy";
import { partytownConfig } from "../../partytown-config";

function proxy(target: string) {
  return GET({
    request: new Request(
      `https://store.example.com/api/ptproxy?url=${encodeURIComponent(target)}`,
    ),
  } as Parameters<typeof GET>[0]);
}

describe("/api/ptproxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows TikTok Pixel script requests through the Partytown proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("console.log('tiktok pixel')", {
        headers: { "Content-Type": "application/javascript" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const target =
      "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=PIXEL_ID&lib=ttq";
    const response = await GET({
      request: new Request(
        `https://store.example.com/api/ptproxy?url=${encodeURIComponent(target)}`,
      ),
    } as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/javascript");
    expect(fetchMock).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        headers: { "User-Agent": "" },
      }),
    );
  });

  it("rejects allowed analytics hosts when the URL uses http", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const target =
      "http://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C1234567890ABCDEFG&lib=ttq";
    const response = await GET({
      request: new Request(
        `https://store.example.com/api/ptproxy?url=${encodeURIComponent(target)}`,
      ),
    } as Parameters<typeof GET>[0]);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Protocol not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects allowed analytics hosts when the URL uses ftp", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const target =
      "ftp://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C1234567890ABCDEFG&lib=ttq";
    const response = await GET({
      request: new Request(
        `https://store.example.com/api/ptproxy?url=${encodeURIComponent(target)}`,
      ),
    } as Parameters<typeof GET>[0]);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Protocol not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts every script host the Partytown resolver sends to the proxy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));

    for (const target of [
      "https://connect.facebook.net/en_US/fbevents.js",
      "https://analytics.tiktok.com/i18n/pixel/events.js",
      "https://www.googletagmanager.com/gtag/js?id=G-TEST",
      "https://www.google-analytics.com/analytics.js",
    ]) {
      const resolved = partytownConfig.resolveUrl(
        new URL(target),
        { origin: "https://store.example.com" } as Location,
        "script",
      );
      expect(resolved.pathname).toBe("/api/ptproxy");
      expect((await proxy(target)).status).toBe(200);
    }
  });

  it.each([
    "https://cdn.jsdelivr.net/gh/attacker/repo/payload.js",
    "https://static.cloudflareinsights.com/beacon.min.js",
    "https://www.googleadservices.com/pagead/conversion.js",
    "https://www.facebook.com/tr?id=1",
    "https://evil.example.com/connect.facebook.net.js",
  ])("refuses to serve %s from the merchant origin", async (target) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxy(target);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Host not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
