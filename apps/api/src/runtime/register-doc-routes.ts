import type { RuntimeApiApp } from "./base-app";

// Only the contract is served: the CLI, agents and ops checks read it, and a
// person opens its URL in any OpenAPI viewer. No documentation page runs
// script on the dashboard's origin.
export function registerDocRoutes(app: RuntimeApiApp): void {
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
