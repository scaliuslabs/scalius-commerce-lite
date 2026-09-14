import { afterEach, describe, expect, it, vi } from "vitest";

import { CSP_ALLOWED_DOMAINS_CACHE_KEY, setPageCspHeader } from "./csp-handler";

describe("core setPageCspHeader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes the TikTok Pixel browser host in essential CSP domains", async () => {
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
    });
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toContain("https://analytics.tiktok.com");
    expect(csp).toContain("https://*.analytics.tiktok.com");
  });

  it("reads merchant CSP sources only from the KV security key", async () => {
    const get = vi.fn(async (key: string) =>
      key === CSP_ALLOWED_DOMAINS_CACHE_KEY
        ? "https://payments.merchant.test,https://*.widgets.merchant.test"
        : null,
    );
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
      CACHE: { get },
    });
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(CSP_ALLOWED_DOMAINS_CACHE_KEY).toBe("security:csp_allowed_domains");
    expect(get).toHaveBeenCalledWith(CSP_ALLOWED_DOMAINS_CACHE_KEY);
    expect(csp).toContain("https://payments.merchant.test");
    expect(csp).not.toContain("https://*.payments.merchant.test");
    expect(csp).toContain("https://*.widgets.merchant.test");
  });

  it("ignores the removed CSP_ALLOWED environment variable", async () => {
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
      CSP_ALLOWED: "https://env-only.merchant.test",
      CACHE: { get: async () => null },
    });
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).not.toContain("env-only.merchant.test");
  });

  it("does not use an env fallback when the KV binding is missing", async () => {
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
      CSP_ALLOWED: "https://env-only.merchant.test",
    });
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).not.toContain("env-only.merchant.test");
    expect(csp).toContain("https://api.example.com");
  });

  it("fails open to platform and essential sources only when the KV read throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.example.com",
      CSP_ALLOWED: "https://env-only.merchant.test",
      CACHE: {
        get: async () => {
          throw new Error("kv unavailable");
        },
      },
    });
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(error).toHaveBeenCalledTimes(1);
    expect(csp).toContain("https://api.example.com");
    expect(csp).not.toContain("env-only.merchant.test");
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

  it("adds loopback sources only when the API origin is loopback", async () => {
    const production = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "https://api.store.test",
    });
    const local = await setPageCspHeader(new Response("ok"), {
      PUBLIC_API_BASE_URL: "http://localhost:8787",
    });

    expect(production.headers.get("Content-Security-Policy")).not.toContain("http://localhost:*");
    expect(local.headers.get("Content-Security-Policy")).toContain("http://localhost:*");
  });
});
