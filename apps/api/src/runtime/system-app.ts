import { createRuntimeApiApp } from "./base-app";
import { registerSystemRoutes } from "./register-system-routes";

const app = createRuntimeApiApp();
registerSystemRoutes(app);

export default app;
