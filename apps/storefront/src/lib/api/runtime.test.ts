// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveRuntimeSecret,
  RUNTIME_SECRET_PURPOSES,
} from "@scalius/shared/runtime-secrets";

import {
  applyPlatformOrigins,
  createRequestRuntime,
  getRuntimeApiBaseUrl,
  getRuntimeApiToken,
  getRuntimeApiUrl,
  getRuntimeCdnDomain,
  getRuntimeCspAllowedDomains,
  getRuntimeDashboardUrl,
  getRuntimeMediaUrl,
  getRuntimeStorefrontUrl,
  requestRuntime,
  runWithRequestRuntime,
  type StorefrontRuntime,
} from "./runtime";

const MASTER_SECRET = "storefront-test-master-secret-with-enough-length-0123456789";
const PLATFORM = {
  storefrontUrl: "https://shop.example.test",
  apiUrl: "https://api.example.test",
  dashboardUrl: "https://dashboard.example.test",
  mediaUrl: "https://cdn.example.test",
};

const request = new Request("https://storefront-host.example.test/products/lamp?x=1");

function seed(
  store: StorefrontRuntime,
  layout: Parameters<typeof applyPlatformOrigins>[0],
): StorefrontRuntime {
  requestRuntime.run(store, () => applyPlatformOrigins(layout));
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRequestRuntime", () => {
  it("makes no platform sub-request and starts from the request origin", async () => {
    const backend = { fetch: vi.fn() } as unknown as Fetcher;
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const store = await createRequestRuntime(request, {
      BACKEND_API: backend,
      SCALIUS_SECRET: MASTER_SECRET,
    });

    expect(backend.fetch).not.toHaveBeenCalled();
    expect(httpFetch).not.toHaveBeenCalled();
    expect(store.BACKEND_API).toBe(backend);
    expect(store.STOREFRONT_URL).toBe("https://storefront-host.example.test");
    expect(store.PUBLIC_API_URL).toBeUndefined();
    expect(store.inflightReads).toBeInstanceOf(Map);
    expect(store.apiJwt).toEqual({ token: null, expiresAt: null, refresh: null });
  });

  it("derives API_TOKEN from SCALIUS_SECRET", async () => {
    const store = await createRequestRuntime(request, { SCALIUS_SECRET: MASTER_SECRET });

    expect(store.API_TOKEN).toBe(
      await deriveRuntimeSecret(MASTER_SECRET, RUNTIME_SECRET_PURPOSES.API_TOKEN),
    );
    expect(store.API_TOKEN).not.toContain(MASTER_SECRET);
  });

  it("seeds no secrets when the master secret is missing or too short", async () => {
    for (const env of [{}, { SCALIUS_SECRET: "short" }, null]) {
      const store = await createRequestRuntime(request, env);
      expect(store.API_TOKEN).toBeUndefined();
    }
  });

  it("does not admit legacy generation headers into the request runtime", async () => {
    for (const value of ["a1b2c3d4e5f60718", "../../evil"]) {
      const runtime = await createRequestRuntime(new Request(request.url, {
        headers: { "X-Scalius-Cache-Generation": value },
      }), null);
      expect(runtime).not.toHaveProperty("CACHE_GENERATION");
    }
  });
});

describe("applyPlatformOrigins", () => {
  it("seeds origins and merchant CSP sources from the layout payload", async () => {
    const store = seed(await createRequestRuntime(request, { SCALIUS_SECRET: MASTER_SECRET }), {
      platform: PLATFORM,
      cspAllowedDomains: "https://payments.example.test",
    });

    const seen = requestRuntime.run(store, () => ({
      apiUrl: getRuntimeApiUrl(),
      apiBaseUrl: getRuntimeApiBaseUrl(),
      storefrontUrl: getRuntimeStorefrontUrl(),
      dashboardUrl: getRuntimeDashboardUrl(),
      mediaUrl: getRuntimeMediaUrl(),
      cdnDomain: getRuntimeCdnDomain(),
      csp: getRuntimeCspAllowedDomains(),
      apiToken: getRuntimeApiToken(),
    }));
    expect(seen).toEqual({
      apiUrl: "https://api.example.test/api/v1",
      apiBaseUrl: "https://api.example.test",
      storefrontUrl: "https://shop.example.test",
      dashboardUrl: "https://dashboard.example.test",
      mediaUrl: "https://cdn.example.test",
      cdnDomain: "cdn.example.test",
      csp: "https://payments.example.test",
      apiToken: store.API_TOKEN,
    });
  });

  it("keeps the request origin for STOREFRONT_URL when the platform setting is empty", async () => {
    const store = seed(await createRequestRuntime(request, {}), {
      platform: { ...PLATFORM, storefrontUrl: "" },
    });

    expect(store.STOREFRONT_URL).toBe("https://storefront-host.example.test");
    expect(store.PUBLIC_API_URL).toBe("https://api.example.test/api/v1");
  });

  it.each([
    ["a failed layout read", null],
    ["a layout without a platform block", {}],
  ])("fails closed on %s: no API URL, request origin for the storefront", async (_label, layout) => {
    const store = seed(await createRequestRuntime(request, {}), layout);

    expect(store.PUBLIC_API_URL).toBeUndefined();
    expect(store.PUBLIC_API_BASE_URL).toBeUndefined();
    expect(store.DASHBOARD_URL).toBeUndefined();
    expect(store.MEDIA_URL).toBeUndefined();
    expect(store.CDN_DOMAIN_URL).toBeUndefined();
    expect(store.CSP_ALLOWED_DOMAINS).toBe("");
    expect(store.STOREFRONT_URL).toBe("https://storefront-host.example.test");
  });

  it("keeps a dashboard URL that lives below a path prefix on the storefront host", async () => {
    const store = seed(await createRequestRuntime(request, {}), {
      platform: { ...PLATFORM, dashboardUrl: "https://shop.example.test/dashboard/" },
    });

    expect(store.DASHBOARD_URL).toBe("https://shop.example.test/dashboard");
  });

  it("drops malformed platform values instead of trusting them", async () => {
    const store = seed(await createRequestRuntime(request, {}), {
      platform: {
        storefrontUrl: "http://shop.example.test",
        apiUrl: "https://api.example.test/path",
        dashboardUrl: "javascript:alert(1)",
        mediaUrl: "https://cdn.example.test/media/?x=1",
      },
    });

    expect(store.STOREFRONT_URL).toBe("https://storefront-host.example.test");
    expect(store.PUBLIC_API_URL).toBeUndefined();
    expect(store.DASHBOARD_URL).toBeUndefined();
    expect(store.MEDIA_URL).toBeUndefined();
    expect(store.CDN_DOMAIN_URL).toBeUndefined();
  });

  it("is a no-op outside a seeded request", () => {
    expect(() => applyPlatformOrigins({ platform: PLATFORM })).not.toThrow();
    expect(getRuntimeApiUrl()).toBeUndefined();
  });
});

describe("runWithRequestRuntime", () => {
  it("runs the request inside the seeded runtime and leaves no state behind", async () => {
    const seen = await runWithRequestRuntime(
      request,
      { SCALIUS_SECRET: MASTER_SECRET },
      async () => {
        applyPlatformOrigins({ platform: PLATFORM });
        return {
          apiUrl: getRuntimeApiUrl(),
          storefrontUrl: getRuntimeStorefrontUrl(),
          apiToken: getRuntimeApiToken(),
        };
      },
    );

    expect(seen.apiUrl).toBe("https://api.example.test/api/v1");
    expect(seen.storefrontUrl).toBe("https://shop.example.test");
    expect(seen.apiToken).toBe(
      await deriveRuntimeSecret(MASTER_SECRET, RUNTIME_SECRET_PURPOSES.API_TOKEN),
    );
    expect(getRuntimeApiUrl()).toBeUndefined();
  });
});
