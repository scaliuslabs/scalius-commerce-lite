export type PublicRuntimeGroup = "config" | "catalog" | "content" | "buyer" | "proxy";

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function classifyPublicRuntimePath(pathname: string): PublicRuntimeGroup | null {
  if (
    matchesPrefix(pathname, "/api/v1/storefront/agent-contexts") ||
    matchesPrefix(pathname, "/api/v1/storefront/agent-continuations")
  ) return "buyer";
  if (matchesPrefix(pathname, "/api/v1/__ptproxy")) return "proxy";
  if (
    pathname === "/api/v1" || pathname === "/api/v1/" ||
    ["hero", "header", "navigation", "footer", "storefront", "checkout-languages", "locations", "shipping-methods", "seo"]
      .some((segment) => matchesPrefix(pathname, `/api/v1/${segment}`))
  ) return "config";
  if (
    ["attributes", "collections", "search", "products", "categories", "media"]
      .some((segment) => matchesPrefix(pathname, `/api/v1/${segment}`))
  ) return "catalog";
  if (["pages", "articles"].some((segment) =>
    matchesPrefix(pathname, `/api/v1/${segment}`)
  )) return "content";
  if (
    ["discounts", "analytics", "meta", "checkout", "customer-auth", "abandoned-checkouts", "orders"]
      .some((segment) => matchesPrefix(pathname, `/api/v1/${segment}`))
  ) return "buyer";
  return null;
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
    case "proxy": {
      const { default: app } = await import("./public-proxy-app");
      return app.fetch(request, env, ctx);
    }
    default:
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      });
  }
}

export default { fetch: fetchPublicApiApp };
