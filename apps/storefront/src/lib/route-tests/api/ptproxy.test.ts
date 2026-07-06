import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../pages/api/ptproxy";

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
});
