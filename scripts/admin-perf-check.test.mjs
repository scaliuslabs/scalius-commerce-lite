import { describe, expect, it } from "vitest";
import {
  BUNDLE_BUDGETS,
  componentChunksByRoute,
  measureRoutes,
  parseAdminPerfCheckArgs,
  parseRouteTree,
  routeAncestry,
  staticClosure,
  validateBundleReport,
} from "./admin-perf-check.mjs";
import { validateRuntimeReport, waterfallDepth } from "./admin-perf-runtime.mjs";

const ROUTES = "/repo/apps/admin-v2/src/routes";

const ROUTE_TREE = `
import { Route as rootRouteImport } from './routes/__root'
import { Route as AdminRouteImport } from './routes/admin'
import { Route as AdminOrdersListRouteImport } from './routes/admin/orders/_list'
import { Route as AdminOrdersListIndexRouteImport } from './routes/admin/orders/_list/index'
import { Route as ScannerRouteImport } from './routes/scanner'

const AdminRoute = AdminRouteImport.update({
  id: '/admin',
  path: '/admin',
  getParentRoute: () => rootRouteImport,
} as any)
const ScannerRoute = ScannerRouteImport.update({
  id: '/scanner',
  path: '/scanner',
  getParentRoute: () => rootRouteImport,
} as any)
const AdminOrdersListRoute = AdminOrdersListRouteImport.update({
  id: '/orders/_list',
  path: '/orders',
  getParentRoute: () => AdminRoute,
} as any)
const AdminOrdersListIndexRoute =
  AdminOrdersListIndexRouteImport.update({
    id: '/',
    path: '/',
    getParentRoute: () => AdminOrdersListRoute,
  } as any)
`;

const chunk = (fileName, { imports = [], moduleIds = [], isEntry = false } = {}) => ({ fileName, imports, moduleIds, isEntry });

function fixtureChunks() {
  return [
    chunk("index.js", { isEntry: true, imports: ["runtime.js"], moduleIds: [`${ROUTES}/admin/orders/_list/index.tsx`] }),
    chunk("runtime.js"),
    chunk("admin.js", { imports: ["ui.js"], moduleIds: [`${ROUTES}/admin.tsx?tsr-split=component`] }),
    chunk("ui.js"),
    chunk("list.js", { imports: ["table.js"], moduleIds: [`${ROUTES}/admin/orders/_list/index.tsx?tsr-split=component`] }),
    chunk("list-error.js", { moduleIds: [`${ROUTES}/admin/orders/_list/index.tsx?tsr-split=errorComponent`] }),
    chunk("table.js", { moduleIds: ["/repo/node_modules/@tanstack/table-core/index.js"] }),
    chunk("scanner.js", { imports: ["qr.js"], moduleIds: [`${ROUTES}/scanner.tsx?tsr-split=component`] }),
    chunk("qr.js", { moduleIds: ["/repo/node_modules/html5-qrcode/esm/index.js"] }),
  ];
}

const sizes = { "index.js": 100, "runtime.js": 1, "admin.js": 10, "ui.js": 5, "list.js": 20, "list-error.js": 1, "table.js": 30, "scanner.js": 4, "qr.js": 80 };
const brotliBytes = (file) => sizes[file] * 1024;

describe("admin perf check: route bundles", () => {
  it("reads each route's parent from the generated route tree, multi-line updates included", () => {
    const parents = parseRouteTree(ROUTE_TREE);
    expect(parents.get("admin.tsx")).toBeNull();
    expect(parents.get("admin/orders/_list.tsx")).toBe("admin.tsx");
    expect(parents.get("admin/orders/_list/index.tsx")).toBe("admin/orders/_list.tsx");
    expect(routeAncestry("admin/orders/_list/index.tsx", parents)).toEqual([
      "admin.tsx",
      "admin/orders/_list.tsx",
      "admin/orders/_list/index.tsx",
    ]);
  });

  it("maps page components, not error components, to their route", () => {
    const byRoute = componentChunksByRoute(fixtureChunks(), ROUTES);
    expect(byRoute.get("admin/orders/_list/index.tsx")).toEqual(["list.js"]);
    expect(byRoute.get("admin.tsx")).toEqual(["admin.js"]);
  });

  it("follows static imports only", () => {
    const byName = new Map(fixtureChunks().map((item) => [item.fileName, item]));
    expect([...staticClosure(["list.js"], byName)].sort()).toEqual(["list.js", "table.js"]);
  });

  it("counts the entry, the layouts' and the page's own chunks for a route's first render", () => {
    const report = measureRoutes({ chunks: fixtureChunks(), parentByFile: parseRouteTree(ROUTE_TREE), routesDir: ROUTES, brotliBytes });
    const list = report.routes.find((route) => route.route === "admin/orders/_list/index.tsx");
    expect(report.entry.brotliBytes).toBe(101 * 1024);
    // index + runtime + admin + ui + list + table; the error chunk loads only on error.
    expect(list.brotliBytes).toBe(166 * 1024);
    expect(list.files).toBe(6);
    expect(list.lazyOnly).toEqual([]);
    expect(report.routes.find((route) => route.route === "scanner.tsx").lazyOnly).toEqual([]);
  });

  it("fails a route over budget, a lazy-only library on first render, and a stale budget entry", () => {
    const chunks = fixtureChunks();
    chunks.find((item) => item.fileName === "list.js").imports.push("qr.js");
    const report = measureRoutes({ chunks, parentByFile: parseRouteTree(ROUTE_TREE), routesDir: ROUTES, brotliBytes });
    const failures = validateBundleReport(report, {
      ...BUNDLE_BUDGETS,
      entry: 100,
      routes: { "admin/orders/_list/index.tsx": 200, "admin/gone.tsx": 100 },
    });
    expect(failures).toEqual(expect.arrayContaining([
      expect.stringContaining("entry chunk is 101.0 KiB"),
      expect.stringContaining("admin/orders/_list/index.tsx needs 246.0 KiB"),
      expect.stringContaining("admin/orders/_list/index.tsx loads html5-qrcode"),
      "budgeted route admin/gone.tsx no longer exists",
    ]));
  });
});

describe("admin perf check: runtime", () => {
  it("measures how many API round trips had to wait for another", () => {
    expect(waterfallDepth([])).toBe(0);
    expect(waterfallDepth([{ start: 0, end: 10 }, { start: 1, end: 12 }])).toBe(1);
    expect(waterfallDepth([{ start: 0, end: 10 }, { start: 11, end: 20 }, { start: 12, end: 30 }, { start: 21, end: 25 }])).toBe(3);
  });

  it("holds first load, transitions and typing to their budgets", () => {
    const failures = validateRuntimeReport({
      firstLoad: { cold: { ok: true, ready: 1600 } },
      transitions: [
        { pass: "cold", name: "Home → Orders", ok: true, ms: 380 },
        { pass: "warm", name: "Home → Orders", ok: true, ms: 170 },
        { pass: "cold", name: "Orders → Order", ok: false, error: "link not found: tbody a" },
      ],
      typing: { maxMs: 60 },
    });
    expect(failures).toEqual([
      "first load ready 1600ms (budget 1500ms)",
      "warm Home → Orders: 170ms (budget 150ms)",
      "cold Orders → Order: link not found: tbody a",
      "product editor keystroke 60ms (budget 50ms)",
    ]);
  });

  it("refuses to drive anything but a local dashboard", () => {
    expect(() => parseAdminPerfCheckArgs(["--runtime", "--admin", "https://dashboard.scalius.com"])).toThrow(/local dashboard/);
    expect(parseAdminPerfCheckArgs(["--runtime", "--admin", "http://localhost:4323", "--cpu", "4"])).toMatchObject({ runtime: true, cpu: 4, check: true });
  });
});
