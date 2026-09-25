import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A single public read through the API entry: the generation cache is a hint.
 * A 5xx the Workers Cache layer produced itself (no headers of ours) is
 * rendered directly; our own 5xx and every other response pass through.
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

const renderedDirectly = vi.fn(() => Response.json({ success: true, data: "rendered directly" }));
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
  } as Env) as unknown as TestApiWorker;
  const response = await worker.fetch(new Request("https://api.example.test/api/v1/categories?ref=secret", {
    headers: { "X-Scalius-Cache-Generation": "abc123" },
  }));
  return { response, warnings: warn.mock.calls.map((call) => String(call[0])) };
}

afterEach(() => {
  renderedDirectly.mockClear();
  vi.restoreAllMocks();
});

describe("public read through the generation cache", () => {
  it("renders directly when the cache layer answers a 5xx without our headers, logging one masked line", async () => {
    const { response, warnings } = await readThroughCache(new Response(null, { status: 500 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: "rendered directly" });
    expect(renderedDirectly).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      "[PublicCache] cache layer answered 500 for /api/v1/categories; rendering it directly",
    ]);
  });

  it("passes our own 5xx through without a second render", async () => {
    const ours = Response.json({ success: false }, { status: 503, headers: { "X-Content-Type-Options": "nosniff" } });
    const { response, warnings } = await readThroughCache(ours);

    expect(response.status).toBe(503);
    expect(renderedDirectly).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("leaves a cached 200 untouched", async () => {
    const { response } = await readThroughCache(Response.json({ success: true, data: "cached" }));

    expect(await response.json()).toEqual({ success: true, data: "cached" });
    expect(renderedDirectly).not.toHaveBeenCalled();
  });
});
