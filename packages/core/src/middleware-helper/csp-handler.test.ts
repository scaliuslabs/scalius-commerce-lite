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

  it("keeps merchant hosts exact unless the merchant saved a wildcard", async () => {
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
      CACHE: {
        get: async () => "https://payments.merchant.test,https://*.widgets.merchant.test",
      },
    });
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("https://payments.merchant.test");
    expect(csp).not.toContain("https://*.payments.merchant.test");
    expect(csp).toContain("https://*.widgets.merchant.test");
  });

  it("keeps inherited platform origins exact", async () => {
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.store.test",
      STOREFRONT_URL: "https://shop.store.test",
      CDN_DOMAIN_URL: "media.store.test",
    });
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("https://api.store.test");
    expect(csp).toContain("https://shop.store.test");
    expect(csp).toContain("https://media.store.test");
    expect(csp).not.toContain("https://*.api.store.test");
    expect(csp).not.toContain("https://*.shop.store.test");
    expect(csp).not.toContain("https://*.media.store.test");
  });
});
