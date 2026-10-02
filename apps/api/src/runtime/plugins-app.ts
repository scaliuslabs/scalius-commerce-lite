// The plugin route family (/api/v1/plugins/*): installed apps' admin, public
// and webhook routes (plugins/routes.ts). Not part of the OpenAPI contract:
// each app declares its own routes in its manifest.
import { createRuntimeApiApp } from "./base-app";
import { createPluginRoutes } from "../plugins/routes";

const app = createRuntimeApiApp();
app.route("/", createPluginRoutes());

export default app;
