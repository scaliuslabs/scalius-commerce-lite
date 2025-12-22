// src/middleware.ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/astro/server";
import { defineMiddleware, sequence } from "astro:middleware";
import { setPageCspHeader } from "@/lib/middleware-helper/csp-handler";
import { invalidateHonoCacheIfNeeded } from "@/lib/middleware-helper/hono-cache-invalidator";

// API routes that need authentication
const isProtectedApiRoute = createRouteMatcher([
  "/api/admin/(.*)",
  "/api/admin/abandoned-checkouts(.*)",
  "/api/analytics(.*)",
  "/api/categories(.*)",
  "/api/attributes(.*)",
  "/api/collections(.*)",
  "/api/customers(.*)",
  "/api/dashboard(.*)",
  "/api/discounts(.*)",
  "/api/media(.*)",
  "/api/navigation(.*)",
  "/api/orders(.*)",
  "/api/pages(.*)",
  "/api/products(.*)",
  "/api/search(.*)",
  "/api/settings(.*)",
  "/api/shipments(.*)",
  "/api/system-prompt(.*)",
  "/api/widgets(.*)",
]);

// Admin pages that need authentication and org gating
const isAdminRoute = createRouteMatcher(["/admin(.*)"]);

// Create auth middleware (Clerk)
const authMiddleware = defineMiddleware(async (context, next) => {
  const request = context.request;
  const url = new URL(request.url);

  // Skip Hono API routes - they have their own auth
  if (url.pathname.startsWith("/api/v1")) {
    const response = await next();
    return response || new Response();
  }

  // Single clerkMiddleware execution for all routes
  const clerkResponse = await clerkMiddleware()(context as any, async () => {
    const auth = context.locals.auth?.();
    const { redirectToSignIn, userId } = auth || {};

    // Handle protected API routes
    if (isProtectedApiRoute(request) && url.pathname.startsWith("/api/")) {
      if (!auth || !userId) {
        return new Response(
          JSON.stringify({
            error: "Unauthorized",
            message: "Authentication required to access this endpoint",
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const allowedOrgId = process.env.CLERK_ALLOWED_ORG_ID || "";
      if (allowedOrgId) {
        const activeOrgId =
          (auth as any).orgId || (auth as any).sessionClaims?.["org_id"];
        if (!activeOrgId || activeOrgId !== allowedOrgId) {
          return new Response(
            JSON.stringify({
              error: "Forbidden",
              message: "Organization not allowed for this deployment",
            }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      const response = await next();
      return response || new Response();
    }

    // Handle admin routes
    if (isAdminRoute(request)) {
      if (!userId) {
        return redirectToSignIn ? redirectToSignIn() : context.redirect("/");
      }

      const allowedOrgId = process.env.CLERK_ALLOWED_ORG_ID || "";
      if (allowedOrgId) {
        const activeOrgId =
          (auth as any).orgId || (auth as any).sessionClaims?.["org_id"];
        if (activeOrgId && activeOrgId !== allowedOrgId) {
          return new Response(
            "Forbidden: Wrong organization for this deployment.",
            { status: 403 },
          );
        }
      }

      const response = await next();
      return response || new Response();
    }

    // All other routes - just continue
    const response = await next();
    return response || new Response();
  });

  return clerkResponse || new Response();
});

const cspMiddleware = defineMiddleware(async (context, next) => {
  const response = await next();
  const url = new URL(context.request.url);

  if (!url.pathname.startsWith("/api/")) {
    return setPageCspHeader(response);
  }

  return response;
});

const honoCacheInvalidationMiddleware = defineMiddleware(
  async (context, next) => {
    // First, let the request go to the endpoint and get the response
    const response = await next(); 
    
    // MODIFIED: Pass the entire context object to the invalidator
    // This gives it access to `waitUntil` from the Cloudflare runtime
    await invalidateHonoCacheIfNeeded(context, response); 

    return response;
  },
);

export const onRequest = sequence(
  authMiddleware,
  cspMiddleware,
  honoCacheInvalidationMiddleware,
);