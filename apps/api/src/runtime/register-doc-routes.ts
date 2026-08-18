import { swaggerUI } from "@hono/swagger-ui";
import type { RuntimeApiApp } from "./base-app";
import {
  OPENAPI_CONTRACT_ETAG,
  OPENAPI_CONTRACT_JSON,
} from "../generated/openapi-contract.gen";

export function registerDocRoutes(app: RuntimeApiApp): void {
  app.get("/docs", swaggerUI({ url: "/api/v1/openapi.json" }));
  app.get("/openapi.json", (c) => {
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
