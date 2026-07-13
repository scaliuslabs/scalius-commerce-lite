import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../edge-cache", () => ({
  CACHE_TTL: { SHORT: 300 },
  withEdgeCache: async (_key: string, loader: () => Promise<unknown>) =>
    loader(),
}));

import { setPageCspHeader } from "./csp-handler";

describe("setPageCspHeader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unwraps enveloped storefront CSP settings responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { cspAllowedDomains: "payments.example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/storefront/csp",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "https://payments.example.com",
    );
    expect(response.headers.get("Content-Security-Policy")).not.toContain(
      "https://*.payments.example.com",
    );
  });

  it("inherits canonical API and media origins without broadening to wildcard subdomains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    );
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
      CDN_DOMAIN_URL: "cdn.example.com",
      R2_PUBLIC_URL: "https://media.example.com",
      STOREFRONT_URL: "https://shop.example.com",
    });
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("https://api.example.com");
    expect(csp).toContain("https://cdn.example.com");
    expect(csp).toContain("https://media.example.com");
    expect(csp).toContain("https://shop.example.com");
    expect(csp).not.toContain("https://*.api.example.com");
    expect(csp).not.toContain("https://*.cdn.example.com");
  });

  it("fails closed for malformed configured platform and merchant sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    );
    const response = await setPageCspHeader(new Response("ok"), {
      CSP_ALLOWED: "javascript:alert(1),https://safe.example.com/path",
      PUBLIC_API_BASE_URL: "https://api.example.com/path",
      CDN_DOMAIN_URL: "https://user:pass@cdn.example.com",
    });
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).not.toContain("javascript:");
    expect(csp).not.toContain("safe.example.com");
    expect(csp).not.toContain("api.example.com/path");
    expect(csp).not.toContain("cdn.example.com");
  });

  it("allows the TikTok Pixel browser host", async () => {
    const response = await setPageCspHeader(new Response("ok"), {});
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toContain("https://analytics.tiktok.com");
  });

  it("allows the Facebook Pixel script host for main-thread snippets", async () => {
    const response = await setPageCspHeader(new Response("ok"), {});
    const csp = response.headers.get("Content-Security-Policy");
    const scriptSrc = csp
      ?.split("; ")
      .find((directive) => directive.startsWith("script-src "));

    expect(scriptSrc).toContain("https://connect.facebook.net");
    expect(scriptSrc).toContain("https://www.facebook.com");
  });
});
