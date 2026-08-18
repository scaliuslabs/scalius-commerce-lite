import { describe, expect, it } from "vitest";
import contractApp from "../app";
import adminApp from "./admin-app";
import docsApp from "./docs-app";
import { classifyRuntimeApiPath, type RuntimeAppName } from "./fetch-runtime-app";
import probeApp from "./probe-app";
import publicApp from "./public-app";
import systemApp from "./system-app";

type HonoRoute = { method: string; path: string };

function concreteRoutes(app: { routes: HonoRoute[] }): Set<string> {
  return new Set(
    app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  );
}

const runtimeApps: ReadonlyArray<readonly [RuntimeAppName, { routes: HonoRoute[] }]> = [
  ["probe", probeApp],
  ["public", publicApp],
  ["admin", adminApp],
  ["system", systemApp],
  ["docs", docsApp],
];

describe("runtime API route families", () => {
  it("owns every concrete contract-app route exactly once", () => {
    const fullRoutes = concreteRoutes(contractApp);
    const owners = new Map<string, RuntimeAppName[]>();

    for (const [family, app] of runtimeApps) {
      for (const route of concreteRoutes(app)) {
        owners.set(route, [...(owners.get(route) ?? []), family]);
      }
    }

    expect(new Set(owners.keys())).toEqual(fullRoutes);
    for (const [route, families] of owners) {
      expect(families, route).toHaveLength(1);
      const pathname = route.slice(route.indexOf(" ") + 1);
      expect(classifyRuntimeApiPath(pathname), route).toBe(families[0]);
    }
  });

  it("uses boundary-safe paths and loads no family for unknown routes", () => {
    expect(classifyRuntimeApiPath("/api/v1/health/")).toBe("probe");
    expect(classifyRuntimeApiPath("/api/v1/docs/")).toBe("docs");
    expect(classifyRuntimeApiPath("/api/v1/")).toBe("public");
    expect(classifyRuntimeApiPath("/api/v1/administer")).toBeNull();
    expect(classifyRuntimeApiPath("/api/v1/authentic")).toBeNull();
    expect(classifyRuntimeApiPath("/not-api/v1/products")).toBeNull();
  });
});
