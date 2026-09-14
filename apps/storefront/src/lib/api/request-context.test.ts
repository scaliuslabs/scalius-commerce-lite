// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveRuntimeSecret,
  RUNTIME_SECRET_PURPOSES,
} from "@scalius/shared/runtime-secrets";

import { apiContext } from "./context";
import { createRequestApiContext } from "./request-context";
import {
  getRuntimeApiBaseUrl,
  getRuntimeApiToken,
  getRuntimeApiUrl,
  getRuntimeCdnDomain,
  getRuntimeDashboardUrl,
  getRuntimeMediaUrl,
  getRuntimeStorefrontUrl,
} from "./runtime-env";

const MASTER_SECRET = "storefront-test-master-secret-with-enough-length-0123456789";
const PLATFORM = {
  storefrontUrl: "https://shop.example.test",
  apiUrl: "https://api.example.test",
  dashboardUrl: "https://dashboard.example.test",
  mediaUrl: "https://cdn.example.test",
};

function platformResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  });
}

function binding(fetch: (url: string, init?: RequestInit) => Promise<Response>): Fetcher {
  return { fetch: vi.fn(fetch) } as unknown as Fetcher;
}

const request = new Request("https://storefront-host.example.test/products/lamp?x=1");

beforeEach(() => {
  vi.stubEnv("DEV", false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("createRequestApiContext", () => {
  it("seeds the request context from /api/v1/platform through the service binding", async () => {
    const backend = binding(async () => platformResponse(PLATFORM));
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const store = await createRequestApiContext(request, {
      BACKEND_API: backend,
      SCALIUS_SECRET: MASTER_SECRET,
    });

    expect(backend.fetch).toHaveBeenCalledTimes(1);
    expect(backend.fetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/platform",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    expect(httpFetch).not.toHaveBeenCalled();
    expect(store.BACKEND_API).toBe(backend);
    expect(store.STOREFRONT_URL).toBe("https://shop.example.test");
    expect(store.PUBLIC_API_BASE_URL).toBe("https://api.example.test");
    expect(store.PUBLIC_API_URL).toBe("https://api.example.test/api/v1");
    expect(store.DASHBOARD_URL).toBe("https://dashboard.example.test");
    expect(store.MEDIA_URL).toBe("https://cdn.example.test");
    expect(store.CDN_DOMAIN_URL).toBe("cdn.example.test");
    expect(store.inflightReads).toBeInstanceOf(Map);
    expect(store.apiJwt).toEqual({ token: null, expiresAt: null, refresh: null });
  });

  it("derives API_TOKEN and PURGE_TOKEN from SCALIUS_SECRET and exposes them through the getters", async () => {
    const backend = binding(async () => platformResponse(PLATFORM));
    const store = await createRequestApiContext(request, {
      BACKEND_API: backend,
      SCALIUS_SECRET: MASTER_SECRET,
    });

    expect(store.API_TOKEN).toBe(
      await deriveRuntimeSecret(MASTER_SECRET, RUNTIME_SECRET_PURPOSES.API_TOKEN),
    );
    expect(store.PURGE_TOKEN).toBe(
      await deriveRuntimeSecret(MASTER_SECRET, RUNTIME_SECRET_PURPOSES.PURGE_TOKEN),
    );
    expect(store.API_TOKEN).not.toBe(store.PURGE_TOKEN);
    expect(store.API_TOKEN).not.toContain(MASTER_SECRET);

    const seen = apiContext.run(store, () => ({
      apiUrl: getRuntimeApiUrl(),
      apiBaseUrl: getRuntimeApiBaseUrl(),
      storefrontUrl: getRuntimeStorefrontUrl(),
      dashboardUrl: getRuntimeDashboardUrl(),
      mediaUrl: getRuntimeMediaUrl(),
      cdnDomain: getRuntimeCdnDomain(),
      apiToken: getRuntimeApiToken(),
    }));
    expect(seen).toEqual({
      apiUrl: "https://api.example.test/api/v1",
      apiBaseUrl: "https://api.example.test",
      storefrontUrl: "https://shop.example.test",
      dashboardUrl: "https://dashboard.example.test",
      mediaUrl: "https://cdn.example.test",
      cdnDomain: "cdn.example.test",
      apiToken: store.API_TOKEN,
    });
  });

  it("seeds no secrets when the master secret is missing or too short", async () => {
    const backend = binding(async () => platformResponse(PLATFORM));

    for (const env of [
      { BACKEND_API: backend },
      { BACKEND_API: backend, SCALIUS_SECRET: "short" },
      null,
    ]) {
      const store = await createRequestApiContext(request, env);
      expect(store.API_TOKEN).toBeUndefined();
      expect(store.PURGE_TOKEN).toBeUndefined();
    }
  });

  it("falls back to the request origin for STOREFRONT_URL when the platform setting is empty", async () => {
    const backend = binding(async () =>
      platformResponse({ ...PLATFORM, storefrontUrl: "" }));

    const store = await createRequestApiContext(request, { BACKEND_API: backend });

    expect(store.STOREFRONT_URL).toBe("https://storefront-host.example.test");
    expect(store.PUBLIC_API_URL).toBe("https://api.example.test/api/v1");
    expect(apiContext.run(store, () => getRuntimeStorefrontUrl())).toBe(
      "https://storefront-host.example.test",
    );
  });

  it.each([
    ["a non-2xx response", async () => new Response("nope", { status: 503 })],
    ["a thrown binding error", async () => { throw new Error("binding unavailable"); }],
    ["a non-JSON body", async () => new Response("<html>", { status: 200 })],
    ["a failed envelope", async () => new Response(JSON.stringify({ success: false, error: "x" }), { status: 200 })],
  ])("fails closed on %s: no API URL, request origin for the storefront", async (_label, fetch) => {
    const backend = binding(fetch);

    const store = await createRequestApiContext(request, {
      BACKEND_API: backend,
      SCALIUS_SECRET: MASTER_SECRET,
    });

    expect(store.PUBLIC_API_URL).toBeUndefined();
    expect(store.PUBLIC_API_BASE_URL).toBeUndefined();
    expect(store.DASHBOARD_URL).toBeUndefined();
    expect(store.MEDIA_URL).toBeUndefined();
    expect(store.CDN_DOMAIN_URL).toBeUndefined();
    expect(store.STOREFRONT_URL).toBe("https://storefront-host.example.test");
    expect(store.API_TOKEN).toBeDefined();
  });

  it("drops malformed platform values instead of trusting them", async () => {
    const backend = binding(async () => platformResponse({
      storefrontUrl: "http://shop.example.test",
      apiUrl: "https://api.example.test/path",
      dashboardUrl: "javascript:alert(1)",
      mediaUrl: "https://cdn.example.test/media/?x=1",
    }));

    const store = await createRequestApiContext(request, { BACKEND_API: backend });

    expect(store.STOREFRONT_URL).toBe("https://storefront-host.example.test");
    expect(store.PUBLIC_API_URL).toBeUndefined();
    expect(store.DASHBOARD_URL).toBeUndefined();
    expect(store.MEDIA_URL).toBeUndefined();
    expect(store.CDN_DOMAIN_URL).toBeUndefined();
  });

  it("fails closed in production when the service binding is absent", async () => {
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const store = await createRequestApiContext(request, { SCALIUS_SECRET: MASTER_SECRET });

    expect(httpFetch).not.toHaveBeenCalled();
    expect(store.PUBLIC_API_URL).toBeUndefined();
    expect(store.STOREFRONT_URL).toBe("https://storefront-host.example.test");
  });

  it("uses plain HTTP to the fixed local API port in astro dev", async () => {
    vi.stubEnv("DEV", true);
    const httpFetch = vi.fn(async () => platformResponse({
      storefrontUrl: "http://localhost:4322",
      apiUrl: "http://localhost:8787",
      dashboardUrl: "http://localhost:4323",
      mediaUrl: "http://localhost:8787/api/v1/media",
    }));
    vi.stubGlobal("fetch", httpFetch);
    const backend = binding(async () => platformResponse(PLATFORM));

    const store = await createRequestApiContext(
      new Request("http://localhost:4322/"),
      { BACKEND_API: backend },
    );

    expect(httpFetch).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/platform",
      expect.objectContaining({ method: "GET" }),
    );
    expect(backend.fetch).not.toHaveBeenCalled();
    expect(store.PUBLIC_API_URL).toBe("http://localhost:8787/api/v1");
    expect(store.STOREFRONT_URL).toBe("http://localhost:4322");
    expect(store.MEDIA_URL).toBe("http://localhost:8787/api/v1/media");
    expect(store.CDN_DOMAIN_URL).toBe("localhost:8787");
  });
});
