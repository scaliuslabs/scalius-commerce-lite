import { createRuntimeApiApp } from "./base-app";
import { registerAdminRoutes } from "./register-admin-routes";

const app = createRuntimeApiApp();
registerAdminRoutes(app);

export default app;
