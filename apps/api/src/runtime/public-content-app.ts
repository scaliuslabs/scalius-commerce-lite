import { createRuntimeApiApp } from "./base-app";
import { articleRoutes } from "../routes/articles";
import { pagesRoutes } from "../routes/pages";

import { publicObjectRoutes } from "../routes/objects";

const app = createRuntimeApiApp();
app.route("/pages", pagesRoutes);
app.route("/articles", articleRoutes);
app.route("/objects", publicObjectRoutes);

export default app;
