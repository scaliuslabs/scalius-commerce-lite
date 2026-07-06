import { describe, expect, it } from "vitest";

import { setPageCspHeader } from "./csp-handler";

describe("core setPageCspHeader", () => {
  it("includes the TikTok Pixel browser host in essential CSP domains", async () => {
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    });
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toContain("https://analytics.tiktok.com");
    expect(csp).toContain("https://*.analytics.tiktok.com");
  });
});
