export const UCP_VERSION = "2026-04-08";

const UCP_SPEC_ORIGIN = `https://ucp.dev/${UCP_VERSION}`;

const PLATFORM_PROFILE = Object.freeze({
  ucp: Object.freeze({
    version: UCP_VERSION,
    services: Object.freeze({
      "dev.ucp.shopping": Object.freeze([
        Object.freeze({
          version: UCP_VERSION,
          spec: `${UCP_SPEC_ORIGIN}/specification/overview`,
          transport: "rest",
          schema: `${UCP_SPEC_ORIGIN}/services/shopping/rest.openapi.json`,
        }),
      ]),
    }),
    capabilities: Object.freeze({
      "dev.ucp.shopping.catalog.search": Object.freeze([
        Object.freeze({
          version: UCP_VERSION,
          spec: `${UCP_SPEC_ORIGIN}/specification/catalog/search`,
          schema: `${UCP_SPEC_ORIGIN}/schemas/shopping/catalog_search.json`,
        }),
      ]),
      "dev.ucp.shopping.catalog.lookup": Object.freeze([
        Object.freeze({
          version: UCP_VERSION,
          spec: `${UCP_SPEC_ORIGIN}/specification/catalog/lookup`,
          schema: `${UCP_SPEC_ORIGIN}/schemas/shopping/catalog_lookup.json`,
        }),
      ]),
    }),
  }),
});

export function getStorefrontAgentPlatformProfile(): typeof PLATFORM_PROFILE {
  return PLATFORM_PROFILE;
}

export function storefrontAgentPlatformProfileResponse(
  method: "GET" | "HEAD",
): Response {
  const body = method === "HEAD" ? null : JSON.stringify(PLATFORM_PROFILE);
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
