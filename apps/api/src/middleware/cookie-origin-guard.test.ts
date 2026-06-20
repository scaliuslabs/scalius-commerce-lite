import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { cookieOriginGuardMiddleware } from "./cookie-origin-guard";
import { errorResponseFromError } from "../utils/api-response";

function createGuardedApp(envOverrides: Record<string, unknown> = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>();
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", cookieOriginGuardMiddleware);
  app.all("/guarded", (c) => c.json({ success: true }));

  const env = {
    PUBLIC_API_BASE_URL: "https://api.scalius.test",
    BETTER_AUTH_URL: "https://dashboard.scalius.test",
    STOREFRONT_URL: "https://storefront.scalius.test",
    ...envOverrides,
  } as Env;

  return { app, env };
}

describe("cookieOriginGuardMiddleware", () => {
  it("rejects unsafe cookie requests from merchant CSP-only origins", async () => {
    const { app, env } = createGuardedApp({
      CSP_ALLOWED: "https://analytics.vendor.test",
      CACHE: {
        get: async () => "analytics.vendor.test",
      } as unknown as KVNamespace,
    });

    const response = await app.request(
      "/guarded",
      {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=session.signature",
          Origin: "https://analytics.vendor.test",
        },
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows unsafe cookie requests from first-party runtime origins", async () => {
    const { app, env } = createGuardedApp();

    const response = await app.request(
      "/guarded",
      {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=session.signature",
          Origin: "https://dashboard.scalius.test",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
  });

  it("rejects production cookie requests from localhost origins unless loopback is explicitly configured", async () => {
    const { app, env } = createGuardedApp();

    const response = await app.request(
      "/guarded",
      {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=session.signature",
          Origin: "http://localhost:4323",
        },
      },
      env,
    );

    expect(response.status).toBe(403);
  });

  it("allows localhost cookie requests for local runtime origins", async () => {
    const { app, env } = createGuardedApp({
      PUBLIC_API_BASE_URL: "http://localhost:8787",
      BETTER_AUTH_URL: "http://localhost:4323",
      STOREFRONT_URL: "http://localhost:4322",
    });

    const response = await app.request(
      "/guarded",
      {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=session.signature",
          Origin: "http://localhost:4323",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
  });

  it("allows service-binding style cookie requests without a browser Origin", async () => {
    const { app, env } = createGuardedApp();

    const response = await app.request(
      "/guarded",
      {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=session.signature",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
  });

  it("does not block bearer-token clients that do not send cookies", async () => {
    const { app, env } = createGuardedApp();

    const response = await app.request(
      "/guarded",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          Origin: "https://untrusted.example",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
  });
});
