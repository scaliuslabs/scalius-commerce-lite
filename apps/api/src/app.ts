// The contract app: every route group of the mount table (runtime/route-table.ts)
// in one OpenAPIHono graph, for `AppType`, the OpenAPI contract, the SDK and
// tests. Production serves the same table one lazily loaded group at a time
// (runtime/fetch-runtime-app.ts); both apply its steps with one function, so
// the contract app mounts and guards every path exactly as production does.

import { createContractApiApp } from "./runtime/base-app";
import { applyRouteSteps, mergeRouteMiddleware } from "./runtime/route-groups";
import { NON_CONTRACT_GROUPS, ROUTE_TABLE, type RouteStep } from "./runtime/route-table";
import { probeParts } from "./runtime/probe-app";
import { docsParts } from "./runtime/docs-app";
import { systemParts } from "./runtime/system-app";
import { publicConfigParts } from "./runtime/public-config-app";
import { publicCatalogParts } from "./runtime/public-catalog-app";
import { publicContentParts } from "./runtime/public-content-app";
import { publicBuyerParts } from "./runtime/public-buyer-app";
import { adminDashboardParts } from "./runtime/admin-dashboard-app";
import { adminCatalogParts } from "./runtime/admin-catalog-app";
import { adminSalesParts } from "./runtime/admin-sales-app";
import { adminContentParts } from "./runtime/admin-content-app";
import { adminAccessParts } from "./runtime/admin-access-app";

const PARTS = [
  probeParts,
  docsParts,
  systemParts,
  publicConfigParts,
  publicCatalogParts,
  publicContentParts,
  publicBuyerParts,
  adminDashboardParts,
  adminCatalogParts,
  adminSalesParts,
  adminContentParts,
  adminAccessParts,
] as const;

const app = createContractApiApp();

applyRouteSteps(
  app,
  (ROUTE_TABLE as readonly RouteStep[]).filter((step) => !("group" in step && step.group && NON_CONTRACT_GROUPS.has(step.group))),
  Object.assign({}, ...PARTS.map((parts) => parts.routers)),
  mergeRouteMiddleware(...PARTS.map((parts) => parts.middleware)),
);

// Register the security scheme for the OpenAPI spec
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

export type AppType = typeof app;
export default app;
