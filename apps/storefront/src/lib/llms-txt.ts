import {
  UCP_CATALOG_LOOKUP_CAPABILITY,
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_VERSION,
} from "@/lib/ucp/catalog";

export function buildLlmsTxt(baseUrl: string): string {
  return `# Scalius Commerce Storefront

> Public storefront and read-only commerce catalog for shopping and research agents.

## Primary resources

- [Storefront](${baseUrl}/): Buyer-visible catalog and commerce experience.
- [UCP profile](${baseUrl}/.well-known/ucp): Machine-readable service and capability discovery.
- [Sitemap](${baseUrl}/sitemap.xml): Canonical public page discovery.
- [Product feed](${baseUrl}/api/product-feed.xml): Merchant catalog feed.

## UCP catalog quick start

1. GET ${baseUrl}/.well-known/ucp and resolve the advertised REST endpoint, protocol version, and capabilities from the profile.
2. This storefront currently advertises only ${UCP_CATALOG_SEARCH_CAPABILITY} and ${UCP_CATALOG_LOOKUP_CAPABILITY} for UCP ${UCP_VERSION}.
3. Send catalog requests with Content-Type: application/json and UCP-Agent: profile="https://your-agent.example/.well-known/ucp". The profile URL must identify the calling platform over HTTPS.
4. Search with POST ${baseUrl}/ucp/catalog/search and a body such as {"ucp":{"version":"${UCP_VERSION}"},"query":"shoes"}.
5. Resolve product, variant, SKU, handle, or same-store product URL identifiers with POST ${baseUrl}/ucp/catalog/lookup and a body such as {"ucp":{"version":"${UCP_VERSION}"},"ids":["product-or-sku"]}.
6. Follow response pagination and messages. Treat catalog price and availability as advisory buyer-visible facts.

## Scope

UCP access is read-only. Cart, checkout, order, fulfillment, payment, and recovery capabilities are not advertised; do not infer or call them. Use the buyer-facing storefront for state-changing commerce flows.
`;
}

export function llmsTxtResponse(baseUrl: string): Response {
  return new Response(buildLlmsTxt(baseUrl), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}

export function llmsTxtUnavailableResponse(): Response {
  return new Response("LLM discovery is temporarily unavailable.\n", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
