import { OpenAPIHono } from "@hono/zod-openapi";
import { getDb } from "@scalius/database/client";
import { withPublicMediaUrl } from "@scalius/core/integrations/storage";
import { getCorsOriginContext } from "@scalius/shared/cors-helper";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorResponseFromError, logApiError } from "../utils/api-response";
import {
  getRequestCorrelation,
  requestCorrelationMiddleware,
} from "../utils/http-correlation";

function getR2PublicUrl(env: Env, requestUrl: string): string {
  const configured = ((env.R2_PUBLIC_URL as string | undefined) || "").trim();

  try {
    const url = new URL(requestUrl);
    if (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    ) {
      return `${url.origin}/api/v1/media`;
    }
  } catch {
    // Fall through to the configured public media origin.
  }

  return configured;
}

/**
 * Creates the small common HTTP shell shared by every lazy route family.
 * Route modules stay outside this graph so a request initializes only the
 * commerce surface it actually uses.
 */
function configureApiApp(app: Hono<{ Bindings: Env }>): void {
  app.onError((error, c) => {
    const correlation = getRequestCorrelation(c);
    logApiError(error, {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      requestId: correlation.requestId,
      cfRay: correlation.cfRay,
    });

    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });

  app.use("*", requestCorrelationMiddleware);

  app.use("*", async (c, next) => {
    c.set("db", getDb(c.env));
    await withPublicMediaUrl(
      getR2PublicUrl(c.env, c.req.url),
      () => next(),
    );
  });

  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && c.req.method === "OPTIONS") {
      console.log(`[CORS] Preflight request from origin: ${origin}`);
    }
    await next();
  });

  app.use("*", async (c, next) => {
    const corsMiddleware = cors({
      origin: await getCorsOriginContext(c),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Token",
        "Accept",
        "X-Request-Id",
      ],
      exposeHeaders: ["Content-Type", "Cache-Control", "X-Request-Id"],
      credentials: true,
    });
    return corsMiddleware(c, next);
  });

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!c.req.url.includes("localhost")) {
      c.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
  });

  app.use("*", async (c, next) => {
    const baseUrl = (
      c.env.PUBLIC_API_BASE_URL || new URL(c.req.url).origin
    ).trim();
    c.header("X-Proxy-Base-URL", `${baseUrl}/api/v1`);
    await next();
  });

}

/**
 * Runtime families intentionally use plain Hono. Their OpenAPIHono child
 * routers keep request validation, while the parent avoids rebuilding the
 * full OpenAPI registry during every cold start.
 */
export function createRuntimeApiApp() {
  const app = new Hono<{ Bindings: Env }>().basePath("/api/v1");
  configureApiApp(app);
  return app;
}

/** The full registry-bearing app is retained only for contract generation. */
export function createContractApiApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  configureApiApp(app);
  return app;
}

export type RuntimeApiApp = ReturnType<typeof createRuntimeApiApp>;
