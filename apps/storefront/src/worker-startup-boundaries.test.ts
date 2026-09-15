import { describe, expect, it, vi } from "vitest";

const handle = vi.hoisted(() => vi.fn(
  async (_request: Request, _env?: unknown, _ctx?: unknown) => new Response("rendered"),
));
vi.mock("@astrojs/cloudflare/handler", () => ({ handle }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

describe("storefront Worker cache runtime", () => {
  it("skips cache purges only when the runtime exposes no cache", async () => {
    const { CachedPublicStorefront } = await import("./worker");
    const withoutCache = Object.assign(new CachedPublicStorefront(), {
      ctx: {} as ExecutionContext,
    });

    await expect(withoutCache.purgeGroups(["products"])).resolves.toBeUndefined();

    const purge = vi.fn().mockResolvedValue({
      success: false,
      errors: [{ code: 1001, message: "failed" }],
    });
    const withCache = Object.assign(new CachedPublicStorefront(), {
      ctx: { cache: { purge } } as unknown as ExecutionContext,
    });

    await expect(withCache.purgeGroups(["products"])).rejects.toThrow(
      "Public storefront cache purge failed (1001)",
    );
    expect(purge).toHaveBeenCalledWith({ tags: ["products"] });
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
