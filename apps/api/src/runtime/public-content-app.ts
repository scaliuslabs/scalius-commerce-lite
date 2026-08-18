import { createRuntimeApiApp } from "./base-app";
import { articleRoutes } from "../routes/articles";
import { pagesRoutes } from "../routes/pages";

const app = createRuntimeApiApp();
app.route("/pages", pagesRoutes);
app.route("/articles", articleRoutes);

export default app;
