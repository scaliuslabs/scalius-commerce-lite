import { classifyRouteGroup, ROUTE_GROUP_FAMILIES, type RuntimeAppName } from "./route-table";

export type { RuntimeAppName } from "./route-table";

/** The family serving a path, from the mount table; unknown paths load no route graph. */
export function classifyRuntimeApiPath(pathname: string): RuntimeAppName | null {
  const group = classifyRouteGroup(pathname);
  return group ? ROUTE_GROUP_FAMILIES[group] : null;
}

export async function fetchRuntimeApiApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/v1/health" || pathname === "/api/v1/health/") {
    return Response.json({ status: "ok", timestamp: new Date().toISOString() });
  }

  const family = classifyRuntimeApiPath(pathname);
  if (!family) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  switch (family) {
    case "probe": {
      const { default: app } = await import("./probe-app");
      return app.fetch(request, env, ctx);
    }
    case "admin": {
      const { default: app } = await import("./admin-app");
      return app.fetch(request, env, ctx);
    }
    case "system": {
      const { default: app } = await import("./system-app");
      return app.fetch(request, env, ctx);
    }
    case "docs": {
      const { default: app } = await import("./docs-app");
      return app.fetch(request, env, ctx);
    }
    case "public": {
      const { default: app } = await import("./public-app");
      return app.fetch(request, env, ctx);
    }
    case "plugins": {
      const { default: app } = await import("./plugins-app");
      return app.fetch(request, env, ctx);
    }
  }
}
