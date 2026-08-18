import { describe, expect, it } from "vitest";
import contractApp from "../app";
import adminAccessApp from "./admin-access-app";
import { classifyAdminRuntimePath, type AdminRuntimeGroup } from "./admin-app";
import adminCatalogApp from "./admin-catalog-app";
import adminContentApp from "./admin-content-app";
import adminDashboardApp from "./admin-dashboard-app";
import adminSalesApp from "./admin-sales-app";
import docsApp from "./docs-app";
import { classifyRuntimeApiPath, type RuntimeAppName } from "./fetch-runtime-app";
import probeApp from "./probe-app";
import { classifyPublicRuntimePath, type PublicRuntimeGroup } from "./public-app";
import publicBuyerApp from "./public-buyer-app";
import publicCatalogApp from "./public-catalog-app";
import publicConfigApp from "./public-config-app";
import publicContentApp from "./public-content-app";
import publicProxyApp from "./public-proxy-app";
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
  ["public", publicConfigApp],
  ["public", publicCatalogApp],
  ["public", publicContentApp],
  ["public", publicBuyerApp],
  ["public", publicProxyApp],
  ["admin", adminDashboardApp],
  ["admin", adminCatalogApp],
  ["admin", adminSalesApp],
  ["admin", adminContentApp],
  ["admin", adminAccessApp],
  ["system", systemApp],
  ["docs", docsApp],
];

const publicGroups: ReadonlyArray<readonly [PublicRuntimeGroup, { routes: HonoRoute[] }]> = [
  ["config", publicConfigApp],
  ["catalog", publicCatalogApp],
  ["content", publicContentApp],
  ["buyer", publicBuyerApp],
  ["proxy", publicProxyApp],
];

const adminGroups: ReadonlyArray<readonly [AdminRuntimeGroup, { routes: HonoRoute[] }]> = [
  ["dashboard", adminDashboardApp],
  ["catalog", adminCatalogApp],
  ["sales", adminSalesApp],
  ["content", adminContentApp],
  ["access", adminAccessApp],
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

  it("classifies every public and admin route into its exact lazy subgroup", () => {
    for (const [group, app] of publicGroups) {
      for (const route of concreteRoutes(app)) {
        const pathname = route.slice(route.indexOf(" ") + 1);
        expect(classifyPublicRuntimePath(pathname), route).toBe(group);
      }
    }
    for (const [group, app] of adminGroups) {
      for (const route of concreteRoutes(app)) {
        const pathname = route.slice(route.indexOf(" ") + 1);
        expect(classifyAdminRuntimePath(pathname), route).toBe(group);
      }
    }
  });
});
