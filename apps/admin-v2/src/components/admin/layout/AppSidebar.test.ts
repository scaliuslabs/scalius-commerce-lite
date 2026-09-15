import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AppSidebar navigation performance", () => {
  it("bounds data warming to explicit list links and warms only code elsewhere", () => {
    const source = readFileSync(new URL("./AppSidebar.tsx", import.meta.url), "utf8");
    const warmupSource = readFileSync(
      new URL("./admin-route-chunk-warming.ts", import.meta.url),
      "utf8",
    );
    const dataPreloadStart = source.indexOf("const DATA_PRELOAD_PATHS");
    const dataPreloadBlock = source.slice(
      dataPreloadStart,
      source.indexOf("]);", dataPreloadStart) + 3,
    );
    const dataPreloadPaths = [...dataPreloadBlock.matchAll(/"([^"]+)"/g)].map(
      ([, path]) => path,
    );

    expect(warmupSource).toContain("router.loadRouteChunk(match)");
    expect(warmupSource).toContain("currentRoute = currentRoute.parentRoute");
    expect(source).toContain('preload: "intent" as const');
    expect(source).toContain("ROUTE_DATA_PRELOAD_DELAY_MS = 125");
    expect(dataPreloadPaths).toEqual([
      "/admin/products",
      "/admin/categories",
      "/admin/collections",
      "/admin/orders",
      "/admin/customers",
      "/admin/discounts",
      "/admin/pages",
    ]);
    expect(source).toContain("preload: false as const");
    expect(source).not.toContain("router.preloadRoute");
    expect(warmupSource).not.toContain("router.preloadRoute");
    expect(warmupSource).not.toContain("queryClient");
    expect(warmupSource).not.toContain("fetch(");
    expect(source).toContain("onMouseEnter: start");
    expect(source).toContain("onTouchStart:");
    expect(source).toContain("data-[transitioning]:bg-");
  });
});
