// Builds apps from the mount table (route-table.ts): a production route
// group's app, and the contract app from every group at once. Both apply the
// table's steps with this one function, so they cannot mount or guard a path
// differently.
import type { Hono, MiddlewareHandler } from "hono";
import { createRuntimeApiApp } from "./base-app";
import { registerMountedRouter } from "../agent-access/route-validation";
import {
  isMountStep,
  routeStepsOf,
  type MiddlewareId,
  type MiddlewareIdOf,
  type RouteGroup,
  type RouteStep,
  type RouterIdOf,
} from "./route-table";

// Routers are OpenAPIHono or Hono apps with their own variables; the table only mounts them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MountedRouter = Hono<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteMiddleware = MiddlewareHandler<any>;

/** What a group's module supplies: every router and middleware its steps name. */
export interface RouteGroupParts<G extends RouteGroup> {
  routers: Record<RouterIdOf<G>, MountedRouter>;
  middleware: Record<MiddlewareIdOf<G>, RouteMiddleware>;
}

/** Applies steps in order: `app.use(pattern, ...)` for middleware, `app.route(path, router)` for mounts. */
export function applyRouteSteps(
  app: MountedRouter,
  steps: readonly RouteStep[],
  routers: Readonly<Record<string, MountedRouter>>,
  middleware: Readonly<Partial<Record<MiddlewareId, RouteMiddleware>>>,
): void {
  for (const step of steps) {
    if (isMountStep(step)) {
      const router = routers[step.router];
      if (!router) throw new Error(`Route table: no router ${step.router} for ${step.mount}`);
      app.route(step.mount, router);
      // The agent confirmation gate validates a gated change with its route's own schemas.
      registerMountedRouter(router, step.mount);
      continue;
    }
    for (const id of step.middleware) {
      const handler = middleware[id];
      if (!handler) throw new Error(`Route table: no middleware ${id} for ${step.use}`);
      app.use(step.use, handler);
    }
  }
}

/** One production route group: the shared runtime shell plus its table steps. */
export function buildRouteGroupApp<G extends RouteGroup>(group: G, parts: RouteGroupParts<G>) {
  const app = createRuntimeApiApp();
  applyRouteSteps(app, routeStepsOf(group), parts.routers, parts.middleware);
  return app;
}

/**
 * The middleware of several groups as one map; a name two groups supply must
 * be the same function, or the contract app would guard a path differently.
 */
export function mergeRouteMiddleware(
  ...maps: ReadonlyArray<Readonly<Partial<Record<MiddlewareId, RouteMiddleware>>>>
): Partial<Record<MiddlewareId, RouteMiddleware>> {
  const merged: Partial<Record<MiddlewareId, RouteMiddleware>> = {};
  for (const map of maps) {
    for (const [id, handler] of Object.entries(map) as Array<[MiddlewareId, RouteMiddleware]>) {
      if (merged[id] && merged[id] !== handler) throw new Error(`Route table: middleware ${id} has two implementations`);
      merged[id] = handler;
    }
  }
  return merged;
}
