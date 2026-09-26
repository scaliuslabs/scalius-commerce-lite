import { afterEach, describe, expect, it, vi } from "vitest";
import { hashCacheDep } from "@scalius/shared/cache-frontier";

const handle = vi.hoisted(() => vi.fn(
  async (_request: Request, _env?: unknown, _ctx?: unknown) => new Response("rendered"),
));
vi.mock("@astrojs/cloudflare/handler", () => ({ handle }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));
vi.mock("./config/build-id", () => ({ BUILD_ID: "test-build" }));

const cacheStore = new Map<string, Response>();
vi.stubGlobal("caches", {
  default: {
    match: async (key: string) => cacheStore.get(key)?.clone(),
    put: async (key: string, response: Response) => void cacheStore.set(key, response),
  },
});

afterEach(() => vi.restoreAllMocks());

describe("storefront Worker gateway cache", () => {
  it("serves a proven public page under the Worker version with a fresh frontier and no API work", async () => {
    cacheStore.set(
      "https://shop.example/__cache/test-build/version-a/dvc/products/fish",
      new Response("cached page", { headers: {
        "Content-Type": "text/html",
        "X-Scalius-Api-Version": "api-version-a",
        "X-Scalius-Dep-Seq": "7",
        "X-Scalius-Deps": hashCacheDep("p:fish"),
        "X-Scalius-Rendered-At": "1000",
      } }),
    );
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    cacheStore.set(
      "https://shop.example/__scalius/frontier/test-build/version-a",
      new Response(JSON.stringify({
        apiVersion: "api-version-a", S: 7, horizon: 0, floor: 0,
        sentAt: 2_000, changes: [],
      })),
    );
    const kvGet = vi.fn();
    const apiFetch = vi.fn();
    const waitUntil = vi.fn();
    const { default: StorefrontGateway } = await import("./worker");
    const worker = Object.assign(new StorefrontGateway(), {
      env: {
        CACHE: { get: kvGet },
        SCALIUS_SECRET: "storefront-test-master-secret-with-enough-length-0123456789",
        BACKEND_API: { fetch: apiFetch },
        CF_VERSION_METADATA: { id: "version-a", tag: "", timestamp: "" },
      } as unknown as Env,
      ctx: { waitUntil } as unknown as ExecutionContext,
    });
    handle.mockClear();

    const response = await worker.fetch(new Request("https://shop.example/products/fish?utm_source=fb"));

    expect(await response.text()).toBe("cached page");
    expect(response.headers.get("X-Cache-Status")).toBe("HIT");
    expect(kvGet).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });
});


describe("storefront Worker trusted front proxy", () => {
  const MASTER_SECRET = "storefront-test-master-secret-with-enough-length-0123456789";

  async function renderThroughGateway(request: Request) {
    handle.mockClear();
    const { default: StorefrontGateway } = await import("./worker");
    const worker = Object.assign(new StorefrontGateway(), {
      env: { SCALIUS_SECRET: MASTER_SECRET } as unknown as Env,
      ctx: {} as ExecutionContext,
    });
    // POST never enters the public cache lane, so the renderer sees the request directly.
    await worker.fetch(request);
    expect(handle).toHaveBeenCalledTimes(1);
    const [seen] = handle.mock.calls[0] ?? [];
    if (!seen) throw new Error("The storefront renderer was not called.");
    return seen;
  }

  it("honours forwarded host, proto, and client IP only for a validly signed request", async () => {
    const { deriveRuntimeSecret, RUNTIME_SECRET_PURPOSES } = await import("@scalius/shared/runtime-secrets");
    const { signFrontProxyRequest, FRONT_PROXY_SIGNATURE_HEADER } = await import("@scalius/shared/trusted-front-proxy");
    const secret = await deriveRuntimeSecret(MASTER_SECRET, RUNTIME_SECRET_PURPOSES.FRONT_PROXY_SECRET);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signFrontProxyRequest(secret, {
      timestamp,
      proto: "https",
      host: "shop.example.com",
      pathname: "/cart",
      clientIp: "203.0.113.9",
    });
    const headers = {
      "X-Forwarded-Host": "shop.example.com",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "203.0.113.9",
      "cf-connecting-ip": "10.0.0.1",
    };

    const signed = await renderThroughGateway(new Request("https://internal.workers.dev/cart", {
      method: "POST",
      headers: { ...headers, [FRONT_PROXY_SIGNATURE_HEADER]: signature },
    }));
    expect(signed.url).toBe("https://shop.example.com/cart");
    expect(signed.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(signed.headers.has(FRONT_PROXY_SIGNATURE_HEADER)).toBe(false);

    const forged = await renderThroughGateway(new Request("https://internal.workers.dev/cart", {
      method: "POST",
      headers: { ...headers, [FRONT_PROXY_SIGNATURE_HEADER]: `v1,t=${timestamp},s=forged` },
    }));
    expect(forged.url).toBe("https://internal.workers.dev/cart");
    expect(forged.headers.get("cf-connecting-ip")).toBe("10.0.0.1");
    expect(forged.headers.has(FRONT_PROXY_SIGNATURE_HEADER)).toBe(false);

    const unsigned = await renderThroughGateway(new Request("https://internal.workers.dev/cart", {
      method: "POST",
      headers,
    }));
    expect(unsigned.url).toBe("https://internal.workers.dev/cart");
    expect(unsigned.headers.get("cf-connecting-ip")).toBe("10.0.0.1");
  });
});
