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
});
