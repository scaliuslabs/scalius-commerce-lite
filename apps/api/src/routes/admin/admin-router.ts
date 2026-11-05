// Every dashboard API router (everything mounted under /api/v1/admin) is
// built here, so each JSON write it registers refuses the keys its body
// schema would drop instead of answering 200 and saving nothing
// (`utils/unknown-body-fields.ts`). The guard travels with the route: the
// production route groups, the contract app, a test that mounts the router
// alone and the agent confirmation probe all run it.
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { STABLE_OPERATION_IDS } from "@scalius/shared/plugins/app-operations";
import { unknownBodyFieldGuard, type UnknownFieldScope } from "../../utils/unknown-body-fields";

const JSON_MEDIA_TYPE = /^application\/([a-z-.]+\+)?json/i;

/** The route's JSON body schema, when it takes one. */
export function jsonBodySchema(route: Pick<RouteConfig, "request">): unknown {
  const content = route.request?.body?.content ?? {};
  for (const [mediaType, entry] of Object.entries(content)) {
    if (JSON_MEDIA_TYPE.test(mediaType) && entry && "schema" in entry && entry.schema) return entry.schema;
  }
  return undefined;
}

/**
 * How far a route refuses unknown keys: the sealed stable app operations only
 * at the top level (their nested objects stay as sealed), every other route
 * at every depth.
 */
export function unknownFieldScope(route: Pick<RouteConfig, "operationId">): UnknownFieldScope {
  return route.operationId && STABLE_OPERATION_IDS.has(route.operationId) ? "top-level" : "deep";
}

/** The route with the unknown-key guard first in its own middleware, when it takes a JSON body. */
export function withUnknownFieldGuard<R extends RouteConfig>(route: R): R {
  const method = route.method.toLowerCase();
  if (method === "get" || method === "head") return route;
  const schema = jsonBodySchema(route);
  if (schema === undefined) return route;
  const own = route.middleware === undefined ? [] : Array.isArray(route.middleware) ? route.middleware : [route.middleware];
  const guard: MiddlewareHandler = unknownBodyFieldGuard(schema, unknownFieldScope(route));
  return { ...route, middleware: [guard, ...own] };
}

/** A dashboard API router whose JSON writes refuse unknown keys. */
export function adminRouter(): OpenAPIHono<{ Bindings: Env }> {
  const app = new OpenAPIHono<{ Bindings: Env }>();
  const register = app.openapi;
  app.openapi = ((route: RouteConfig, ...rest: unknown[]) =>
    (register as (...args: unknown[]) => unknown)(withUnknownFieldGuard(route), ...rest)) as typeof app.openapi;
  return app;
}
