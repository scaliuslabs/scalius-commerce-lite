import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Public reads always run validation; obsolete Workers Cache responses must
 * never bypass the strict reader, including apparently successful entries.
 */
type TestApiWorker = { fetch(request: Request): Promise<Response> };

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: Env;
    ctx: ExecutionContext;
    constructor(ctx: ExecutionContext, env: Env) {
      this.env = env;
      this.ctx = ctx;
    }
  },
}));

vi.mock("@scalius/core/modules/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/platform")>()),
  resolvePlatformConfig: vi.fn(async () => ({
    storefrontUrl: "https://storefront.example.test",
    apiUrl: "https://api.example.test",
    dashboardUrl: "https://dashboard.example.test",
    mediaUrl: "https://cdn.example.test",
    customerAuthCookieDomain: "",
    corsAllowedOrigins: [],
    setupTokenRequired: false,
    identityHandoff: { enabled: false, issuer: "", audience: "", jwksUrl: "", localLoginDisabled: false },
  })),
}));

const renderedDirectly = vi.fn((request: Request) => {
  if (request.headers.has("If-None-Match") || request.headers.has("If-Modified-Since")) return new Response(null, { status: 304 });
  if (request.method === "HEAD") return new Response(null, { headers: { "Content-Type": "application/json" } });
  return Response.json({ success: true, data: "rendered directly" });
});
vi.mock("./runtime/public-app", () => ({ default: { fetch: renderedDirectly } }));

async function readThroughCache(cacheResponse: Response) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { default: ApiWorker } = await import("./worker");
  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    exports: { PublicApi: { fetch: vi.fn(async () => cacheResponse) } },
  } as unknown as ExecutionContext;
  const worker = new ApiWorker(ctx, {
    SCALIUS_SECRET: "public-cache-fallback-master-secret-0123456789",
    CF_VERSION_METADATA: { id: "version-a", tag: "", timestamp: "" },
  } as Env) as unknown as TestApiWorker;
  const response = await worker.fetch(new Request("https://api.example.test/api/v1/categories?ref=secret", {
    headers: { "X-Scalius-Cache-Generation": "abc123" },
  }));
  return { response, publicApi: (ctx as unknown as { exports: { PublicApi: { fetch: ReturnType<typeof vi.fn> } } }).exports.PublicApi.fetch, warnings: warn.mock.calls.map((call) => String(call[0])) };
}

afterEach(() => {
  renderedDirectly.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("strict public reads bypass retired Workers Cache", () => {
  it.each([200, 500, 503])("never calls the retired entrypoint even if it could return %i", async (status) => {
    const { response, publicApi, warnings } = await readThroughCache(new Response("old cache", { status }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: "rendered directly" });
    expect(renderedDirectly).toHaveBeenCalledTimes(1);
    expect(publicApi).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
  });
  it("returns a non-cacheable 503 when authoritative validation is unavailable", async () => {
    vi.stubGlobal("caches", { default: { match: async () => undefined, put: vi.fn() } });
    // This fixture has no database binding; an eligible miss cannot validate.
    const { response, publicApi } = await readThroughCache(new Response("old cache"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "PUBLIC_READ_UNAVAILABLE" } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(renderedDirectly).not.toHaveBeenCalled();
    expect(publicApi).not.toHaveBeenCalled();
  });

  it("fills a cold HEAD as GET and never consumes or overwrites the GET body on warm HEAD", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { binding } = createSqliteD1Database();
    const entries = new Map<string, Response>();
    const put = vi.fn(async (key: string, response: Response) => {
      entries.set(key, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
    });
    vi.stubGlobal("caches", { default: {
      match: async (key: string) => entries.get(key)?.clone(), put,
    } });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(ctx, {
      DB: binding,
      SCALIUS_SECRET: "public-cache-head-master-secret-0123456789",
      CF_VERSION_METADATA: { id: "version-a", tag: "", timestamp: "" },
    } as Env) as unknown as TestApiWorker;
    const read = async (method: string, suffix = "", headers: HeadersInit = {}) => {
      const result = await worker.fetch(new Request(`https://api.example.test/api/v1/categories${suffix}`, { method, headers }));
      await Promise.all(waits.splice(0));
      return result;
    };
    const cold = await read("HEAD");
    expect(cold.status).toBe(200);
    expect(cold.body).toBeNull();
    expect(cold.headers.get("X-Cache-Status")).toBe("MISS");
    expect(renderedDirectly.mock.calls[0]![0].method).toBe("GET");
    expect(await (await read("GET")).json()).toEqual({ success: true, data: "rendered directly" });
    const warm = await read("HEAD");
    expect(warm.body).toBeNull();
    expect(warm.headers.get("X-Cache-Status")).toBe("HIT");
    expect(await (await read("GET")).json()).toEqual({ success: true, data: "rendered directly" });
    expect(renderedDirectly).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);

    // Conditional requests also fill a complete representation on a cold key.
    const conditional = await read("GET", "?page=2", { "If-None-Match": '"old"', "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT" });
    expect(conditional.status).toBe(200);
    expect(await conditional.json()).toEqual({ success: true, data: "rendered directly" });
    expect((await read("GET", "?page=2")).headers.get("X-Cache-Status")).toBe("HIT");
    expect(renderedDirectly).toHaveBeenCalledTimes(2);
  });

});
