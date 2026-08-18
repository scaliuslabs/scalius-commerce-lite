import { createRuntimeApiApp } from "./base-app";
import { registerProbeRoutes } from "./register-probe-routes";

const app = createRuntimeApiApp();
registerProbeRoutes(app);

export default app;
