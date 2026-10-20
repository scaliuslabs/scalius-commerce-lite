// The plugin route group (/api/v1/plugins/*): installed apps' admin, public
// and webhook routes (plugins/routes.ts). Not part of the OpenAPI contract:
// each app declares its own routes in its manifest.
import { buildRouteGroupApp } from "./route-groups";
import { createPluginRoutes } from "../plugins/routes";

export default buildRouteGroupApp("plugins", {
  routers: { pluginRoutes: createPluginRoutes() },
  middleware: {},
});
