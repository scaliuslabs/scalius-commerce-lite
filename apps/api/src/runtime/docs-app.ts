import { createRuntimeApiApp } from "./base-app";
import { registerDocRoutes } from "./register-doc-routes";

const app = createRuntimeApiApp();
registerDocRoutes(app);

export default app;
