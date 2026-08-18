import { createRuntimeApiApp } from "./base-app";
import { registerPublicRoutes } from "./register-public-routes";

const app = createRuntimeApiApp();
registerPublicRoutes(app);

export default app;
