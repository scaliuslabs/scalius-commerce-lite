import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { articleRoutes } from "../routes/articles";
import { pagesRoutes } from "../routes/pages";
import { publicObjectRoutes } from "../routes/objects";

export const publicContentParts: RouteGroupParts<"public-content"> = {
  routers: { publicObjectRoutes, pagesRoutes, articleRoutes },
  middleware: {},
};

export default buildRouteGroupApp("public-content", publicContentParts);
