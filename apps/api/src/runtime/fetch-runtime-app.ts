export type RuntimeAppName = "probe" | "public" | "admin" | "system" | "docs";

const PUBLIC_PREFIXES = [
  "/api/v1/abandoned-checkouts",
  "/api/v1/analytics",
  "/api/v1/articles",
  "/api/v1/attributes",
  "/api/v1/categories",
  "/api/v1/checkout",
  "/api/v1/checkout-languages",
  "/api/v1/collections",
  "/api/v1/customer-auth",
  "/api/v1/discounts",
  "/api/v1/footer",
  "/api/v1/header",
  "/api/v1/hero",
  "/api/v1/locations",
  "/api/v1/media",
  "/api/v1/meta",
  "/api/v1/navigation",
  "/api/v1/orders",
  "/api/v1/pages",
  "/api/v1/products",
  "/api/v1/search",
  "/api/v1/seo",
  "/api/v1/shipping-methods",
  "/api/v1/storefront",
  "/api/v1/__ptproxy",
] as const;

const SYSTEM_PREFIXES = [
  "/api/v1/agent-artifacts",
  "/api/v1/agent-auth",
  "/api/v1/auth",
  "/api/v1/cache",
  "/api/v1/payment",
  "/api/v1/setup",
  "/api/v1/webhooks",
] as const;

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Classifies only real API route families; unknown paths load no route graph. */
export function classifyRuntimeApiPath(pathname: string): RuntimeAppName | null {
  if (pathname === "/api/v1" || pathname === "/api/v1/") return "public";
  if (
    pathname === "/api/v1/health" || pathname === "/api/v1/health/" ||
    pathname === "/api/v1/readyz" || pathname === "/api/v1/readyz/"
  ) return "probe";
  if (
    pathname === "/api/v1/docs" || pathname === "/api/v1/docs/" ||
    pathname === "/api/v1/openapi.json"
  ) return "docs";
  if (matchesPathPrefix(pathname, "/api/v1/admin")) return "admin";
  if (SYSTEM_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix))) {
    return "system";
  }
  if (PUBLIC_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix))) {
    return "public";
  }
  return null;
}

export async function fetchRuntimeApiApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/v1/health" || pathname === "/api/v1/health/") {
    return Response.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      cache: {
        type: "kv",
        size: -1,
        memory: "N/A (Cloudflare KV managed)",
        uptime: "N/A (Cloudflare KV managed)",
      },
    });
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
  }
}
