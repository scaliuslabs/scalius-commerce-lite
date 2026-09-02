import { describe, expect, it, vi } from "vitest";

vi.mock("@astrojs/cloudflare/handler", () => ({ handle: vi.fn() }));
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
