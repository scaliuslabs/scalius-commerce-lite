import { describe, expect, it, vi } from "vitest";

import { getCorsOriginContext } from "./cors-helper";

describe("getCorsOriginContext", () => {
  it("allows requests with no Origin header", async () => {
    const getOrigin = await getCorsOriginContext({ env: {} });

    expect(getOrigin("")).toBe("*");
  });

  it("allows exact first-party platform origins after normalizing URL paths", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        PUBLIC_API_BASE_URL: "https://api.example.com/api/v1",
        BETTER_AUTH_URL: "https://dashboard.example.com/",
        STOREFRONT_URL: "https://shop.example.com",
      },
    });

    expect(getOrigin("https://api.example.com")).toBe("https://api.example.com");
    expect(getOrigin("https://dashboard.example.com")).toBe("https://dashboard.example.com");
    expect(getOrigin("https://shop.example.com")).toBe("https://shop.example.com");
    expect(getOrigin("https://other.example.com")).toBeNull();
  });

  it("rejects non-http and credentialed configured origins", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        CORS_ALLOWED_ORIGINS: "ftp://trusted.example.com, https://user:pass@trusted.example.com",
      },
    });

    expect(getOrigin("ftp://trusted.example.com")).toBeNull();
    expect(getOrigin("https://trusted.example.com")).toBeNull();
  });

  it("does not treat merchant CSP domains as credentialed API origins", async () => {
    const get = vi.fn(async () => "kv.example.com");
    const getOrigin = await getCorsOriginContext({
      env: {
        CACHE: { get },
      },
    });

    expect(get).not.toHaveBeenCalled();
    expect(getOrigin("https://example.com")).toBeNull();
    expect(getOrigin("https://shop.example.com")).toBeNull();
    expect(getOrigin("https://kv.example.com")).toBeNull();
  });

  it("allows composed CORS_ALLOWED_ORIGINS URL origins without expanding wildcard hosts", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        CORS_ALLOWED_ORIGINS: "https://trusted.example.com/path, https://*.wild.example.com, example.test",
      },
    });

    expect(getOrigin("https://trusted.example.com")).toBe("https://trusted.example.com");
    expect(getOrigin("https://shop.wild.example.com")).toBeNull();
    expect(getOrigin("https://example.test")).toBeNull();
  });

  it("ignores the removed CREDENTIAL_CORS_ALLOWED_ORIGINS and TRUSTED_ORIGINS env keys", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        CREDENTIAL_CORS_ALLOWED_ORIGINS: "https://legacy.example.com",
        TRUSTED_ORIGINS: "https://trusted-legacy.example.com",
      },
    });

    expect(getOrigin("https://legacy.example.com")).toBeNull();
    expect(getOrigin("https://trusted-legacy.example.com")).toBeNull();
  });

  it("ignores non-string CORS_ALLOWED_ORIGINS values", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        CORS_ALLOWED_ORIGINS: ["https://mobile-admin.example.com"],
      },
    });

    expect(getOrigin("https://mobile-admin.example.com")).toBeNull();
  });

  it("does not allow localhost and loopback origins by default in production-like envs", async () => {
    const getOrigin = await getCorsOriginContext({ env: {} });

    expect(getOrigin("http://localhost:4323")).toBeNull();
    expect(getOrigin("http://127.0.0.1:8787")).toBeNull();
    expect(getOrigin("http://[::1]:8787")).toBeNull();
  });

  it("allows localhost and loopback development ports when a first-party runtime URL is loopback", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        PUBLIC_API_BASE_URL: "http://localhost:8787",
      },
    });

    expect(getOrigin("http://localhost:4323")).toBe("http://localhost:4323");
    expect(getOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(getOrigin("http://[::1]:8787")).toBe("http://[::1]:8787");
    expect(getOrigin("http://localhost.evil.test:4323")).toBeNull();
    expect(getOrigin("http://127.0.0.10:8787")).toBeNull();
  });

  it("does not enable loopback ports when only an extra CORS origin is loopback", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        PUBLIC_API_BASE_URL: "https://api.example.com",
        CORS_ALLOWED_ORIGINS: "http://localhost:4323",
      },
    });

    expect(getOrigin("http://localhost:4323")).toBe("http://localhost:4323");
    expect(getOrigin("http://localhost:8787")).toBeNull();
    expect(getOrigin("http://127.0.0.1:4323")).toBeNull();
  });

  it("allows exact explicitly configured localhost origins without enabling every loopback port", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        CORS_ALLOWED_ORIGINS: "http://localhost:4323",
      },
    });

    expect(getOrigin("http://localhost:4323")).toBe("http://localhost:4323");
    expect(getOrigin("http://localhost:8787")).toBeNull();
    expect(getOrigin("http://127.0.0.1:4323")).toBeNull();
  });
});
