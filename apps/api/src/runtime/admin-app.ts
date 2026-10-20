import { classifyRouteGroup } from "./route-table";

export type AdminRuntimeGroup = "dashboard" | "catalog" | "sales" | "content" | "access";

/** The admin group serving a path, from the mount table. */
export function classifyAdminRuntimePath(pathname: string): AdminRuntimeGroup | null {
  const group = classifyRouteGroup(pathname);
  return group?.startsWith("admin-") ? group.slice("admin-".length) as AdminRuntimeGroup : null;
}

export async function fetchAdminApiApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  switch (classifyAdminRuntimePath(new URL(request.url).pathname)) {
    case "dashboard": {
      const { default: app } = await import("./admin-dashboard-app");
      return app.fetch(request, env, ctx);
    }
    case "catalog": {
      const { default: app } = await import("./admin-catalog-app");
      return app.fetch(request, env, ctx);
    }
    case "sales": {
      const { default: app } = await import("./admin-sales-app");
      return app.fetch(request, env, ctx);
    }
    case "content": {
      const { default: app } = await import("./admin-content-app");
      return app.fetch(request, env, ctx);
    }
    case "access": {
      const { default: app } = await import("./admin-access-app");
      return app.fetch(request, env, ctx);
    }
    default:
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      });
  }
}

export default { fetch: fetchAdminApiApp };
