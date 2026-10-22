// An agent's gated change is checked against the route's own request
// validation before anyone is asked to approve it (black-box M7): the admin
// boundary runs before the route's validators, so without this a request the
// route would refuse (a wrong body, an unknown property, a wrong content type)
// first cost the merchant an approval and then failed on the replay.
//
// Nothing here is a second copy of a schema. The route's own definition
// (the `createRoute` config every OpenAPIHono router keeps in its registry)
// is mounted on a one-route probe app whose handler only answers 204, so
// `@hono/zod-openapi` builds exactly the validators the real route runs (path,
// query, headers, the media-type gate and the JSON or form body) from the
// same zod schemas. The agent lanes' declared-body-property rule (the same
// `unknown_body_property` MCP dispatch and the CLI apply) comes from the
// operation manifest the contract generates.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { mergePath } from "hono/utils/url";
import type { AgentOperationPolicy } from "../openapi/agent-operation-manifest";
import { errorResponseFromError } from "../utils/api-response";
import { AppError } from "../utils/api-error";
import { AgentDispatchError } from "./dispatch-error";

type RouteDefinition = {
  type: string;
  route?: { operationId?: string; method?: string; path?: string; [key: string]: unknown };
};
type RegistryBearer = { openAPIRegistry?: { definitions?: readonly RouteDefinition[] }; _basePath?: string };

/** Every router is mounted under the API's base path (runtime/base-app.ts). */
const API_BASE_PATH = "/api/v1";

// Mounted routers (code, not store state): the route table registers each
// one it mounts, and the operation index is built on first use.
const mountedRouters: Array<{ router: RegistryBearer; mount: string; indexed: boolean }> = [];
const routesById = new Map<string, Record<string, unknown>>();
const routesByPath = new Map<string, Record<string, unknown>>();
const probes = new Map<string, OpenAPIHono>();

/** Called by the route table for every router it mounts at `mount` (route-groups.ts). */
export function registerMountedRouter(router: unknown, mount: string): void {
  if (typeof router === "object" && router !== null && "openAPIRegistry" in router) {
    if (!mountedRouters.some((entry) => entry.router === router && entry.mount === mount)) {
      mountedRouters.push({ router: router as RegistryBearer, mount, indexed: false });
    }
  }
}

/**
 * The route definition (`createRoute` config) that serves an operation, from
 * the mounted routers: by its declared operation id, or, for a route that
 * declares none (the contract names it), by its method and full path, joined
 * exactly as the OpenAPI document joins them.
 */
export function routeConfigForOperation(
  operationId: string,
  operation?: Pick<AgentOperationPolicy, "method" | "pathTemplate">,
): Record<string, unknown> | null {
  for (const entry of mountedRouters) {
    const { router, mount } = entry;
    if (entry.indexed) continue;
    for (const definition of router.openAPIRegistry?.definitions ?? []) {
      const route = definition.type === "route" ? definition.route : undefined;
      if (!route) continue;
      // The first registration wins, as it does in Hono's router.
      if (route.operationId && !routesById.has(route.operationId)) routesById.set(route.operationId, route);
      if (route.method && route.path) {
        const path = mergePath(API_BASE_PATH, mount, router._basePath ?? "/", route.path);
        const key = `${route.method.toUpperCase()} ${path}`;
        if (!routesByPath.has(key)) routesByPath.set(key, route);
      }
    }
    entry.indexed = true;
  }
  return routesById.get(operationId)
    ?? (operation ? routesByPath.get(`${operation.method.toUpperCase()} ${operation.pathTemplate}`) ?? null : null);
}

function probeFor(operation: AgentOperationPolicy, route: Record<string, unknown>): OpenAPIHono {
  const cached = probes.get(operation.operationId);
  if (cached) return cached;
  // The route's own middleware (`middleware:`) is not request validation and never runs here.
  const { middleware: _middleware, hide: _hide, ...config } = route;
  const probe = new OpenAPIHono();
  probe.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  probe.notFound((c) => c.json({ success: false, error: { code: "not_found", message: "Not found" } }, 404));
  probe.openapi(
    { ...config, path: operation.pathTemplate, hide: true } as unknown as Parameters<OpenAPIHono["openapi"]>[0],
    ((c: Context) => c.body(null, 204)) as never,
  );
  probes.set(operation.operationId, probe);
  return probe;
}

/** What the route reads: the request's method, URL, headers and exact body bytes. */
export interface ValidatedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: ArrayBuffer | null;
  /** The JSON body, when the content type is JSON and it parsed. */
  json: unknown;
}

function refusalResponse(c: Context, error: unknown): Response {
  const { body, status } = errorResponseFromError(error);
  return c.json(body, status);
}

/**
 * The route's own refusal of this request, or null when the route would
 * accept it. Runs the declared-body-property rule, then the route's
 * validators on a copy of the request; the route handler never runs.
 */
export async function routeValidationRefusal(
  c: Context,
  operation: AgentOperationPolicy,
  request: ValidatedRequest,
): Promise<Response | null> {
  if (typeof request.json === "object" && request.json !== null && !Array.isArray(request.json)) {
    const [{ AGENT_OPERATIONS_BY_ID }, { validateAgentJsonBodyProperties }] = await Promise.all([
      import("../generated/agent-operations.gen"),
      import("./dispatch"),
    ]);
    const entry = Object.hasOwn(AGENT_OPERATIONS_BY_ID, operation.operationId)
      ? AGENT_OPERATIONS_BY_ID[operation.operationId]
      : undefined;
    if (entry) {
      try {
        validateAgentJsonBodyProperties(entry, request.json);
      } catch (error) {
        if (!(error instanceof AgentDispatchError)) throw error;
        return refusalResponse(c, new AppError(error.status, error.code, error.message));
      }
    }
  }
  const route = routeConfigForOperation(operation.operationId, operation);
  if (!route) return null;
  const verb = request.method.toUpperCase();
  const response = await probeFor(operation, route).fetch(new Request(request.url, {
    method: verb,
    headers: request.headers,
    ...(request.body !== null && verb !== "GET" && verb !== "HEAD" ? { body: request.body } : {}),
  }), c.env);
  return response.status === 204 ? null : response;
}
