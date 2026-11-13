import { apiNotFoundResponse } from "./not-found";
import { classifyRouteGroup } from "./route-table";

export type PublicRuntimeGroup = "config" | "catalog" | "content" | "buyer";

/** The public group serving a path, from the mount table. */
export function classifyPublicRuntimePath(pathname: string): PublicRuntimeGroup | null {
  const group = classifyRouteGroup(pathname);
  return group?.startsWith("public-") ? group.slice("public-".length) as PublicRuntimeGroup : null;
}

export async function fetchPublicApiApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  switch (classifyPublicRuntimePath(new URL(request.url).pathname)) {
    case "config": {
      const { default: app } = await import("./public-config-app");
      return app.fetch(request, env, ctx);
    }
    case "catalog": {
      const { default: app } = await import("./public-catalog-app");
      return app.fetch(request, env, ctx);
    }
    case "content": {
      const { default: app } = await import("./public-content-app");
      return app.fetch(request, env, ctx);
    }
    case "buyer": {
      const { default: app } = await import("./public-buyer-app");
      return app.fetch(request, env, ctx);
    }
    default:
      return apiNotFoundResponse();
  }
}

export default { fetch: fetchPublicApiApp };
