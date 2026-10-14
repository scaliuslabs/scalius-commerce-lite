import { swaggerUI } from "@hono/swagger-ui";
import type { RuntimeApiApp } from "./base-app";

export function registerDocRoutes(app: RuntimeApiApp): void {
  app.get("/docs", swaggerUI({ url: "/api/v1/openapi.json" }));
  // The contract (3 MB) loads with the first request for it, never with the app.
  app.get("/openapi.json", async (c) => {
    const { OPENAPI_CONTRACT_ETAG, OPENAPI_CONTRACT_JSON } = await import("../generated/openapi-contract.gen");
    c.header("Cache-Control", "public, max-age=0, must-revalidate");
    c.header("ETag", OPENAPI_CONTRACT_ETAG);
    if (c.req.header("If-None-Match") === OPENAPI_CONTRACT_ETAG) {
      return c.body(null, 304);
    }
    return c.body(OPENAPI_CONTRACT_JSON, 200, {
      "Content-Type": "application/json; charset=UTF-8",
    });
  });
}
