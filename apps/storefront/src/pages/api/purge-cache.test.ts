import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_ID } from "../../config/build-id";

const mocks = vi.hoisted(() => ({
  cfEnv: {
    PURGE_TOKEN: "secret",
    CACHE_CONTROL: {
      get: vi.fn(),
      put: vi.fn(),
    },
  },
  clearL1ByPrefixes: vi.fn(),
  smartCacheClear: vi.fn(),
  cacheDelete: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

vi.mock("@/lib/edge-cache", () => ({
  clearL1ByPrefixes: mocks.clearL1ByPrefixes,
}));

vi.mock("@/lib/smart-cache", () => ({
  smartCache: {
    clear: mocks.smartCacheClear,
  },
}));

vi.mock("@/lib/purge-auth", () => ({
  PURGE_TOKEN_HEADER: "X-Purge-Token",
  getPurgeTokenFromHeaders: (headers: Headers) => {
    const authorization = headers.get("Authorization");
    if (authorization?.startsWith("Bearer ")) {
      return authorization.slice("Bearer ".length);
    }
    return headers.get("X-Purge-Token");
  },
}));

vi.mock("@/lib/cache-purge-policy", () => ({
  shouldBumpCacheVersionForSelectivePurge: ({
    prefixes,
    bumpVersion,
  }: {
    prefixes: string[];
    bumpVersion: boolean;
  }) => bumpVersion || prefixes.length > 0,
  shouldWarmCriticalCachesForSelectivePurge: ({
    prefixes,
    bumpVersion,
  }: {
    prefixes: string[];
    bumpVersion: boolean;
  }) => bumpVersion || prefixes.length > 0,
}));

describe("storefront cache purge route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (mocks.cfEnv as { STOREFRONT_URL?: string }).STOREFRONT_URL;
    delete (mocks.cfEnv as { CACHE_NAMESPACE?: string }).CACHE_NAMESPACE;
    mocks.cfEnv.CACHE_CONTROL.get.mockResolvedValue("4");
    mocks.cfEnv.CACHE_CONTROL.put.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );
    vi.stubGlobal("caches", {
      default: {
        delete: mocks.cacheDelete,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects purge credentials in GET query strings without touching caches", async () => {
    const { GET } = await import("./purge-cache");
    const request = new Request("https://storefront.example.com/api/purge-cache?token=secret");

    const response = await GET({
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil: mocks.waitUntil } },
    } as unknown as Parameters<typeof GET>[0]);
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("Purge token must be sent");
    expect(mocks.cfEnv.CACHE_CONTROL.get).not.toHaveBeenCalled();
    expect(mocks.cfEnv.CACHE_CONTROL.put).not.toHaveBeenCalled();
    expect(mocks.clearL1ByPrefixes).not.toHaveBeenCalled();
    expect(mocks.smartCacheClear).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it("keeps authenticated GET non-mutating and directs callers to POST", async () => {
    const { GET } = await import("./purge-cache");
    const request = new Request("https://storefront.example.com/api/purge-cache", {
      headers: {
        Authorization: "Bearer secret",
      },
    });

    const response = await GET({
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil: mocks.waitUntil } },
    } as unknown as Parameters<typeof GET>[0]);
    const body = (await response.json()) as { error?: string; message?: string };

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(body.error).toBe("Method Not Allowed");
    expect(body.message).toContain("Use POST");
    expect(mocks.cfEnv.CACHE_CONTROL.get).not.toHaveBeenCalled();
    expect(mocks.cfEnv.CACHE_CONTROL.put).not.toHaveBeenCalled();
    expect(mocks.clearL1ByPrefixes).not.toHaveBeenCalled();
    expect(mocks.smartCacheClear).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it("keeps POST as the full purge path with version bump and warming", async () => {
    const { POST } = await import("./purge-cache");
    const request = new Request("https://storefront.example.com/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bumpVersion: true }),
    });

    const response = await POST({
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil: mocks.waitUntil } },
    } as unknown as Parameters<typeof POST>[0]);
    const body = (await response.json()) as {
      success?: boolean;
      details?: { newVersion?: number; cacheWarmingStarted?: boolean };
    };
    const warmPromise = mocks.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await warmPromise;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.details?.newVersion).toBe(5);
    expect(body.details?.cacheWarmingStarted).toBe(true);
    expect(mocks.cfEnv.CACHE_CONTROL.get).toHaveBeenCalledWith("v_storefront.example.com");
    expect(mocks.cfEnv.CACHE_CONTROL.put).toHaveBeenCalledWith("v_storefront.example.com", "5");
    expect(mocks.smartCacheClear).toHaveBeenCalledTimes(1);
    expect(mocks.clearL1ByPrefixes).not.toHaveBeenCalled();
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://storefront.example.com/",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          "X-Cache-Warm": "true",
        }),
      }),
    );
  });

  it("preserves the local port when warming critical caches", async () => {
    const { POST } = await import("./purge-cache");
    const request = new Request("http://localhost:4322/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bumpVersion: true }),
    });

    const response = await POST({
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil: mocks.waitUntil } },
    } as unknown as Parameters<typeof POST>[0]);
    const warmPromise = mocks.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await warmPromise;

    expect(response.status).toBe(200);
    expect(mocks.cfEnv.CACHE_CONTROL.get).toHaveBeenCalledWith("v_localhost");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4322/",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          "X-Cache-Warm": "true",
        }),
      }),
    );
  });

  it("uses the canonical storefront URL as the production cache namespace", async () => {
    (mocks.cfEnv as { STOREFRONT_URL?: string }).STOREFRONT_URL =
      "https://storefront.example.com";
    const { POST } = await import("./purge-cache");
    const request = new Request("https://www.example.com/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bumpVersion: true }),
    });

    const response = await POST({
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil: mocks.waitUntil } },
    } as unknown as Parameters<typeof POST>[0]);
    const warmPromise = mocks.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await warmPromise;

    expect(response.status).toBe(200);
    expect(mocks.cfEnv.CACHE_CONTROL.get).toHaveBeenCalledWith("v_storefront.example.com");
    expect(mocks.cfEnv.CACHE_CONTROL.put).toHaveBeenCalledWith("v_storefront.example.com", "5");
    expect(fetch).toHaveBeenCalledWith(
      "https://www.example.com/",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          "X-Cache-Warm": "true",
        }),
      }),
    );
  });

  it("warms critical caches when a selective prefix purge bumps the global version", async () => {
    const { POST } = await import("./purge-cache");
    const request = new Request("https://storefront.example.com/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        groups: ["checkout"],
        prefixes: ["checkout_config"],
        bumpVersion: false,
      }),
    });

    const response = await POST({
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil: mocks.waitUntil } },
    } as unknown as Parameters<typeof POST>[0]);
    const body = (await response.json()) as {
      success?: boolean;
      details?: { newVersion?: number; cacheWarmingStarted?: boolean; prefixesCleared?: number | string };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.details?.newVersion).toBe(5);
    expect(body.details?.prefixesCleared).toBe(1);
    expect(body.details?.cacheWarmingStarted).toBe(true);
    expect(mocks.cfEnv.CACHE_CONTROL.get).toHaveBeenCalledWith("v_storefront.example.com");
    expect(mocks.cfEnv.CACHE_CONTROL.put).toHaveBeenCalledWith("v_storefront.example.com", "5");
    expect(mocks.clearL1ByPrefixes).toHaveBeenCalledWith(["checkout_config"]);
    expect(mocks.smartCacheClear).not.toHaveBeenCalled();
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    const warmPromise = mocks.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await warmPromise;
    expect(fetch).toHaveBeenCalledWith(
      "https://storefront.example.com/",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          "X-Cache-Warm": "true",
        }),
      }),
    );
  });

  it("clears exact L1 and L2 keys without bumping the cache version", async () => {
    mocks.cacheDelete.mockResolvedValue(true);
    const { POST } = await import("./purge-cache");
    const request = new Request("https://storefront.example.com/api/purge-cache", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        groups: ["products"],
        exactKeys: ["product_slug_fish", "product_variants_prod_1"],
        htmlPaths: ["/products/fish?size=m"],
        bumpVersion: false,
      }),
    });

    const response = await POST({
      request,
      url: new URL(request.url),
      locals: { cfContext: { waitUntil: mocks.waitUntil } },
    } as unknown as Parameters<typeof POST>[0]);
    const body = (await response.json()) as {
      success?: boolean;
      details?: {
        cacheVersionBumped?: boolean;
        newVersion?: number | null;
        prefixesCleared?: number | string;
        exactKeysCleared?: number;
        exactGenerationsBumped?: number;
        l2ExactKeysDeleted?: number;
        htmlPathsCleared?: number;
        htmlPathsDeleted?: number;
        cacheWarmingStarted?: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.details).toMatchObject({
      cacheVersionBumped: false,
      newVersion: null,
      prefixesCleared: 0,
      exactKeysCleared: 2,
      exactGenerationsBumped: 2,
      l2ExactKeysDeleted: 2,
      htmlPathsCleared: 1,
      htmlPathsDeleted: 1,
      cacheWarmingStarted: true,
    });
    expect(mocks.cfEnv.CACHE_CONTROL.get).toHaveBeenCalledWith("v_storefront.example.com");
    expect(mocks.cfEnv.CACHE_CONTROL.put).not.toHaveBeenCalledWith(
      "v_storefront.example.com",
      expect.any(String),
    );
    expect(mocks.cfEnv.CACHE_CONTROL.put).toHaveBeenCalledWith(
      "g:storefront.example.com:product_slug_fish",
      expect.any(String),
    );
    expect(mocks.cfEnv.CACHE_CONTROL.put).toHaveBeenCalledWith(
      "g:storefront.example.com:product_variants_prod_1",
      expect.any(String),
    );
    expect(mocks.clearL1ByPrefixes).toHaveBeenCalledWith([
      "product_slug_fish",
      "product_variants_prod_1",
    ]);
    expect(mocks.cacheDelete).toHaveBeenCalledWith(
      `https://storefront.example.com/_api-cache/product_slug_fish?v=4&build=${BUILD_ID}&g=4`,
    );
    expect(mocks.cacheDelete).toHaveBeenCalledWith(
      `https://storefront.example.com/_api-cache/product_variants_prod_1?v=4&build=${BUILD_ID}&g=4`,
    );
    const htmlDeleteArg = mocks.cacheDelete.mock.calls.find(
      ([arg]) => arg instanceof Request,
    )?.[0] as Request | undefined;
    expect(htmlDeleteArg?.url).toBe(
      `https://storefront.example.com/products/fish?cache_v=4-${BUILD_ID}&cache_gen=4`,
    );
    expect(mocks.smartCacheClear).not.toHaveBeenCalled();
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    const warmPromise = mocks.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await warmPromise;
    const warmUrl = vi.mocked(fetch).mock.calls[0]?.[0] as URL;
    expect(warmUrl.toString()).toBe("https://storefront.example.com/products/fish?size=m");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          "X-Cache-Warm": "true",
        }),
      }),
    );
  });
});
