import { describe, expect, it } from "vitest";
import contractApp from "../app";
import adminAccessApp, { adminAccessParts } from "./admin-access-app";
import { classifyAdminRuntimePath, type AdminRuntimeGroup } from "./admin-app";
import adminCatalogApp, { adminCatalogParts } from "./admin-catalog-app";
import adminContentApp, { adminContentParts } from "./admin-content-app";
import adminDashboardApp, { adminDashboardParts } from "./admin-dashboard-app";
import adminSalesApp, { adminSalesParts } from "./admin-sales-app";
import docsApp, { docsParts } from "./docs-app";
import { classifyRuntimeApiPath, type RuntimeAppName } from "./fetch-runtime-app";
import probeApp, { probeParts } from "./probe-app";
import { classifyPublicRuntimePath, type PublicRuntimeGroup } from "./public-app";
import publicBuyerApp, { publicBuyerParts } from "./public-buyer-app";
import publicCatalogApp, { publicCatalogParts } from "./public-catalog-app";
import publicConfigApp, { publicConfigParts } from "./public-config-app";
import publicContentApp, { publicContentParts } from "./public-content-app";
import systemApp, { systemParts } from "./system-app";
import { classifyRouteGroup, isMountStep, ROUTE_TABLE, type RouteGroup, type RouteStep } from "./route-table";

type HonoRoute = { method: string; path: string; handler: unknown };
type RoutedApp = { routes: HonoRoute[] };

function concreteRoutes(app: RoutedApp): Set<string> {
  return new Set(
    app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  );
}

const groups: ReadonlyArray<readonly [RouteGroup, RoutedApp, { middleware: object }]> = [
  ["probe", probeApp, probeParts],
  ["docs", docsApp, docsParts],
  ["system", systemApp, systemParts],
  ["public-config", publicConfigApp, publicConfigParts],
  ["public-catalog", publicCatalogApp, publicCatalogParts],
  ["public-content", publicContentApp, publicContentParts],
  ["public-buyer", publicBuyerApp, publicBuyerParts],
  ["admin-dashboard", adminDashboardApp, adminDashboardParts],
  ["admin-catalog", adminCatalogApp, adminCatalogParts],
  ["admin-sales", adminSalesApp, adminSalesParts],
  ["admin-content", adminContentApp, adminContentParts],
  ["admin-access", adminAccessApp, adminAccessParts],
];

/** Every table middleware implementation, by function. */
const MIDDLEWARE_IDS = new Map<unknown, string>(
  groups.flatMap(([, , parts]) => Object.entries(parts.middleware).map(([id, handler]) => [handler, id] as const)),
);

/** The table middleware an app runs: `pattern middleware-id`, in registration order. */
function tableMiddleware(app: RoutedApp): string[] {
  return app.routes
    .filter((route) => route.method === "ALL" && MIDDLEWARE_IDS.has(route.handler))
    .map((route) => `${route.path} ${MIDDLEWARE_IDS.get(route.handler)}`);
}

describe("runtime API route groups", () => {
  it("owns every concrete contract-app route exactly once, in the group Worker entry picks", () => {
    const fullRoutes = concreteRoutes(contractApp);
    const owners = new Map<string, RouteGroup[]>();

    for (const [group, app] of groups) {
      for (const route of concreteRoutes(app)) {
        owners.set(route, [...(owners.get(route) ?? []), group]);
      }
    }

    expect(new Set(owners.keys())).toEqual(fullRoutes);
    for (const [route, owning] of owners) {
      expect(owning, route).toHaveLength(1);
      const pathname = route.slice(route.indexOf(" ") + 1);
      expect(classifyRouteGroup(pathname), route).toBe(owning[0]);
    }
  });

  it("guards every path with the same middleware in production as in the contract app", () => {
    const contract = tableMiddleware(contractApp);
    const production = new Set(groups.flatMap(([, app]) => tableMiddleware(app)));
    // The contract app registers each table middleware once; every group runs it on the same pattern.
    expect(new Set(contract)).toEqual(production);
    expect(contract).toHaveLength(new Set(contract).size);
    // Every admin group runs the dashboard middleware on /admin/*, in the table's order.
    const admin = ["privateNoStore", "dashboardOriginGuard", "adminAuth", "commitSeq", "idempotentReplay"]
      .map((id) => `/api/v1/admin/* ${id}`);
    for (const [group, app] of groups) {
      if (group.startsWith("admin-")) expect(tableMiddleware(app), group).toEqual(admin);
    }
    expect(contract.filter((entry) => entry.startsWith("/api/v1/admin/"))).toEqual(admin);
  });

  it("names every router once and mounts it in exactly one group", () => {
    const routers = (ROUTE_TABLE as readonly RouteStep[]).filter(isMountStep).map((step) => step.router);
    expect(routers).toHaveLength(new Set(routers).size);
  });

  it("uses boundary-safe paths and loads no family for unknown routes", () => {
    expect(classifyRuntimeApiPath("/api/v1/health/")).toBe("probe");
    expect(classifyRuntimeApiPath("/api/v1/meta")).toBe("probe");
    expect(classifyRuntimeApiPath("/api/v1/meta/events")).toBe("public");
    expect(classifyRuntimeApiPath("/api/v1/openapi.json")).toBe("docs");
    expect(classifyRuntimeApiPath("/api/v1/docs")).toBeNull();
    expect(classifyRuntimeApiPath("/api/v1/")).toBe("public");
    expect(classifyRuntimeApiPath("/api/v1/plugins/app/route")).toBe("plugins");
    expect(classifyRuntimeApiPath("/api/v1/administer")).toBeNull();
    expect(classifyRuntimeApiPath("/api/v1/authentic")).toBeNull();
    expect(classifyRuntimeApiPath("/api/v1/admin/unknown")).toBeNull();
    expect(classifyAdminRuntimePath("/api/v1/admin/unknown")).toBeNull();
    expect(classifyAdminRuntimePath("/api/v1/admin")).toBe("dashboard");
    expect(classifyAdminRuntimePath("/api/v1/admin/")).toBe("dashboard");
    expect(classifyRuntimeApiPath("/not-api/v1/products")).toBeNull();
  });

  it("classifies every public and admin route into its exact lazy subgroup", () => {
    for (const [group, app] of groups) {
      for (const route of concreteRoutes(app)) {
        const pathname = route.slice(route.indexOf(" ") + 1);
        if (group.startsWith("public-")) {
          expect(classifyPublicRuntimePath(pathname), route).toBe(group.slice("public-".length) as PublicRuntimeGroup);
        }
        if (group.startsWith("admin-")) {
          expect(classifyAdminRuntimePath(pathname), route).toBe(group.slice("admin-".length) as AdminRuntimeGroup);
        }
        expect(classifyRuntimeApiPath(pathname), route).toBe(familyOf(group));
      }
    }
  });
});

function familyOf(group: RouteGroup): RuntimeAppName {
  return group.startsWith("public-") ? "public" : group.startsWith("admin-") ? "admin" : group as RuntimeAppName;
}
