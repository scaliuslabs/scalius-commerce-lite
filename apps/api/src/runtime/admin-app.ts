export type AdminRuntimeGroup = "dashboard" | "catalog" | "sales" | "content" | "access";

export function classifyAdminRuntimePath(pathname: string): AdminRuntimeGroup | null {
  if (pathname === "/api/v1/admin" || pathname === "/api/v1/admin/") {
    return "dashboard";
  }
  const segment = pathname.slice("/api/v1/admin/".length).split("/", 1)[0] ?? "";
  if (["dashboard", "analytics", "search", "fraud-checker", "abandoned-checkouts", "fcm-token", "fcm-token-cleanup"].includes(segment)) {
    return "dashboard";
  }
  if (["categories", "collections", "media", "inventory", "products", "attributes"].includes(segment)) {
    return "catalog";
  }
  if (["customers", "discounts", "promotions", "shipments", "orders", "taxes"].includes(segment)) {
    return "sales";
  }
  if (["pages", "navigation", "settings"].includes(segment)) return "content";
  if (["rbac", "auth", "agent-access"].includes(segment)) return "access";
  return null;
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
