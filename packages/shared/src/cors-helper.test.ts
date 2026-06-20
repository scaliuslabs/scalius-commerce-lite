import { describe, expect, it, vi } from "vitest";

import { getCorsOriginContext } from "./cors-helper";

describe("getCorsOriginContext", () => {
  it("allows exact configured origins after normalizing URL paths", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        PUBLIC_API_BASE_URL: "https://api.scalius.com/api/v1",
      },
    });

    expect(getOrigin("https://api.scalius.com")).toBe("https://api.scalius.com");
  });

  it("allows real subdomains without matching lookalike domains", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        CSP_ALLOWED: "example.com",
      },
    });

    expect(getOrigin("https://example.com")).toBe("https://example.com");
    expect(getOrigin("https://shop.example.com")).toBe("https://shop.example.com");
    expect(getOrigin("https://a.b.example.com")).toBe("https://a.b.example.com");
    expect(getOrigin("https://badexample.com")).toBeNull();
    expect(getOrigin("https://example.com.evil.test")).toBeNull();
    expect(getOrigin("https://shop-example.com")).toBeNull();
  });

  it("keeps CDN wildcard matching below the configured CDN host boundary", async () => {
    const getOrigin = await getCorsOriginContext({
      env: {
        CDN_DOMAIN_URL: "cloud.scalius.com",
      },
    });

    expect(getOrigin("https://cloud.scalius.com")).toBe("https://cloud.scalius.com");
    expect(getOrigin("https://media.cloud.scalius.com")).toBe("https://media.cloud.scalius.com");
    expect(getOrigin("https://badcloud.scalius.com")).toBeNull();
    expect(getOrigin("https://cloud.scalius.com.evil.test")).toBeNull();
  });

  it("allows localhost and loopback development ports without allowing lookalike hosts", async () => {
    const getOrigin = await getCorsOriginContext({ env: {} });

    expect(getOrigin("http://localhost:4323")).toBe("http://localhost:4323");
    expect(getOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(getOrigin("http://localhost.evil.test:4323")).toBeNull();
    expect(getOrigin("http://127.0.0.10:8787")).toBeNull();
  });

  it("uses the KV security setting when present", async () => {
    const get = vi.fn(async () => "kv.example.com");
    const getOrigin = await getCorsOriginContext({
      env: {
        CACHE: { get },
        CSP_ALLOWED: "env.example.com",
      },
    });

    expect(get).toHaveBeenCalledWith("security:csp_allowed_domains");
    expect(getOrigin("https://shop.kv.example.com")).toBe("https://shop.kv.example.com");
    expect(getOrigin("https://shop.env.example.com")).toBeNull();
  });
});
