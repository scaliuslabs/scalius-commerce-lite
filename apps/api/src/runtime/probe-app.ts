import { Hono } from "hono";
import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { metaRoutes } from "../routes/meta";
import { readinessRoutes } from "../routes/readiness";

/** GET /api/v1/health (Worker entry answers it first; the contract documents it here). */
const healthRoutes = new Hono<{ Bindings: Env }>().get("/", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }));

export const probeParts: RouteGroupParts<"probe"> = {
  routers: { metaRoutes, healthRoutes, readinessRoutes },
  middleware: {},
};

export default buildRouteGroupApp("probe", probeParts);
