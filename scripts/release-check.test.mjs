import { describe, expect, it, vi } from "vitest";
import {
  evaluateAdminMcpTools,
  evaluateDiscoveryCacheHeaders,
  evaluateAgentMcpTools,
  evaluateFacebookFeedXml,
  evaluateHomepageJsonLdHtml,
  evaluateProductJsonLdHtml,
  evaluateProductFeedXml,
  evaluateRemediationTracker,
  evaluateRequiredDocs,
  evaluateRobotsTxt,
  evaluateSitemapXml,
  evaluateUcpProfile,
  normalizeHttpBaseUrl,
  parseReleaseCheckArgs,
  runReleaseCheck,
  smokeAdminMcpAuthenticated,
  smokeAdminMcpUnauthenticated,
  smokeAgentWorker,
} from "./release-check.mjs";

const SITEMAP_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
const FEED_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=43200";
const ADMIN_BUSINESS_SETTINGS_PATH = "/api/v1/admin/settings/business";
const ADMIN_ASSISTANT_MCP_PATH = "/api/assistant/mcp";
const INVALID_ADMIN_SESSION_COOKIE = "better-auth.session_token=release-check-invalid";

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function discoveryResponse(body, cacheControl = SITEMAP_CACHE_CONTROL) {
  return textResponse(body, 200, { "Cache-Control": cacheControl });
}

function storefrontCacheablePageResponse(body = "<!doctype html><html></html>", status = 200, headers = {}) {
  return textResponse(body, status, {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "X-Cache-Status": "HIT; v=42; build=test-build; project=storefront.example.test",
    ...headers,
  });
}

function checkoutNoStoreResponse(headers = {}) {
  return textResponse("<!doctype html><html></html>", 200, {
    "Cache-Control": "private, no-cache, no-store, must-revalidate",
    "X-Cache-Status": "NO_CACHE",
    ...headers,
  });
}

function productFeedCacheResponse(body = feedXml(), headers = {}) {
  return textResponse(body, 200, {
    "Cache-Control": FEED_CACHE_CONTROL,
    "X-Cache-Status": "HIT; v=42; build=test-build; gen=7; project=storefront.example.test",
    ...headers,
  });
}

function purgeGetNoStoreResponse(headers = {}) {
  return textResponse("Method Not Allowed", 405, {
    Allow: "POST",
    "Cache-Control": "no-store",
    ...headers,
  });
}

function responseWithHeaders(response, headers) {
  const nextHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (!nextHeaders.has(key)) nextHeaders.set(key, value);
  }
  const responseClone = response.clone();
  return new Response(responseClone.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  });
}

function resolveMockResponse(value, fallback) {
  const response = typeof value === "function" ? value() : (value ?? fallback());
  return response.clone();
}

function defaultStorefrontCacheSmokeResponse(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "storefront.example.test") return null;
  if (parsed.pathname === "/checkout") return checkoutNoStoreResponse();
  if (parsed.pathname === "/api/purge-cache") return purgeGetNoStoreResponse();
  if (parsed.pathname === "/api/product-feed.xml" && parsed.search === "?limit=5") {
    return productFeedCacheResponse();
  }
  return null;
}

function decorateStorefrontCacheSmokeResponse(url, response) {
  const parsed = new URL(url);
  if (parsed.hostname !== "storefront.example.test") return response;
  if (parsed.pathname === "/" || parsed.pathname === "/search") {
    return responseWithHeaders(response, {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "X-Cache-Status": "HIT; v=42; build=test-build; project=storefront.example.test",
    });
  }
  if (parsed.pathname === "/api/product-feed.xml" && parsed.search === "?limit=5") {
    return responseWithHeaders(response, {
      "X-Cache-Status": "HIT; v=42; build=test-build; gen=7; project=storefront.example.test",
    });
  }
  return response;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function agentHealthResponse(payload = {
  success: true,
  status: "ok",
  service: "scalius-agent",
}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function agentMcpTool(name, extra = {}) {
  const description = name === "cart_validate"
    ? "Checks a public storefront cart snapshot for current availability and price truth."
    : `Reads public storefront catalog data for ${name}.`;
  return {
    name,
    title: name.replace(/_/g, " "),
    description,
    inputSchema: { type: "object", properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    ...extra,
  };
}

function agentMcpTools(overrides = {}) {
  return [
    agentMcpTool("cart_validate", overrides.cart_validate),
    agentMcpTool("catalog_categories", overrides.catalog_categories),
    agentMcpTool("catalog_search", overrides.catalog_search),
    agentMcpTool("catalog_lookup", overrides.catalog_lookup),
    agentMcpTool("catalog_product", overrides.catalog_product),
    agentMcpTool("catalog_profile", overrides.catalog_profile),
  ];
}

function mcpSseResponse(message, headers = {}) {
  return textResponse(`event: message\ndata: ${JSON.stringify(message)}\n\n`, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    ...headers,
  });
}

function agentCatalogProfileMcpResult(profile = ucpProfile()) {
  return {
    content: [{ type: "text", text: JSON.stringify(profile) }],
    structuredContent: profile,
  };
}

function agentCatalogCategoriesMcpResult() {
  const result = {
    catalogCategories: {
      categories: [{
        id: "cat_demo",
        slug: "demo",
        name: "Demo",
        path: "/categories/demo",
      }],
      limit: 1,
      hasMore: true,
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function agentCartValidationMcpResult() {
  const result = {
    cartValidation: {
      valid: false,
      issueCount: 1,
      issues: [{
        index: 0,
        productId: "release-check-missing-product",
        variantId: null,
        code: "PRODUCT_UNAVAILABLE",
        action: "remove",
        message: "This item is no longer available.",
        productName: null,
        variantLabel: null,
        requestedQuantity: 1,
      }],
      items: [],
      subtotal: 0,
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function agentMcpSmokeFetch({
  tools = agentMcpTools(),
  toolResult = agentCatalogProfileMcpResult(),
  catalogCategoriesToolResult = agentCatalogCategoriesMcpResult(),
  cartValidationToolResult = agentCartValidationMcpResult(),
  toolCacheControl = "no-store",
  catalogCategoriesToolCacheControl = toolCacheControl,
  cartValidationToolCacheControl = toolCacheControl,
  onToolCall,
} = {}) {
  return vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);

    if (parsed.pathname === "/health") {
      expect(init.method).toBe("GET");
      return agentHealthResponse();
    }

    if (parsed.pathname === "/mcp") {
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(init.body);

      if (body.method === "initialize") {
        return mcpSseResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "scalius-agent", version: "0.1.0" },
          },
        });
      }

      if (body.method === "tools/list") {
        return mcpSseResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools },
        });
      }

      if (body.method === "tools/call") {
        onToolCall?.(body);
        let result = toolResult;
        let cacheControl = toolCacheControl;
        if (body.params?.name === "catalog_categories") {
          result = catalogCategoriesToolResult;
          cacheControl = catalogCategoriesToolCacheControl;
        } else if (body.params?.name === "cart_validate") {
          result = cartValidationToolResult;
          cacheControl = cartValidationToolCacheControl;
        }
        return mcpSseResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: typeof result === "function" ? result(body) : result,
        }, { "Cache-Control": cacheControl });
      }
    }

    throw new Error(`Unexpected URL ${url}`);
  });
}

function adminMcpTool(name, extra = {}) {
  return {
    name,
    title: name.replace(/_/g, " "),
    description: `Reads ${name} for the current dashboard admin session.`,
    inputSchema: { type: "object", properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    ...extra,
  };
}

function adminMcpTools(overrides = {}) {
  return [
    adminMcpTool("admin_session_context", overrides.admin_session_context),
    adminMcpTool("admin_navigation_context", overrides.admin_navigation_context),
    adminMcpTool("admin_category_search", overrides.admin_category_search),
    adminMcpTool("admin_product_search", overrides.admin_product_search),
    adminMcpTool("admin_order_search", overrides.admin_order_search),
  ];
}

function adminNavigationContextMcpResult(extra = {}) {
  const context = {
    source: {
      permissions: "/api/v1/admin/rbac/my-permissions",
      catalog: "admin-navigation-context:v1",
    },
    session: {
      userId: "admin_123",
      isSuperAdmin: false,
      roles: [],
      roleCount: 0,
      permissionCount: 2,
      deniedPermissionCount: 0,
    },
    defaultPath: "/admin",
    limits: {
      maxPages: 24,
      returnedPages: 2,
      catalogPages: 24,
      includesDynamicRoutes: false,
    },
    sections: [
      {
        section: "Dashboard",
        pages: [{ name: "Dashboard", path: "/admin" }],
      },
    ],
    ...extra,
  };
  const body = { adminNavigationContext: context };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function adminCategorySearchMcpResult(extra = {}) {
  const body = {
    adminCategorySearch: {
      query: "test",
      page: 1,
      limit: 1,
      total: 1,
      categories: [
        {
          id: "cat_demo",
          name: "Test Category",
          slug: "test-category",
          path: "/categories/test-category",
          updatedAt: "2026-07-08T00:00:00.000Z",
        },
      ],
      ...extra,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function adminProductSearchMcpResult(extra = {}) {
  const body = {
    adminProductSearch: {
      query: "test",
      page: 1,
      limit: 1,
      total: 0,
      products: [],
      ...extra,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function adminOrderSearchMcpResult(extra = {}) {
  const body = {
    adminOrderSearch: {
      query: "DW8W05",
      page: 1,
      limit: 1,
      total: 1,
      orders: [
        {
          id: "order_demo",
          orderNumber: "DW8W05",
          status: "confirmed",
          paymentStatus: "paid",
          fulfillmentStatus: "unfulfilled",
          updatedAt: "2026-07-08T00:00:00.000Z",
        },
      ],
      ...extra,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function authenticatedAdminMcpSmokeFetch({
  tools = adminMcpTools(),
  toolResult = adminNavigationContextMcpResult(),
  categorySearchToolResult = adminCategorySearchMcpResult(),
  productSearchToolResult = adminProductSearchMcpResult(),
  orderSearchToolResult = adminOrderSearchMcpResult(),
  toolCacheControl = "no-store",
  categorySearchToolCacheControl = toolCacheControl,
  productSearchToolCacheControl = toolCacheControl,
  orderSearchToolCacheControl = toolCacheControl,
  onMcpRequest,
} = {}) {
  return vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);

    if (parsed.pathname === "/api/auth/sign-in/email") {
      expect(parsed.href).toBe("https://dashboard.example.test/api/auth/sign-in/email");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("origin")).toBe("https://dashboard.example.test");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("cookie")).toBe(false);
      expect(JSON.parse(init.body)).toEqual({
        email: "admin@example.test",
        password: "correct-password",
        rememberMe: false,
      });
      return jsonResponse({ success: true }, 200, {
        "Set-Cookie": [
          "better-auth.session_data=cache.signature; Path=/; HttpOnly",
          "better-auth.session_token=session.signature; Path=/; HttpOnly",
        ].join(", "),
      });
    }

    if (parsed.pathname === ADMIN_ASSISTANT_MCP_PATH) {
      expect(parsed.href).toBe("https://dashboard.example.test/api/assistant/mcp");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("origin")).toBe("https://dashboard.example.test");
      expect(headers.get("cookie")).toBe("better-auth.session_token=session.signature");
      expect(headers.has("authorization")).toBe(false);

      const body = JSON.parse(init.body);
      onMcpRequest?.(body);

      if (body.method === "initialize") {
        return mcpSseResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "scalius-admin-agent", version: "0.1.0" },
          },
        }, { "Cache-Control": "no-store" });
      }

      if (body.method === "tools/list") {
        return mcpSseResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools },
        }, { "Cache-Control": "no-store" });
      }

      if (body.method === "tools/call") {
        let result;
        let cacheControl = toolCacheControl;
        if (body.params?.name === "admin_navigation_context") {
          expect(body.params).toEqual({
            name: "admin_navigation_context",
            arguments: {},
          });
          result = typeof toolResult === "function" ? toolResult(body) : toolResult;
        } else if (body.params?.name === "admin_category_search") {
          expect(body.params).toEqual({
            name: "admin_category_search",
            arguments: {
              query: "test",
              limit: 1,
              page: 1,
            },
          });
          result = typeof categorySearchToolResult === "function"
            ? categorySearchToolResult(body)
            : categorySearchToolResult;
          cacheControl = categorySearchToolCacheControl;
        } else if (body.params?.name === "admin_product_search") {
          expect(body.params).toEqual({
            name: "admin_product_search",
            arguments: {
              query: "test",
              limit: 1,
              page: 1,
            },
          });
          result = typeof productSearchToolResult === "function"
            ? productSearchToolResult(body)
            : productSearchToolResult;
          cacheControl = productSearchToolCacheControl;
        } else if (body.params?.name === "admin_order_search") {
          expect(body.params).toEqual({
            name: "admin_order_search",
            arguments: {
              query: "DW8W05",
              limit: 1,
              page: 1,
            },
          });
          result = typeof orderSearchToolResult === "function"
            ? orderSearchToolResult(body)
            : orderSearchToolResult;
          cacheControl = orderSearchToolCacheControl;
        } else {
          throw new Error(`Unexpected Admin MCP tool call ${body.params?.name}`);
        }
        return mcpSseResponse({
          jsonrpc: "2.0",
          id: body.id,
          result,
        }, { "Cache-Control": cacheControl });
      }
    }

    throw new Error(`Unexpected URL ${url}`);
  });
}

function invalidAdminCookieResponse(url, init = {}) {
  const parsed = new URL(url);
  if (parsed.pathname !== ADMIN_BUSINESS_SETTINGS_PATH) return null;

  expect(init.method).toBe("GET");
  expect(new Headers(init.headers).get("cookie")).toBe(INVALID_ADMIN_SESSION_COOKIE);
  if (parsed.hostname === "api.example.test") {
    return jsonResponse({ success: false, error: { code: "UNAUTHORIZED" } }, 401);
  }
  if (parsed.hostname === "dashboard.example.test") {
    return jsonResponse({ success: false, error: { code: "FORBIDDEN" } }, 403);
  }
  return null;
}

function unauthenticatedAdminMcpResponse(url, init = {}) {
  const parsed = new URL(url);
  if (parsed.pathname !== ADMIN_ASSISTANT_MCP_PATH) return null;

  expect(parsed.hostname).toBe("dashboard.example.test");
  expect(init.method).toBe("POST");
  const headers = new Headers(init.headers);
  expect(headers.get("accept")).toBe("application/json, text/event-stream");
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.has("cookie")).toBe(false);
  expect(headers.has("authorization")).toBe(false);
  expect(JSON.parse(init.body)).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });

  return jsonResponse(
    { success: false, error: { code: "UNAUTHORIZED" } },
    401,
    { "Cache-Control": "private, no-cache, no-store, must-revalidate" },
  );
}

function releaseFetch(implementation) {
  return vi.fn(async (url, init = {}) => {
    const response =
      invalidAdminCookieResponse(url, init) ||
      unauthenticatedAdminMcpResponse(url, init);
    if (response) return response;
    try {
      return decorateStorefrontCacheSmokeResponse(url, await implementation(url, init));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unexpected URL ")) {
        const fallback = defaultStorefrontCacheSmokeResponse(url);
        if (fallback) return fallback;
      }
      throw error;
    }
  });
}

function cacheHeaderGateFetch(overrides = {}) {
  return releaseFetch(async (url) => {
    const parsed = new URL(url);

    if (parsed.hostname === "api.example.test") {
      if (parsed.pathname === "/api/v1/health") return textResponse("ok");
      if (parsed.pathname === "/api/v1/readyz") return readyResponse();
      if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
    }

    if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
      return textResponse("", 307, { location: "/auth/login" });
    }

    if (parsed.hostname === "storefront.example.test") {
      if (parsed.pathname === "/health") return textResponse("ok");
      if (parsed.pathname === "/") {
        return resolveMockResponse(overrides.home, storefrontCacheablePageResponse);
      }
      if (parsed.pathname === "/search") {
        return resolveMockResponse(overrides.search, storefrontCacheablePageResponse);
      }
      if (parsed.pathname === "/checkout") {
        return resolveMockResponse(overrides.checkout, checkoutNoStoreResponse);
      }
      if (parsed.pathname === "/api/product-feed.xml" && parsed.search === "?limit=5") {
        return resolveMockResponse(overrides.productFeed, productFeedCacheResponse);
      }
      if (parsed.pathname === "/api/purge-cache") {
        return resolveMockResponse(overrides.purgeGet, purgeGetNoStoreResponse);
      }
    }

    throw new Error(`Unexpected URL ${url}`);
  });
}

function openApiResponse(paths = {}) {
  return jsonResponse({
    openapi: "3.0.0",
    paths: {
      "/api/v1/admin/analytics/health": {},
      ...paths,
    },
  });
}

function seoDiscoveryPolicy(overrides = {}) {
  return {
    sitemap: {
      enabled: true,
      staticPages: true,
      products: true,
      categories: true,
      collections: true,
      pages: true,
      ...overrides.sitemap,
    },
    feeds: {
      productCatalogEnabled: true,
      includeUnavailableProducts: true,
      variantStrategy: "variants",
      title: "",
      description: "",
      ...overrides.feeds,
    },
    robots: {
      advertiseSitemap: true,
      ...overrides.robots,
    },
    structuredData: {
      organization: true,
      websiteSearch: true,
      products: true,
      productGroups: true,
      offerShippingDetails: true,
      breadcrumbs: true,
      collections: true,
      ...overrides.structuredData,
    },
  };
}

function seoPolicyResponse(overrides) {
  return jsonResponse({
    success: true,
    data: {
      discovery: seoDiscoveryPolicy(overrides),
    },
  });
}

function readyResponse() {
  return jsonResponse({
    success: true,
    status: "ready",
    checks: {
      d1: { status: "ok", latencyMs: 12 },
      api_cache_kv: { status: "ok", latencyMs: 8 },
    },
  });
}

function degradedResponse(status = 503) {
  return jsonResponse({
    success: false,
    status: "degraded",
    checks: {
      d1: { status: "ok", latencyMs: 12 },
      api_cache_kv: { status: "timeout", latencyMs: 1_500 },
    },
  }, status);
}

function monitoringApiConfig() {
  return {
    name: "scalius-api",
    observability: { enabled: true },
    triggers: { crons: ["*/15 * * * *"] },
    vars: {
      PUBLIC_API_BASE_URL: "https://api.example.test",
      STOREFRONT_URL: "https://storefront.example.test",
    },
    queues: {
      producers: [{ queue: "payment-events" }],
      consumers: [
        { queue: "payment-events", dead_letter_queue: "payment-events-dlq" },
        { queue: "payment-events-dlq" },
      ],
    },
  };
}

function logsOnlyOpsMonitorConfig() {
  return {
    name: "scalius-ops-monitor",
    observability: { enabled: true },
    kv_namespaces: [{ binding: "OPS_MONITOR_STATE", id: "state-id" }],
    send_email: [{ name: "ALERT_EMAIL" }],
    triggers: { crons: ["*/2 * * * *"] },
    vars: {
      ALERT_EMAIL_FROM: "",
      ALERT_EMAIL_TO: "",
      ALERT_EMAIL_SUBJECT_PREFIX: "[Scalius ops]",
    },
  };
}

function verifiedTracker() {
  return [
    "| ID | Severity | Status | Owner | Summary | Primary Verification |",
    "| --- | --- | --- | --- | --- | --- |",
    "| SEC-001 | P0 | Verified | API | Fixed. | Tests. |",
    "| AUTH-001 | P1 | Won't Fix | API | Accepted. | Note. |",
    "| PERF-001 | P2 | In Progress | Admin | Follow-up. | Tests. |",
  ].join("\n");
}

function trackerWithOpenBlocker() {
  return [
    "| ID | Severity | Status | Owner | Summary | Primary Verification |",
    "| --- | --- | --- | --- | --- | --- |",
    "| SEC-001 | P0 | Verified | API | Fixed. | Tests. |",
    "| PAY-001 | P1 | In Progress | Payments | Not ready. | Smoke. |",
  ].join("\n");
}

function robotsTxt() {
  return "User-agent: *\nAllow: /\nSitemap: https://storefront.example.test/sitemap.xml\n";
}

function robotsTxtWithoutSitemap() {
  return "User-agent: *\nAllow: /\n";
}

function sitemapXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "<url><loc>https://storefront.example.test/products/demo-product</loc></url>",
    "</urlset>",
  ].join("");
}

function emptySitemapXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "</urlset>",
  ].join("");
}

function sitemapIndexXml(locs) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`),
    "</sitemapindex>",
  ].join("");
}

function feedXml({ availability = "in_stock" } = {}) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>',
    "<item>",
    "<g:id>sku_1</g:id>",
    "<g:link>https://storefront.example.test/products/demo-product</g:link>",
    "<g:image_link>https://cloud.example.test/demo.png</g:image_link>",
    `<g:availability>${availability}</g:availability>`,
    "</item>",
    "</channel></rss>",
  ].join("");
}

function emptyFeedXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0"><channel>',
    "</channel></rss>",
  ].join("");
}

function productHtml() {
  return [
    "<!doctype html><html><head>",
    '<script type="application/ld+json">',
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Demo Product",
      image: ["https://cdn.example.test/demo.png"],
      sku: "SKU-1",
      offers: {
        "@type": "Offer",
        url: "https://storefront.example.test/products/demo-product",
        priceCurrency: "BDT",
        price: "1200.00",
        availability: "https://schema.org/InStock",
        shippingDetails: {
          "@type": "OfferShippingDetails",
          shippingDestination: {
            "@type": "DefinedRegion",
            addressCountry: "BD",
          },
          shippingRate: {
            "@type": "MonetaryAmount",
            value: "80.00",
            currency: "BDT",
          },
        },
      },
    }),
    "</script>",
    "</head><body></body></html>",
  ].join("");
}

function homepageHtml() {
  return [
    "<!doctype html><html><head>",
    '<script type="application/ld+json">',
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "OnlineStore",
      "@id": "https://storefront.example.test/#store",
      name: "Demo Store",
      url: "https://storefront.example.test",
      logo: {
        "@type": "ImageObject",
        url: "https://storefront.example.test/logo.png",
      },
      sameAs: ["https://facebook.com/demo"],
      hasMerchantReturnPolicy: {
        "@type": "MerchantReturnPolicy",
        applicableCountry: "BD",
        returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
        merchantReturnDays: 7,
        returnFees: "https://schema.org/FreeReturn",
      },
    }),
    "</script>",
    '<script type="application/ld+json">',
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Demo Store",
      url: "https://storefront.example.test",
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: "https://storefront.example.test/search?q={search_term_string}",
        },
        "query-input": "required name=search_term_string",
      },
    }),
    "</script>",
    "</head><body></body></html>",
  ].join("");
}

function ucpProfile(capabilities = {
  "dev.ucp.shopping.catalog.search": [{
    version: "2026-07",
    spec: "https://ucp.dev/2026-07/specification/catalog/search",
    schema: "https://ucp.dev/2026-07/schemas/shopping/catalog_search.json",
  }],
  "dev.ucp.shopping.catalog.lookup": [{
    version: "2026-07",
    spec: "https://ucp.dev/2026-07/specification/catalog/lookup",
    schema: "https://ucp.dev/2026-07/schemas/shopping/catalog_lookup.json",
  }],
}) {
  return {
    ucp: {
      version: "2026-07",
      services: {
        "dev.ucp.shopping": [
          {
            version: "2026-07",
            transport: "rest",
            endpoint: "https://storefront.example.test/ucp",
            spec: "https://ucp.dev/2026-07/specification/overview",
            schema: "https://ucp.dev/2026-07/services/shopping/rest.openapi.json",
          },
        ],
      },
      capabilities,
      supported_versions: {
        "2026-07": "https://storefront.example.test/.well-known/ucp",
      },
    },
  };
}

function ucpProfileResponse(payload = ucpProfile(), cacheControl = SITEMAP_CACHE_CONTROL) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
    },
  });
}

function ucpSearchResponse() {
  return jsonResponse({
    ucp: {
      version: "2026-07",
      status: "success",
      capabilities: ["dev.ucp.shopping.catalog.search"],
    },
    products: [
      {
        id: "gid://scalius/product/prod_1",
        title: "Demo Product",
        url: "https://storefront.example.test/products/demo-product",
        variants: [
          {
            id: "gid://scalius/product-variant/var_1",
            sku: "SKU-1",
            url: "https://storefront.example.test/products/demo-product?variant=var_1",
          },
        ],
      },
    ],
    pagination: { has_next_page: false, total_count: 1 },
  });
}

function emptyUcpSearchResponse() {
  return jsonResponse({
    ucp: {
      version: "2026-07",
      status: "success",
      capabilities: ["dev.ucp.shopping.catalog.search"],
    },
    products: [],
    pagination: { has_next_page: false, total_count: 0 },
  });
}

function ucpLookupResponse(inputId = "gid://scalius/product-variant/var_1") {
  return jsonResponse({
    ucp: {
      version: "2026-07",
      status: "success",
      capabilities: ["dev.ucp.shopping.catalog.lookup"],
    },
    products: [
      {
        id: "gid://scalius/product/prod_1",
        variants: [
          {
            id: "gid://scalius/product-variant/var_1",
            inputs: [{ id: inputId, match: "exact" }],
          },
        ],
      },
    ],
  });
}

function ucpProductResponse(firstVariantId = "gid://scalius/product-variant/var_1") {
  const variants = [
    { id: firstVariantId, sku: "SKU-1" },
    { id: "gid://scalius/product-variant/var_1", sku: "SKU-1" },
  ].filter((variant, index, all) =>
    all.findIndex((candidate) => candidate.id === variant.id) === index
  );

  return jsonResponse({
    ucp: {
      version: "2026-07",
      status: "success",
      capabilities: ["dev.ucp.shopping.catalog.lookup"],
    },
    product: {
      id: "gid://scalius/product/prod_1",
      title: "Demo Product",
      variants,
    },
  });
}

describe("release-check parser", () => {
  it("parses supported options and normalizes URLs", () => {
    expect(parseReleaseCheckArgs([
      "--json",
      "--skip-wrangler",
      "--timeout-ms=5000",
      "--api-base-url",
      "https://api.example.test/api/v1/",
      "--storefront-url",
      "https://storefront.example.test/",
      "--dashboard-url=https://dashboard.example.test/",
      "--agent-url=https://agent.example.test/",
    ])).toMatchObject({
      json: true,
      skipLive: false,
      skipWrangler: true,
      timeoutMs: 5000,
      apiBaseUrl: "https://api.example.test/api/v1",
      storefrontUrl: "https://storefront.example.test",
      dashboardUrl: "https://dashboard.example.test",
      agentUrl: "https://agent.example.test",
    });

    expect(parseReleaseCheckArgs(["--help"])).toEqual({ help: true });
    expect(() => parseReleaseCheckArgs(["--timeout-ms", "0"])).toThrow("--timeout-ms must be a positive integer");
    expect(() => parseReleaseCheckArgs(["--api-base-url", "file:///tmp/api"])).toThrow("must use http or https");
    expect(() => normalizeHttpBaseUrl("https://user:pass@example.test", "Storefront URL")).toThrow("must not include credentials");
  });
});

describe("release-check local evaluators", () => {
  it("fails open P0/P1 tracker rows and allows closed rows", () => {
    expect(evaluateRemediationTracker(verifiedTracker())).toMatchObject({
      ok: true,
      checkedRows: 3,
      blockers: [],
    });

    expect(evaluateRemediationTracker(trackerWithOpenBlocker())).toMatchObject({
      ok: false,
      blockers: [{ id: "PAY-001", severity: "P1", status: "In Progress" }],
    });
  });

  it("checks required docs by path", () => {
    const existing = new Set([
      "/repo/audit/REMEDIATION_TRACKER.md",
      "/repo/audit/VERIFICATION_PLAYBOOK.md",
      "/repo/audit/STABLE_RELEASE_CHECKLIST.md",
      "/repo/docs/codex/PLATFORM-GOAL.md",
      "/repo/docs/codex/README.md",
      "/repo/docs/ARCHITECTURE.md",
      "/repo/README.md",
      "/repo/AGENTS.md",
    ]);

    expect(evaluateRequiredDocs({
      rootDir: "/repo",
      fileExistsImpl: (path) => existing.has(path),
    })).toMatchObject({
      ok: true,
      checkedFiles: 8,
    });

    existing.delete("/repo/docs/ARCHITECTURE.md");
    expect(evaluateRequiredDocs({
      rootDir: "/repo",
      fileExistsImpl: (path) => existing.has(path),
    })).toMatchObject({
      ok: false,
      missing: ["docs/ARCHITECTURE.md"],
    });
  });

  it("accepts exactly the catalog and read-only cart-validation agent MCP tools", () => {
    expect(evaluateAgentMcpTools(agentMcpTools())).toMatchObject({
      ok: true,
      errors: [],
      toolNames: [
        "cart_validate",
        "catalog_categories",
        "catalog_lookup",
        "catalog_product",
        "catalog_profile",
        "catalog_search",
      ],
      readOnlyToolCount: 6,
    });
  });

  it("rejects unsafe agent MCP tool names and capabilities", () => {
    const unsafeName = evaluateAgentMcpTools([
      ...agentMcpTools(),
      agentMcpTool("catalog_checkout"),
    ]);
    expect(unsafeName).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining("unexpected catalog_checkout"),
        expect.stringContaining("checkout/order/payment/customer/recovery or cart mutation terms"),
      ]),
    });

    const unsafeCartMutation = evaluateAgentMcpTools([
      ...agentMcpTools(),
      agentMcpTool("cart_update", {
        description: "Updates cart line quantities.",
      }),
    ]);
    expect(unsafeCartMutation).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining("unexpected cart_update"),
        expect.stringContaining("checkout/order/payment/customer/recovery or cart mutation terms"),
      ]),
    });

    const unsafeCapability = evaluateAgentMcpTools(agentMcpTools({
      catalog_profile: {
        _meta: {
          capabilities: ["payment"],
        },
      },
    }));
    expect(unsafeCapability).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining("checkout/order/payment/customer/recovery or cart mutation terms"),
      ]),
    });
  });

  it("accepts exactly the read-only admin MCP context/search tools", () => {
    expect(evaluateAdminMcpTools(adminMcpTools())).toMatchObject({
      ok: true,
      errors: [],
      toolNames: [
        "admin_category_search",
        "admin_navigation_context",
        "admin_order_search",
        "admin_product_search",
        "admin_session_context",
      ],
      readOnlyToolCount: 5,
    });
  });

  it("rejects mutation-like admin MCP tool names even when otherwise expected", () => {
    const unsafeToolName = evaluateAdminMcpTools([
      ...adminMcpTools(),
      adminMcpTool("admin_product_update"),
    ], {
      expectedToolNames: [
        "admin_session_context",
        "admin_navigation_context",
        "admin_category_search",
        "admin_product_search",
        "admin_order_search",
        "admin_product_update",
      ],
    });

    expect(unsafeToolName).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining("mutation-like terms"),
        expect.stringContaining("admin_product_update"),
      ]),
    });
  });

  it("signs in and runs authenticated Admin MCP tools/list plus navigation, category, product, and order search smokes", async () => {
    const mcpRequests = [];
    const fetchImpl = authenticatedAdminMcpSmokeFetch({
      onMcpRequest: (body) => {
        mcpRequests.push(
          body.method === "tools/call"
            ? `${body.method}:${body.params?.name}`
            : body.method,
        );
      },
    });
    const logger = { log: vi.fn(), warn: vi.fn() };

    const result = await smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl,
      timeoutMs: 5_000,
      logger,
    });

    expect(mcpRequests).toEqual([
      "initialize",
      "tools/list",
      "tools/call:admin_navigation_context",
      "tools/call:admin_category_search",
      "tools/call:admin_product_search",
      "tools/call:admin_order_search",
    ]);
    expect(result.signIn).toMatchObject({
      url: "https://dashboard.example.test/api/auth/sign-in/email",
      statusCode: 200,
      sessionCookieNames: ["better-auth.session_token"],
    });
    expect(result.mcp).toMatchObject({
      url: "https://dashboard.example.test/api/assistant/mcp",
      initialize: {
        statusCode: 200,
        cacheControl: "no-store",
        protocolVersion: "2025-06-18",
        session: "none",
      },
      tools: {
        statusCode: 200,
        cacheControl: "no-store",
        toolNames: [
          "admin_category_search",
          "admin_navigation_context",
          "admin_order_search",
          "admin_product_search",
          "admin_session_context",
        ],
        readOnlyToolCount: 5,
      },
      navigationTool: {
        name: "admin_navigation_context",
        statusCode: 200,
        cacheControl: "no-store",
        contentCount: 1,
        defaultPath: "/admin",
        returnedPages: 2,
        sectionCount: 1,
      },
      categorySearchTool: {
        name: "admin_category_search",
        statusCode: 200,
        cacheControl: "no-store",
        contentCount: 1,
      },
      productSearchTool: {
        name: "admin_product_search",
        statusCode: 200,
        cacheControl: "no-store",
        contentCount: 1,
      },
      orderSearchTool: {
        name: "admin_order_search",
        statusCode: 200,
        cacheControl: "no-store",
        contentCount: 1,
      },
    });
    expect(logger.log).toHaveBeenCalledWith(
      "PASS admin MCP authenticated: tools admin_category_search, admin_navigation_context, admin_order_search, admin_product_search, admin_session_context, calls admin_navigation_context, admin_category_search, admin_product_search, admin_order_search ok.",
    );

    const logged = JSON.stringify(logger.log.mock.calls);
    expect(logged).not.toContain("admin@example.test");
    expect(logged).not.toContain("correct-password");
    expect(logged).not.toContain("session.signature");
  });

  it("fails authenticated Admin MCP smoke with extra or missing tools", async () => {
    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        tools: [
          adminMcpTool("admin_session_context"),
          adminMcpTool("admin_write_context"),
        ],
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow(/Admin MCP tools\/list failed: .*missing admin_category_search, admin_navigation_context, admin_order_search, admin_product_search.*unexpected admin_write_context/);

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        tools: [adminMcpTool("admin_session_context")],
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow(/Admin MCP tools\/list failed: .*missing admin_category_search, admin_navigation_context, admin_order_search, admin_product_search/);
  });

  it("fails authenticated Admin MCP smoke when tool calls lack no-store or return an error", async () => {
    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        toolCacheControl: "public, max-age=60",
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_navigation_context Cache-Control must include no-store");

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        toolResult: {
          isError: true,
          content: [{ type: "text", text: "denied" }],
          structuredContent: {
            error: {
              code: "admin_session_invalid",
              status: 401,
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_navigation_context returned an MCP tool error");

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        productSearchToolCacheControl: "public, max-age=60",
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_product_search Cache-Control must include no-store");

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        productSearchToolResult: {
          isError: true,
          content: [{ type: "text", text: "denied" }],
          structuredContent: {
            error: {
              code: "admin_product_search_failed",
              status: 500,
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_product_search returned an MCP tool error");

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        productSearchToolResult: {
          content: [],
          structuredContent: {
            adminProductSearch: {
              products: [],
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_product_search must return at least one content block");
  });

  it("fails authenticated Admin MCP smoke when category search lacks no-store, errors, or empty content", async () => {
    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        categorySearchToolCacheControl: "public, max-age=60",
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_category_search Cache-Control must include no-store");

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        categorySearchToolResult: {
          isError: true,
          content: [{ type: "text", text: "denied" }],
          structuredContent: {
            error: {
              code: "admin_category_search_failed",
              status: 500,
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_category_search returned an MCP tool error");

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        categorySearchToolResult: {
          content: [],
          structuredContent: {
            adminCategorySearch: {
              categories: [],
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_category_search must return at least one content block");
  });

  it("fails authenticated Admin MCP smoke when order search lacks no-store, errors, or empty content", async () => {
    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        orderSearchToolCacheControl: "public, max-age=60",
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_order_search Cache-Control must include no-store");

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        orderSearchToolResult: {
          isError: true,
          content: [{ type: "text", text: "denied" }],
          structuredContent: {
            error: {
              code: "admin_order_search_failed",
              status: 500,
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_order_search returned an MCP tool error");

    await expect(smokeAdminMcpAuthenticated({
      dashboardUrl: "https://dashboard.example.test",
      email: "admin@example.test",
      password: "correct-password",
      fetchImpl: authenticatedAdminMcpSmokeFetch({
        orderSearchToolResult: {
          content: [],
          structuredContent: {
            adminOrderSearch: {
              orders: [],
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("admin_order_search must return at least one content block");
  });

  it("calls safe read-only catalog and cart-validation MCP tools when the agent smoke opts in", async () => {
    const mcpRequests = [];
    const fetchImpl = agentMcpSmokeFetch({
      onToolCall: (body) => {
        mcpRequests.push(`${body.method}:${body.params?.name}`);
        if (body.params?.name === "catalog_profile") {
          expect(body.params).toEqual({
            name: "catalog_profile",
            arguments: {},
          });
        }
        if (body.params?.name === "catalog_categories") {
          expect(body.params).toEqual({
            name: "catalog_categories",
            arguments: {
              limit: 1,
            },
          });
        }
        if (body.params?.name === "cart_validate") {
          expect(body.params).toEqual({
            name: "cart_validate",
            arguments: {
              items: [{
                productId: "release-check-missing-product",
                quantity: 1,
                unitPrice: 1,
              }],
            },
          });
        }
      },
    });

    const result = await smokeAgentWorker({
      agentUrl: "https://agent.example.test",
      storefrontUrl: "https://storefront.example.test",
      catalogToolSmoke: true,
      fetchImpl,
      timeoutMs: 5_000,
      logger: null,
    });

    expect(mcpRequests).toEqual([
      "tools/call:catalog_profile",
      "tools/call:catalog_categories",
      "tools/call:cart_validate",
    ]);
    expect(result.mcp.catalogTool).toMatchObject({
      name: "catalog_profile",
      statusCode: 200,
      cacheControl: "no-store",
      contentCount: 1,
      profile: {
        version: "2026-07",
        endpoint: "https://storefront.example.test/ucp",
        capabilities: [
          "dev.ucp.shopping.catalog.search",
          "dev.ucp.shopping.catalog.lookup",
        ],
      },
    });
    expect(result.mcp.catalogCategoriesTool).toMatchObject({
      name: "catalog_categories",
      statusCode: 200,
      cacheControl: "no-store",
      contentCount: 1,
    });
    expect(result.mcp.cartValidationTool).toMatchObject({
      name: "cart_validate",
      statusCode: 200,
      cacheControl: "no-store",
      contentCount: 1,
      issueCount: 1,
      firstIssueCode: "PRODUCT_UNAVAILABLE",
    });
  });

  it("fails the catalog MCP tool smoke when the live profile advertises commerce capabilities", async () => {
    const fetchImpl = agentMcpSmokeFetch({
      toolResult: agentCatalogProfileMcpResult(ucpProfile({
        ...ucpProfile().ucp.capabilities,
        "dev.ucp.shopping.checkout": [{
          version: "2026-07",
          spec: "https://ucp.dev/2026-07/specification/checkout",
          schema: "https://ucp.dev/2026-07/schemas/shopping/checkout.json",
        }],
      })),
    });

    await expect(smokeAgentWorker({
      agentUrl: "https://agent.example.test",
      storefrontUrl: "https://storefront.example.test",
      catalogToolSmoke: true,
      fetchImpl,
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow(/catalog_profile failed: .*checkout\/cart\/order\/payment/);
  });

  it("fails the category MCP tool smoke when the call is cacheable, an error, or content-empty", async () => {
    await expect(smokeAgentWorker({
      agentUrl: "https://agent.example.test",
      storefrontUrl: "https://storefront.example.test",
      catalogToolSmoke: true,
      fetchImpl: agentMcpSmokeFetch({
        catalogCategoriesToolCacheControl: "public, max-age=60",
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("catalog_categories Cache-Control must include no-store");

    await expect(smokeAgentWorker({
      agentUrl: "https://agent.example.test",
      storefrontUrl: "https://storefront.example.test",
      catalogToolSmoke: true,
      fetchImpl: agentMcpSmokeFetch({
        catalogCategoriesToolResult: {
          isError: true,
          content: [{ type: "text", text: "temporary failure" }],
          structuredContent: {
            catalogCategories: {
              categories: [],
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("catalog_categories returned an MCP tool error");

    await expect(smokeAgentWorker({
      agentUrl: "https://agent.example.test",
      storefrontUrl: "https://storefront.example.test",
      catalogToolSmoke: true,
      fetchImpl: agentMcpSmokeFetch({
        catalogCategoriesToolResult: {
          content: [],
          structuredContent: {
            catalogCategories: {
              categories: [],
            },
          },
        },
      }),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("catalog_categories must return at least one content block");
  });

  it("accepts an unauthenticated admin MCP 401/403 with no-store-ish cache headers", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      expect(parsed.href).toBe("https://dashboard.example.test/api/assistant/mcp");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("cookie")).toBe(false);
      expect(JSON.parse(init.body)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });

      return jsonResponse(
        { success: false, error: { code: "UNAUTHORIZED" } },
        401,
        { "Cache-Control": "private, no-cache, no-store, must-revalidate" },
      );
    });

    await expect(smokeAdminMcpUnauthenticated({
      dashboardUrl: "https://dashboard.example.test",
      fetchImpl,
      timeoutMs: 5_000,
      logger: null,
    })).resolves.toMatchObject({
      url: "https://dashboard.example.test/api/assistant/mcp",
      statusCode: 401,
      cacheControl: "private, no-cache, no-store, must-revalidate",
    });
  });

  it("rejects admin MCP unauthenticated smokes that succeed or lack no-store-ish cache headers", async () => {
    await expect(smokeAdminMcpUnauthenticated({
      dashboardUrl: "https://dashboard.example.test",
      fetchImpl: vi.fn(async () => jsonResponse({ success: true }, 200, {
        "Cache-Control": "no-store",
      })),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("expected 401/403");

    await expect(smokeAdminMcpUnauthenticated({
      dashboardUrl: "https://dashboard.example.test",
      fetchImpl: vi.fn(async () => jsonResponse(
        { success: false },
        401,
        { "Cache-Control": "public, max-age=60" },
      )),
      timeoutMs: 5_000,
      logger: null,
    })).rejects.toThrow("no-store-ish Cache-Control");
  });
});

describe("release-check discovery evaluators", () => {
  const storefrontOrigin = "https://storefront.example.test";

  it("validates robots sitemap URLs and sitemap locs", () => {
    expect(evaluateRobotsTxt(robotsTxt(), { storefrontOrigin })).toMatchObject({
      ok: true,
      sitemapUrls: ["https://storefront.example.test/sitemap.xml"],
    });
    expect(evaluateRobotsTxt(robotsTxt().replace(
      "https://storefront.example.test/sitemap.xml",
      "https://storefront.example.test:443/sitemap.xml",
    ), {
      storefrontOrigin,
      expectedSitemapUrl: "https://storefront.example.test/sitemap.xml",
    })).toMatchObject({
      ok: false,
      errors: [
        "robots sitemap URL must be canonical: https://storefront.example.test/sitemap.xml",
      ],
    });
    expect(evaluateRobotsTxt("Sitemap: /sitemap.xml", { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: ["robots sitemap URL is not absolute http(s): /sitemap.xml"],
    });
    expect(evaluateRobotsTxt(robotsTxtWithoutSitemap(), {
      storefrontOrigin,
      requireSitemap: false,
      allowSitemap: false,
    })).toMatchObject({
      ok: true,
      sitemapUrls: [],
    });
    expect(evaluateRobotsTxt(robotsTxt(), {
      storefrontOrigin,
      requireSitemap: false,
      allowSitemap: false,
    })).toMatchObject({
      ok: false,
      errors: ["robots.txt must not advertise Sitemap URLs when policy disables sitemap advertisement."],
    });

    expect(evaluateSitemapXml(sitemapXml(), { storefrontOrigin })).toMatchObject({
      ok: true,
      locCount: 1,
    });
    expect(evaluateSitemapXml("<url><loc>/products/demo</loc></url>", { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: ["sitemap <loc> is not absolute http(s): /products/demo"],
    });
    expect(evaluateSitemapXml(emptySitemapXml(), {
      storefrontOrigin,
      requireLoc: false,
    })).toMatchObject({
      ok: true,
      locCount: 0,
    });
  });

  it("rejects product sitemap priority/changefreq tags", () => {
    const withIgnoredSeoHints = sitemapXml().replace("</url>", "<priority>0.9</priority><changefreq>daily</changefreq></url>");
    expect(evaluateSitemapXml(withIgnoredSeoHints, {
      storefrontOrigin,
      forbidPriority: true,
      forbidChangefreq: true,
    })).toMatchObject({
      ok: false,
      errors: [
        "product sitemap must not include <priority>.",
        "product sitemap must not include <changefreq>.",
      ],
    });
  });

  it("validates feed item, availability, and absolute links", () => {
    const feedWithChannelLink = feedXml().replace("<channel>", "<channel><link>https://storefront.example.test/</link>");

    expect(evaluateProductFeedXml(feedWithChannelLink, { storefrontOrigin })).toMatchObject({
      ok: true,
      itemCount: 1,
      linkCount: 1,
      imageLinkCount: 1,
      availabilityCount: 1,
      firstStorefrontItemUrl: "https://storefront.example.test/products/demo-product",
    });
    expect(evaluateFacebookFeedXml(feedWithChannelLink, { storefrontOrigin })).toMatchObject({
      ok: true,
      itemCount: 1,
    });
    expect(evaluateProductFeedXml(feedWithChannelLink, {
      availabilityValues: ["in_stock", "out_of_stock"],
      storefrontOrigin,
    })).toMatchObject({
      ok: true,
      availabilityValues: ["in_stock"],
    });
    expect(evaluateProductFeedXml(feedXml({ availability: "in stock" }), {
      availabilityValues: ["in_stock", "out_of_stock"],
      storefrontOrigin,
    })).toMatchObject({
      ok: false,
      errors: ["feed availability value is not allowed: in stock"],
    });

    expect(evaluateProductFeedXml(emptyFeedXml(), {
      availabilityValues: ["in_stock", "out_of_stock"],
      storefrontOrigin,
    })).toMatchObject({
      ok: true,
      itemCount: 0,
      linkCount: 0,
      imageLinkCount: 0,
      availabilityCount: 0,
      firstStorefrontItemUrl: null,
    });

    expect(evaluateProductFeedXml("<rss><channel><item><g:link>/products/demo</g:link></item></channel></rss>", {
      storefrontOrigin,
    })).toMatchObject({
      ok: false,
      errors: [
        "feed item 1 must include an image_link.",
        "feed item 1 must include availability.",
        "feed product link is not absolute http(s): /products/demo",
      ],
    });

    const missingRssShell = [
      "<channel><item>",
      "<g:link>https://storefront.example.test/products/demo-product</g:link>",
      "<g:image_link>https://cloud.example.test/demo.png</g:image_link>",
      "<g:availability>in stock</g:availability>",
      "</item></channel>",
    ].join("");
    expect(evaluateProductFeedXml(missingRssShell, { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: ["Product feed must be RSS/XML with <rss> and <channel>."],
    });
  });

  it("validates production-safe discovery cache headers without pinning exact TTLs", () => {
    expect(evaluateDiscoveryCacheHeaders("public, max-age=60", { label: "robots.txt" })).toMatchObject({
      ok: true,
      cacheControl: "public, max-age=60",
    });
    expect(evaluateDiscoveryCacheHeaders("private, no-store", { label: "sitemap.xml" })).toMatchObject({
      ok: false,
      errors: [
        "sitemap.xml Cache-Control must not include no-store on successful discovery responses.",
        "sitemap.xml Cache-Control must not be private on successful discovery responses.",
        "sitemap.xml Cache-Control must include public cacheability.",
        "sitemap.xml Cache-Control must include a positive max-age or s-maxage.",
      ],
    });
    expect(evaluateDiscoveryCacheHeaders("", { label: "product feed" })).toMatchObject({
      ok: false,
      errors: ["product feed must include Cache-Control."],
    });
  });

  it("validates rendered product JSON-LD for Product, Offer, image, and shipping facts", () => {
    expect(evaluateProductJsonLdHtml(productHtml(), { storefrontOrigin })).toMatchObject({
      ok: true,
      scriptCount: 1,
      productSchemaCount: 1,
      offerCount: 1,
      shippingDetailsCount: 1,
    });

    expect(
      evaluateProductJsonLdHtml(
        '<script type="application/ld+json">{"@type":"Product","image":["/bad.png"],"offers":{"@type":"Offer","url":"/products/demo","price":"x"}}</script>',
        { storefrontOrigin },
      ),
    ).toMatchObject({
      ok: false,
      errors: [
        "Product JSON-LD image is not absolute http(s): /bad.png",
        "Offer URL is not absolute http(s): /products/demo",
        "Offer must include priceCurrency.",
        "Offer price must be a non-negative number or numeric string.",
        "Offer availability must be InStock or OutOfStock.",
      ],
    });
  });

  it("validates homepage OnlineStore, WebSite, and return policy JSON-LD without requiring fabricated facts", () => {
    expect(
      evaluateHomepageJsonLdHtml(homepageHtml(), {
        storefrontOrigin,
        policy: { structuredData: { organization: true, websiteSearch: true } },
      }),
    ).toMatchObject({
      ok: true,
      onlineStoreCount: 1,
      websiteCount: 1,
      returnPolicyCount: 1,
    });

    expect(
      evaluateHomepageJsonLdHtml(
        '<script type="application/ld+json">{"@type":"OnlineStore","name":"Store","url":"https://storefront.example.test","logo":{"url":"/logo.png"}}</script>',
        { storefrontOrigin },
      ),
    ).toMatchObject({
      ok: false,
      errors: [
        'OnlineStore name must use saved business identity, not "Store".',
        "OnlineStore logo is not absolute http(s): /logo.png",
      ],
    });

    expect(
      evaluateHomepageJsonLdHtml(homepageHtml(), {
        storefrontOrigin,
        policy: { structuredData: { organization: false, websiteSearch: false } },
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        "OnlineStore JSON-LD emitted while organization schema is disabled.",
        "WebSite JSON-LD emitted while website search schema is disabled.",
      ],
    });
  });

  it("validates UCP HTTPS catalog-only profile shape", () => {
    expect(evaluateUcpProfile(ucpProfile(), { storefrontOrigin })).toMatchObject({
      ok: true,
      version: "2026-07",
      endpoint: "https://storefront.example.test/ucp",
      capabilities: [
        "dev.ucp.shopping.catalog.search",
        "dev.ucp.shopping.catalog.lookup",
      ],
    });

    const baseCapabilities = ucpProfile().ucp.capabilities;
    expect(evaluateUcpProfile(ucpProfile({
      ...baseCapabilities,
      "dev.ucp.shopping.checkout": [{ version: "2026-07" }],
      "dev.ucp.shopping.payment_handlers": [{ version: "2026-07" }],
    }), { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: [
        "UCP profile must advertise only catalog search/lookup capabilities: dev.ucp.shopping.checkout, dev.ucp.shopping.payment_handlers",
        "UCP profile must not advertise checkout/cart/order/payment capabilities: dev.ucp.shopping.checkout, dev.ucp.shopping.payment_handlers",
      ],
    });

    const topLevelPaymentHandlers = ucpProfile();
    topLevelPaymentHandlers.ucp.payment_handlers = {
      "com.example.pay": [{ id: "example_pay" }],
    };
    expect(evaluateUcpProfile(topLevelPaymentHandlers, { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: ["UCP profile must not include a top-level payment_handlers field."],
    });

    const offOrigin = ucpProfile();
    offOrigin.ucp.services["dev.ucp.shopping"][0].endpoint = "https://api.example.test/ucp";
    expect(evaluateUcpProfile(offOrigin, { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: ["UCP service endpoint is not on storefront origin: https://api.example.test/ucp"],
    });

    const wrongSchema = ucpProfile();
    wrongSchema.ucp.services["dev.ucp.shopping"][0].schema =
      "https://ucp.dev/2026-07/schemas/shopping/catalog.json";
    wrongSchema.ucp.capabilities["dev.ucp.shopping.catalog.search"][0].schema =
      "https://ucp.dev/2026-07/schemas/shopping/catalog.json";
    expect(evaluateUcpProfile(wrongSchema, { storefrontOrigin })).toMatchObject({
      ok: false,
      errors: [
        "UCP shopping REST service descriptor schema must be https://ucp.dev/2026-07/services/shopping/rest.openapi.json.",
        "dev.ucp.shopping.catalog.search descriptor schema must be https://ucp.dev/2026-07/schemas/shopping/catalog_search.json.",
      ],
    });
  });
});

describe("runReleaseCheck", () => {
  it("surfaces logs-only ops-monitor warnings and actions without failing release output", async () => {
    const disabledDiscoveryPolicy = {
      sitemap: {
        enabled: true,
        staticPages: false,
        products: false,
        categories: false,
        collections: false,
        pages: false,
      },
      feeds: {
        productCatalogEnabled: false,
      },
      robots: {
        advertiseSitemap: false,
      },
      structuredData: {
        products: false,
      },
    };
    const fetchImpl = releaseFetch(async (url) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") return seoPolicyResponse(disabledDiscoveryPolicy);
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") {
          return textResponse("<!doctype html><html></html>");
        }
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxtWithoutSitemap());
        if (parsed.pathname === "/sitemap.xml") return discoveryResponse(emptySitemapXml());
        if (parsed.pathname === "/.well-known/ucp") return ucpProfileResponse();
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--skip-wrangler",
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      opsMonitorConfig: logsOnlyOpsMonitorConfig(),
      fetchImpl,
      execFileImpl: vi.fn(),
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger,
    });

    const warning = "Ops-monitor alert channel: ALERT_EMAIL_TO is empty.";
    const action =
      "Ops-monitor alert channel: Set ALERT_EMAIL_TO to one or more verified Cloudflare Email Service destinations.";

    expect(result.status).toBe("passed");
    expect(result.checks.adminMcpAuthenticated).toMatchObject({
      status: "skipped",
      reason: "Set SCALIUS_RELEASE_ADMIN_EMAIL and SCALIUS_RELEASE_ADMIN_PASSWORD to enable authenticated Admin MCP smoke.",
      env: {
        email: "SCALIUS_RELEASE_ADMIN_EMAIL",
        password: "SCALIUS_RELEASE_ADMIN_PASSWORD",
      },
      missingEnv: [
        "SCALIUS_RELEASE_ADMIN_EMAIL",
        "SCALIUS_RELEASE_ADMIN_PASSWORD",
      ],
    });
    expect(result.checks.apiOps.opsMonitorAlertChannel).toMatchObject({
      status: "warning",
      alertMode: "logs_only",
      routedEmailReady: false,
      warnings: expect.arrayContaining([
        "Routed Cloudflare Email alerts are not configured; ops-monitor remains logs-only.",
        "ALERT_EMAIL_TO is empty.",
      ]),
      requiredActions: expect.arrayContaining([
        "Set ALERT_EMAIL_TO to one or more verified Cloudflare Email Service destinations.",
      ]),
    });
    expect(result.checks.apiOps.warnings).toContain(warning);
    expect(result.checks.apiOps.requiredActions).toContain(action);
    expect(result.warnings).toContain(warning);
    expect(result.requiredActions).toContain(action);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      warnings: expect.arrayContaining([warning]),
      requiredActions: expect.arrayContaining([action]),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "WARN admin MCP authenticated smoke skipped (SCALIUS_RELEASE_ADMIN_EMAIL, SCALIUS_RELEASE_ADMIN_PASSWORD not set).",
    );
    expect(logger.warn).toHaveBeenCalledWith(`WARN API ops: ${warning}`);
    expect(logger.warn).toHaveBeenCalledWith(`ACTION API ops: ${action}`);
    expect(logger.log).toHaveBeenCalledWith("Release readiness check passed.");
  });

  it("runs local gates and live read-only checks after transient API readiness recovers", async () => {
    const feedRequests = [];
    const ucpRequests = [];
    const agentMcpRequests = [];
    const readyzResponses = [
      degradedResponse(),
      readyResponse(),
      readyResponse(),
      readyResponse(),
    ];
    const fetchImpl = releaseFetch(async (url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === "agent.example.test" && parsed.pathname === "/mcp") {
        expect(init.method).toBe("POST");
        const headers = new Headers(init.headers);
        expect(headers.get("accept")).toBe("application/json, text/event-stream");
        expect(headers.get("content-type")).toBe("application/json");
      } else if (parsed.pathname.startsWith("/ucp/catalog/")) {
        expect(init.method).toBe("POST");
        expect(init.headers["UCP-Agent"]).toBe('profile="https://release-check.scalius.com/.well-known/ucp"');
      } else {
        expect(init.method).toBe("GET");
      }

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyzResponses.shift() ?? readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") {
          return openApiResponse({
            "/api/v1/health": {},
            "/api/v1/readyz": {},
            "/api/v1/openapi.json": {},
          });
        }
        if (parsed.pathname === "/api/v1/seo") return seoPolicyResponse();
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        expect(init.redirect).toBe("manual");
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "agent.example.test") {
        if (parsed.pathname === "/health") return agentHealthResponse();
        if (parsed.pathname === "/mcp") {
          const body = JSON.parse(init.body);
          agentMcpRequests.push(
            body.method === "tools/call"
              ? `${body.method}:${body.params?.name}`
              : body.method,
          );
          if (body.method === "initialize") {
            return mcpSseResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "scalius-agent", version: "0.1.0" },
              },
            });
          }
          if (body.method === "tools/list") {
            return mcpSseResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: { tools: agentMcpTools() },
            });
          }
          if (body.method === "tools/call") {
            if (body.params?.name === "catalog_profile") {
              expect(body.params).toEqual({
                name: "catalog_profile",
                arguments: {},
              });
            }
            if (body.params?.name === "catalog_categories") {
              expect(body.params).toEqual({
                name: "catalog_categories",
                arguments: {
                  limit: 1,
                },
              });
            }
            if (body.params?.name === "cart_validate") {
              expect(body.params).toEqual({
                name: "cart_validate",
                arguments: {
                  items: [{
                    productId: "release-check-missing-product",
                    quantity: 1,
                    unitPrice: 1,
                  }],
                },
              });
            }
            return mcpSseResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: body.params?.name === "cart_validate"
                ? agentCartValidationMcpResult()
                : body.params?.name === "catalog_categories"
                  ? agentCatalogCategoriesMcpResult()
                  : agentCatalogProfileMcpResult(),
            });
          }
        }
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<!doctype html><html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname.startsWith("/sitemap-") || parsed.pathname === "/sitemap.xml") {
          return discoveryResponse(sitemapXml());
        }
        if (
          (parsed.pathname === "/api/product-feed.xml" || parsed.pathname === "/api/facebook-feed.xml") &&
          (parsed.search === "?limit=5" || parsed.search === "?page=2&limit=5")
        ) {
          feedRequests.push(`${parsed.pathname}${parsed.search}`);
          return discoveryResponse(
            feedXml({
              availability: parsed.pathname === "/api/product-feed.xml"
                ? "in_stock"
                : "in stock",
            }),
            FEED_CACHE_CONTROL,
          );
        }
        if (parsed.pathname === "/.well-known/ucp") {
          ucpRequests.push(parsed.pathname);
          return ucpProfileResponse();
        }
        if (parsed.pathname === "/ucp/catalog/search") {
          ucpRequests.push(parsed.pathname);
          expect(JSON.parse(init.body)).toMatchObject({
            ucp: { version: "2026-07" },
            query: "demo product",
            pagination: { limit: 5 },
          });
          return ucpSearchResponse();
        }
        if (parsed.pathname === "/ucp/catalog/lookup") {
          ucpRequests.push(parsed.pathname);
          expect(JSON.parse(init.body)).toMatchObject({
            ids: ["gid://scalius/product-variant/var_1"],
          });
          return ucpLookupResponse();
        }
        if (parsed.pathname === "/ucp/catalog/product") {
          ucpRequests.push(parsed.pathname);
          expect(JSON.parse(init.body)).toMatchObject({
            id: "gid://scalius/product-variant/var_1",
          });
          return ucpProductResponse();
        }
        if (parsed.pathname === "/products/demo-product") return textResponse(productHtml());
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn(async (command, args) => {
      expect(command).toBe("pnpm");
      if (args.includes("deployments")) {
        expect(args).toEqual(["--dir", "apps/api", "exec", "wrangler", "deployments", "list", "--json"]);
        return {
          stdout: JSON.stringify([
            {
              created_on: "2026-07-06T02:00:00Z",
              versions: [{ version_id: "api-version", percentage: 100 }],
            },
          ]),
        };
      }

      expect(args.slice(0, -1)).toEqual(["--dir", "apps/api", "exec", "wrangler", "queues", "info"]);
      const queueName = args.at(-1);
      const producerLines = queueName.endsWith("-dlq")
        ? ["Number of Producers: 1", "Producers: worker:scalius-ops-monitor"]
        : ["Number of Producers: 2", "Producers: worker:scalius-api, worker:testdash"];
      return {
        stdout: [
          `Queue Name: ${queueName}`,
          "Queue ID: queue-id",
          ...producerLines,
          "Number of Consumers: 1",
          "Consumers: worker:scalius-api",
        ].join("\n"),
      };
    });

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
      "--agent-url", "https://agent.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      pnpmExecutable: "pnpm",
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.apiOps).toMatchObject({
      healthStatusCode: 200,
      readyCount: 3,
      readySampleCount: 4,
      openApiPathCount: 4,
      deploymentVersionId: "api-version",
      queueStatus: "passed",
      queueCount: 2,
      queues: {
        queueCount: 2,
        queues: [
          {
            name: "payment-events",
            unexpectedProducers: ["worker:testdash"],
          },
          {
            name: "payment-events-dlq",
            unexpectedProducers: [],
          },
        ],
      },
    });
    expect(result.warnings).toContain("Queue payment-events: unexpected producer worker:testdash");
    expect(result.requiredActions).toContain(
      "Queue payment-events: migrate or redeploy worker:testdash without this production queue producer binding; do not allowlist it unless it is intentionally source-owned.",
    );
    expect(result.checks.adminInvalidCookieAuth).toMatchObject({
      api: {
        url: "https://api.example.test/api/v1/admin/settings/business",
        statusCode: 401,
      },
      dashboardProxy: {
        url: "https://dashboard.example.test/api/v1/admin/settings/business",
        statusCode: 403,
      },
    });
    expect(result.checks.adminMcpAuth).toMatchObject({
      url: "https://dashboard.example.test/api/assistant/mcp",
      statusCode: 401,
      cacheControl: "private, no-cache, no-store, must-revalidate",
    });
    expect(result.checks.dashboard).toMatchObject({
      statusCode: 307,
      location: "/auth/login",
    });
    expect(result.checks.storefrontCacheHeaders).toMatchObject({
      paths: [
        "/",
        "/search?sortBy=newest",
        "/checkout",
        "/api/product-feed.xml?limit=5",
        "/api/purge-cache",
      ],
      publicPages: [
        {
          path: "/",
          cacheStatus: "HIT; v=42; build=test-build; project=storefront.example.test",
        },
        {
          path: "/search?sortBy=newest",
          cacheStatus: "HIT; v=42; build=test-build; project=storefront.example.test",
        },
      ],
      checkout: {
        statusCode: 200,
        cacheControl: "private, no-cache, no-store, must-revalidate",
        cacheStatus: "NO_CACHE",
      },
      productFeed: {
        statusCode: 200,
        cacheControl: FEED_CACHE_CONTROL,
        cacheStatus: "HIT; v=42; build=test-build; gen=7; project=storefront.example.test",
      },
      purgeGet: {
        statusCode: 405,
        allow: "POST",
        cacheControl: "no-store",
      },
    });
    expect(agentMcpRequests).toEqual([
      "initialize",
      "tools/list",
      "tools/call:catalog_profile",
      "tools/call:catalog_categories",
      "tools/call:cart_validate",
    ]);
    expect(result.checks.agentMcp).toMatchObject({
      agentUrl: "https://agent.example.test/",
      health: {
        statusCode: 200,
        cacheControl: "no-store",
        service: "scalius-agent",
      },
      mcp: {
        initialize: {
          statusCode: 200,
          protocolVersion: "2025-06-18",
          session: "none",
        },
        tools: {
          statusCode: 200,
          toolNames: [
            "cart_validate",
            "catalog_categories",
            "catalog_lookup",
            "catalog_product",
            "catalog_profile",
            "catalog_search",
          ],
          readOnlyToolCount: 6,
        },
        catalogTool: {
          name: "catalog_profile",
          statusCode: 200,
          cacheControl: "no-store",
          contentCount: 1,
          profile: {
            version: "2026-07",
            endpoint: "https://storefront.example.test/ucp",
            capabilities: [
              "dev.ucp.shopping.catalog.search",
              "dev.ucp.shopping.catalog.lookup",
            ],
          },
        },
        catalogCategoriesTool: {
          name: "catalog_categories",
          statusCode: 200,
          cacheControl: "no-store",
          contentCount: 1,
        },
        cartValidationTool: {
          name: "cart_validate",
          statusCode: 200,
          cacheControl: "no-store",
          contentCount: 1,
          issueCount: 1,
          firstIssueCode: "PRODUCT_UNAVAILABLE",
        },
      },
    });
    expect(result.checks.discovery.robots.cacheControl).toBe(SITEMAP_CACHE_CONTROL);
    expect(result.checks.discovery.policy).toMatchObject({
      source: "public-seo",
      sitemap: { enabled: true, products: true },
      feeds: { productCatalogEnabled: true },
      robots: { advertiseSitemap: true },
    });
    expect(result.checks.discovery.homepageStructuredData).toMatchObject({
      ok: true,
      onlineStoreCount: 0,
      websiteCount: 0,
    });
    expect(result.checks.discovery.sitemaps["/sitemap.xml"].cacheControl).toBe(SITEMAP_CACHE_CONTROL);
    expect(result.checks.discovery.feed).toMatchObject({
      cacheControl: FEED_CACHE_CONTROL,
      itemCount: 1,
      imageLinkCount: 1,
      availabilityCount: 1,
    });
    expect(result.checks.discovery.compatibilityFeed).toMatchObject({
      cacheControl: FEED_CACHE_CONTROL,
      itemCount: 1,
      imageLinkCount: 1,
      availabilityCount: 1,
    });
    expect(feedRequests).toEqual([
      "/api/product-feed.xml?limit=5",
      "/api/product-feed.xml?limit=5",
      "/api/product-feed.xml?page=2&limit=5",
      "/api/facebook-feed.xml?limit=5",
      "/api/facebook-feed.xml?page=2&limit=5",
    ]);
    expect(ucpRequests).toEqual([
      "/.well-known/ucp",
      "/ucp/catalog/search",
      "/ucp/catalog/lookup",
      "/ucp/catalog/product",
    ]);
    expect(result.checks.ucpDiscovery).toMatchObject({
      profile: {
        version: "2026-07",
        endpoint: "https://storefront.example.test/ucp",
        capabilities: [
          "dev.ucp.shopping.catalog.search",
          "dev.ucp.shopping.catalog.lookup",
        ],
      },
      catalog: {
        search: {
          query: "demo product",
          productCount: 1,
        },
        lookup: {
          inputId: "gid://scalius/product-variant/var_1",
          productCount: 1,
        },
        product: {
          inputId: "gid://scalius/product-variant/var_1",
          productId: "gid://scalius/product/prod_1",
          firstVariantId: "gid://scalius/product-variant/var_1",
          variantCount: 1,
        },
      },
    });
    expect(result.checks.productRoute.url).toBe("https://storefront.example.test/products/demo-product");
    expect(result.checks.productRoute.schema).toMatchObject({
      productSchemaCount: 1,
      offerCount: 1,
      shippingDetailsCount: 1,
    });
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname === "/api/v1/readyz")).toHaveLength(4);
    expect(execFileImpl.mock.calls.map(([, args]) => args.join(" "))).toEqual([
      "--dir apps/api exec wrangler deployments list --json",
      "--dir apps/api exec wrangler queues info payment-events",
      "--dir apps/api exec wrangler queues info payment-events-dlq",
    ]);
  });

  it.each([
    {
      label: "home page cache status lacks build marker",
      overrides: {
        home: storefrontCacheablePageResponse("<html></html>", 200, {
          "X-Cache-Status": "MISS; v=42; project=storefront.example.test",
        }),
      },
      expectedMessage: "Storefront / cache headers failed",
      expectedDetail: "must include a build marker",
    },
    {
      label: "checkout is publicly cacheable",
      overrides: {
        checkout: textResponse("<html></html>", 200, {
          "Cache-Control": "public, max-age=60",
          "X-Cache-Status": "HIT; v=42; build=test-build",
        }),
      },
      expectedMessage: "Storefront /checkout cache headers failed",
      expectedDetail: "checkout Cache-Control must include private",
    },
    {
      label: "product feed lacks generation marker",
      overrides: {
        productFeed: productFeedCacheResponse(feedXml(), {
          "X-Cache-Status": "HIT; v=42; build=test-build; project=storefront.example.test",
        }),
      },
      expectedMessage: "Storefront /api/product-feed.xml cache headers failed",
      expectedDetail: "must include a generation marker",
    },
    {
      label: "purge GET is not method-locked",
      overrides: {
        purgeGet: textResponse("ok", 200, {
          Allow: "GET, POST",
          "Cache-Control": "no-store",
        }),
      },
      expectedMessage: "Storefront /api/purge-cache GET returned HTTP 200",
      expectedDetail: "Storefront /api/purge-cache GET returned HTTP 200",
    },
  ])("fails storefront cache-header smoke when $label", async ({ overrides, expectedMessage, expectedDetail }) => {
    const fetchImpl = cacheHeaderGateFetch(overrides);

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain(expectedMessage);
    expect(thrown.message).toContain(expectedDetail);
    expect(thrown.result.checks.storefrontCacheHeaders).toMatchObject({
      status: "failed",
      error: expect.stringContaining(expectedMessage),
    });
  });

  it.each([
    {
      label: "direct API accepts the invalid cookie",
      apiResponse: () => jsonResponse({ success: true }, 200),
      dashboardResponse: () => jsonResponse({ success: false }, 403),
      expectedMessage: "accepted an invalid better-auth.session_token",
    },
    {
      label: "dashboard proxy hits the admin read timeout",
      apiResponse: () => jsonResponse({ success: false }, 401),
      dashboardResponse: () => jsonResponse({
        success: false,
        error: { code: "ADMIN_API_READ_TIMEOUT" },
      }, 504),
      expectedMessage: "hit ADMIN_API_READ_TIMEOUT/504",
    },
  ])("fails when $label", async ({ apiResponse, dashboardResponse, expectedMessage }) => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === ADMIN_BUSINESS_SETTINGS_PATH) {
          expect(init.method).toBe("GET");
          expect(new Headers(init.headers).get("cookie")).toBe(INVALID_ADMIN_SESSION_COOKIE);
          return apiResponse();
        }
      }

      if (
        parsed.hostname === "dashboard.example.test" &&
        parsed.pathname === ADMIN_BUSINESS_SETTINGS_PATH
      ) {
        expect(init.method).toBe("GET");
        expect(new Headers(init.headers).get("cookie")).toBe(INVALID_ADMIN_SESSION_COOKIE);
        return dashboardResponse();
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain(expectedMessage);
    expect(thrown.result.checks.adminInvalidCookieAuth).toMatchObject({
      status: "failed",
      error: expect.stringContaining(expectedMessage),
    });
  });

  it.each([
    {
      label: "admin MCP accepts unauthenticated access",
      dashboardMcpResponse: () => jsonResponse({ success: true }, 200, {
        "Cache-Control": "no-store",
      }),
      expectedMessage: "expected 401/403",
    },
    {
      label: "admin MCP auth failure is cacheable",
      dashboardMcpResponse: () => jsonResponse(
        { success: false, error: { code: "UNAUTHORIZED" } },
        401,
        { "Cache-Control": "public, max-age=60" },
      ),
      expectedMessage: "no-store-ish Cache-Control",
    },
  ])("fails when $label", async ({ dashboardMcpResponse, expectedMessage }) => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === ADMIN_BUSINESS_SETTINGS_PATH) {
          return jsonResponse({ success: false, error: { code: "UNAUTHORIZED" } }, 401);
        }
      }

      if (
        parsed.hostname === "dashboard.example.test" &&
        parsed.pathname === ADMIN_BUSINESS_SETTINGS_PATH
      ) {
        return jsonResponse({ success: false, error: { code: "FORBIDDEN" } }, 403);
      }

      if (
        parsed.hostname === "dashboard.example.test" &&
        parsed.pathname === ADMIN_ASSISTANT_MCP_PATH
      ) {
        expect(init.method).toBe("POST");
        const headers = new Headers(init.headers);
        expect(headers.has("cookie")).toBe(false);
        expect(headers.has("authorization")).toBe(false);
        return dashboardMcpResponse();
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain(expectedMessage);
    expect(thrown.result.checks.adminMcpAuth).toMatchObject({
      status: "failed",
      error: expect.stringContaining(expectedMessage),
    });
  });

  it("uses public SEO policy to skip disabled sitemap sections, feeds, and robots sitemap advertisement", async () => {
    const requestedStorefrontPaths = [];
    const disabledDiscoveryPolicy = {
      sitemap: {
        enabled: true,
        staticPages: false,
        products: false,
        categories: false,
        collections: false,
        pages: false,
      },
      feeds: {
        productCatalogEnabled: false,
      },
      robots: {
        advertiseSitemap: false,
      },
    };
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") return seoPolicyResponse(disabledDiscoveryPolicy);
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        requestedStorefrontPaths.push(`${parsed.pathname}${parsed.search}`);
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxtWithoutSitemap());
        if (parsed.pathname === "/sitemap.xml") return discoveryResponse(emptySitemapXml());
        if (parsed.pathname === "/.well-known/ucp") return ucpProfileResponse();
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn();

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--skip-wrangler",
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.discovery.policy).toMatchObject({
      source: "public-seo",
      sitemap: { enabled: true, products: false },
      feeds: { productCatalogEnabled: false },
      robots: { advertiseSitemap: false },
    });
    expect(result.checks.discovery.robots).toMatchObject({
      sitemapUrls: [],
    });
    expect(result.checks.discovery.sitemaps["/sitemap.xml"]).toMatchObject({
      locCount: 0,
    });
    expect(result.checks.discovery.sitemaps["/sitemap-products.xml?page=1"]).toMatchObject({
      status: "skipped",
      reason: "products sitemap disabled by public SEO policy.",
    });
    expect(result.checks.discovery.feed).toMatchObject({
      status: "skipped",
      reason: "Product catalog feed disabled by public SEO policy.",
    });
    expect(result.checks.discovery.compatibilityFeed).toMatchObject({
      status: "skipped",
    });
    expect(result.checks.productRoute).toMatchObject({
      status: "skipped",
      reason: "No storefront product URL discovered from the catalog feed or product sitemap.",
    });
    expect(result.checks.ucpDiscovery).toMatchObject({
      profile: {
        capabilities: [
          "dev.ucp.shopping.catalog.search",
          "dev.ucp.shopping.catalog.lookup",
        ],
      },
      catalog: {
        status: "skipped",
        reason: "No safe product candidate from discovery for read-only UCP catalog search/lookup.",
      },
    });
    expect(requestedStorefrontPaths).toEqual([
      "/health",
      "/",
      "/search",
      "/",
      "/search?sortBy=newest",
      "/checkout",
      "/api/product-feed.xml?limit=5",
      "/api/purge-cache",
      "/",
      "/robots.txt",
      "/sitemap.xml",
      "/.well-known/ucp",
    ]);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("fails when the sitemap index advertises a child sitemap disabled by public SEO policy", async () => {
    const disabledDiscoveryPolicy = {
      sitemap: {
        enabled: true,
        staticPages: false,
        products: false,
        categories: false,
        collections: false,
        pages: false,
      },
      feeds: {
        productCatalogEnabled: false,
      },
      robots: {
        advertiseSitemap: false,
      },
    };
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") return seoPolicyResponse(disabledDiscoveryPolicy);
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxtWithoutSitemap());
        if (parsed.pathname === "/sitemap.xml") {
          return discoveryResponse(
            sitemapIndexXml([
              "https://storefront.example.test/sitemap-products.xml?page=1",
            ]),
          );
        }
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(
      runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      }),
    ).rejects.toThrow(
      "sitemap index must not advertise disabled products sitemap: https://storefront.example.test/sitemap-products.xml?page=1",
    );
  });

  it("verifies UCP profile-only discovery when the catalog is empty", async () => {
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") {
          return seoPolicyResponse({
            sitemap: {
              enabled: true,
              staticPages: false,
              products: false,
              categories: false,
              collections: false,
              pages: false,
            },
            feeds: { productCatalogEnabled: true },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname === "/sitemap.xml") return discoveryResponse(emptySitemapXml());
        if (parsed.pathname === "/sitemap-products.xml") return discoveryResponse(emptySitemapXml());
        if (
          (parsed.pathname === "/api/product-feed.xml" || parsed.pathname === "/api/facebook-feed.xml") &&
          (parsed.search === "?limit=5" || parsed.search === "?page=2&limit=5")
        ) {
          return discoveryResponse(emptyFeedXml(), FEED_CACHE_CONTROL);
        }
        if (parsed.pathname === "/.well-known/ucp") return ucpProfileResponse();
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--skip-wrangler",
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl: vi.fn(),
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.ucpDiscovery).toMatchObject({
      profile: {
        capabilities: [
          "dev.ucp.shopping.catalog.search",
          "dev.ucp.shopping.catalog.lookup",
        ],
      },
      catalog: {
        status: "skipped",
        reason: "No safe product candidate from discovery for read-only UCP catalog search/lookup.",
      },
    });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).not.toContain("/ucp/catalog/search");
  });

  it("fails UCP discovery when the profile success response is not publicly cacheable", async () => {
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") {
          return seoPolicyResponse({
            sitemap: {
              enabled: true,
              staticPages: false,
              products: false,
              categories: false,
              collections: false,
              pages: false,
            },
            feeds: { productCatalogEnabled: false },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname === "/sitemap.xml") return discoveryResponse(sitemapXml());
        if (parsed.pathname === "/.well-known/ucp") {
          return ucpProfileResponse(ucpProfile(), "private, no-store");
        }
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("UCP profile cache headers failed");
    expect(thrown.message).toContain("UCP profile Cache-Control must not include no-store");
    expect(thrown.message).toContain("UCP profile Cache-Control must not be private");
    expect(thrown.message).toContain("UCP profile Cache-Control must include public cacheability");
    expect(thrown.message).toContain("UCP profile Cache-Control must include a positive max-age or s-maxage");
    expect(thrown.result.checks.ucpDiscovery).toMatchObject({
      status: "failed",
      error: expect.stringContaining("UCP profile cache headers failed"),
    });
    const requestedPaths = fetchImpl.mock.calls.map(([url]) => new URL(url).pathname);
    expect(requestedPaths).toContain("/.well-known/ucp");
    expect(requestedPaths).not.toContain("/ucp/catalog/search");
  });

  it("fails UCP discovery when checkout or payment capabilities are advertised", async () => {
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") {
          return seoPolicyResponse({
            sitemap: {
              enabled: true,
              staticPages: false,
              products: false,
              categories: false,
              collections: false,
              pages: false,
            },
            feeds: { productCatalogEnabled: false },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname === "/sitemap.xml") return discoveryResponse(sitemapXml());
        if (parsed.pathname === "/.well-known/ucp") {
          return ucpProfileResponse(ucpProfile({
            "dev.ucp.shopping.catalog.search": [{ version: "2026-07" }],
            "dev.ucp.shopping.catalog.lookup": [{ version: "2026-07" }],
            "dev.ucp.shopping.checkout": [{ version: "2026-07" }],
            "dev.ucp.shopping.payment": [{ version: "2026-07" }],
          }));
        }
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("UCP profile failed");
    expect(thrown.message).toContain("must not advertise checkout/cart/order/payment capabilities");
    expect(thrown.result.checks.ucpDiscovery).toMatchObject({
      status: "failed",
      error: expect.stringContaining("dev.ucp.shopping.checkout"),
    });
  });

  it("fails UCP discovery when top-level payment_handlers is present without payment capabilities", async () => {
    const requestedPaths = [];
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);
      requestedPaths.push(parsed.pathname);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") {
          return seoPolicyResponse({
            sitemap: {
              enabled: true,
              staticPages: false,
              products: false,
              categories: false,
              collections: false,
              pages: false,
            },
            feeds: { productCatalogEnabled: false },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname === "/sitemap.xml") return discoveryResponse(sitemapXml());
        if (parsed.pathname === "/.well-known/ucp") {
          const profile = ucpProfile();
          profile.ucp.payment_handlers = {
            "com.example.pay": [{ id: "example_pay" }],
          };
          return ucpProfileResponse(profile);
        }
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("UCP profile failed");
    expect(thrown.message).toContain("top-level payment_handlers");
    expect(thrown.result.checks.ucpDiscovery).toMatchObject({
      status: "failed",
      error: expect.stringContaining("top-level payment_handlers"),
    });
    expect(requestedPaths).toContain("/.well-known/ucp");
    expect(requestedPaths).not.toContain("/ucp/catalog/search");
  });

  it("fails UCP discovery when product detail does not keep the candidate variant first", async () => {
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") return seoPolicyResponse();
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname.startsWith("/sitemap-") || parsed.pathname === "/sitemap.xml") {
          return discoveryResponse(sitemapXml());
        }
        if (
          (parsed.pathname === "/api/product-feed.xml" || parsed.pathname === "/api/facebook-feed.xml") &&
          (parsed.search === "?limit=5" || parsed.search === "?page=2&limit=5")
        ) {
          return discoveryResponse(
            feedXml({
              availability: parsed.pathname === "/api/product-feed.xml"
                ? "in_stock"
                : "in stock",
            }),
            FEED_CACHE_CONTROL,
          );
        }
        if (parsed.pathname === "/.well-known/ucp") return ucpProfileResponse();
        if (parsed.pathname === "/ucp/catalog/search") return ucpSearchResponse();
        if (parsed.pathname === "/ucp/catalog/lookup") return ucpLookupResponse();
        if (parsed.pathname === "/ucp/catalog/product") {
          expect(JSON.parse(init.body)).toMatchObject({
            id: "gid://scalius/product-variant/var_1",
          });
          return ucpProductResponse("gid://scalius/product-variant/var_2");
        }
        if (parsed.pathname === "/products/demo-product") return textResponse(productHtml());
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("UCP catalog product first variant");
    expect(thrown.result.checks.ucpDiscovery).toMatchObject({
      status: "failed",
      error: expect.stringContaining("did not match requested variant"),
    });
  });

  it("uses product sitemap as the product route smoke source when catalog feeds are disabled", async () => {
    const requestedStorefrontPaths = [];
    const fetchImpl = releaseFetch(async (url, init) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") {
          return seoPolicyResponse({
            sitemap: {
              enabled: true,
              staticPages: false,
              products: true,
              categories: false,
              collections: false,
              pages: false,
            },
            feeds: {
              productCatalogEnabled: false,
            },
            robots: {
              advertiseSitemap: true,
            },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        requestedStorefrontPaths.push(`${parsed.pathname}${parsed.search}`);
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname === "/sitemap.xml" || parsed.pathname === "/sitemap-products.xml") {
          return discoveryResponse(sitemapXml());
        }
        if (parsed.pathname === "/.well-known/ucp") return ucpProfileResponse();
        if (parsed.pathname === "/ucp/catalog/search") {
          expect(init.method).toBe("POST");
          return emptyUcpSearchResponse();
        }
        if (parsed.pathname === "/ucp/catalog/lookup") {
          expect(JSON.parse(init.body)).toMatchObject({
            ids: ["https://storefront.example.test/products/demo-product"],
          });
          return ucpLookupResponse("https://storefront.example.test/products/demo-product");
        }
        if (parsed.pathname === "/ucp/catalog/product") {
          expect(JSON.parse(init.body)).toMatchObject({
            id: "https://storefront.example.test/products/demo-product",
          });
          return ucpProductResponse();
        }
        if (parsed.pathname === "/products/demo-product") return textResponse(productHtml());
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--skip-wrangler",
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl: vi.fn(),
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.discovery.feed).toMatchObject({ status: "skipped" });
    expect(result.checks.productRoute.url).toBe("https://storefront.example.test/products/demo-product");
    expect(result.checks.ucpDiscovery.catalog.search).toMatchObject({
      productCount: 0,
      fallbackInputId: "https://storefront.example.test/products/demo-product",
    });
    expect(result.checks.ucpDiscovery.catalog.lookup).toMatchObject({
      inputId: "https://storefront.example.test/products/demo-product",
      productCount: 1,
    });
    expect(result.checks.ucpDiscovery.catalog.product).toMatchObject({
      inputId: "https://storefront.example.test/products/demo-product",
      firstVariantId: "gid://scalius/product-variant/var_1",
    });
    expect(requestedStorefrontPaths).toEqual([
      "/health",
      "/",
      "/search",
      "/",
      "/search?sortBy=newest",
      "/checkout",
      "/api/product-feed.xml?limit=5",
      "/api/purge-cache",
      "/",
      "/robots.txt",
      "/sitemap.xml",
      "/sitemap-products.xml?page=1",
      "/.well-known/ucp",
      "/ucp/catalog/search",
      "/ucp/catalog/lookup",
      "/ucp/catalog/product",
      "/products/demo-product",
    ]);
  });

  it("fails UCP discovery when known product URL lookup is not correlated after empty search", async () => {
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") {
          return seoPolicyResponse({
            sitemap: {
              enabled: true,
              staticPages: false,
              products: true,
              categories: false,
              collections: false,
              pages: false,
            },
            feeds: { productCatalogEnabled: false },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname === "/sitemap.xml" || parsed.pathname === "/sitemap-products.xml") {
          return discoveryResponse(sitemapXml());
        }
        if (parsed.pathname === "/.well-known/ucp") return ucpProfileResponse();
        if (parsed.pathname === "/ucp/catalog/search") return emptyUcpSearchResponse();
        if (parsed.pathname === "/ucp/catalog/lookup") {
          expect(JSON.parse(init.body)).toMatchObject({
            ids: ["https://storefront.example.test/products/demo-product"],
          });
          return ucpLookupResponse("gid://scalius/product-variant/other");
        }
        if (parsed.pathname === "/products/demo-product") return textResponse(productHtml());
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain(
      "UCP catalog lookup did not correlate requested id: https://storefront.example.test/products/demo-product",
    );
    expect(thrown.result.checks.ucpDiscovery).toMatchObject({
      status: "failed",
      error: expect.stringContaining("did not correlate requested id"),
    });
  });

  it("skips Product JSON-LD smoke when public SEO policy disables product schema", async () => {
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") {
          return seoPolicyResponse({
            sitemap: {
              enabled: true,
              staticPages: false,
              products: true,
              categories: false,
              collections: false,
              pages: false,
            },
            feeds: { productCatalogEnabled: false },
            structuredData: { products: false },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname === "/sitemap.xml" || parsed.pathname === "/sitemap-products.xml") {
          return discoveryResponse(sitemapXml());
        }
        if (parsed.pathname === "/.well-known/ucp") return ucpProfileResponse();
        if (parsed.pathname === "/ucp/catalog/search") {
          return jsonResponse({
            ucp: { version: "2026-07", status: "success" },
            products: [],
            pagination: { has_next_page: false, total_count: 0 },
          });
        }
        if (parsed.pathname === "/ucp/catalog/lookup") {
          expect(JSON.parse(init.body)).toMatchObject({
            ids: ["https://storefront.example.test/products/demo-product"],
          });
          return ucpLookupResponse("https://storefront.example.test/products/demo-product");
        }
        if (parsed.pathname === "/ucp/catalog/product") {
          expect(JSON.parse(init.body)).toMatchObject({
            id: "https://storefront.example.test/products/demo-product",
          });
          return ucpProductResponse();
        }
        if (parsed.pathname === "/products/demo-product") {
          return textResponse("<!doctype html><html><body>Demo Product</body></html>");
        }
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--skip-wrangler",
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl: vi.fn(),
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.discovery.policy.structuredData).toMatchObject({
      products: false,
    });
    expect(result.checks.productRoute).toMatchObject({
      url: "https://storefront.example.test/products/demo-product",
      schema: {
        status: "skipped",
        reason: "Product JSON-LD disabled by public SEO policy.",
      },
    });
  });

  it.each([
    {
      label: "unknown shape",
      seoResponse: () => jsonResponse({
        success: true,
        data: {
          discovery: {
            sitemap: { enabled: false },
          },
        },
      }),
    },
    {
      label: "failed fetch",
      seoResponse: () => textResponse("unavailable", 503),
    },
  ])("fails when public SEO policy has $label", async ({ seoResponse }) => {
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") return seoResponse();
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxtWithoutSitemap());
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("Public SEO policy failed");
    expect(thrown.result.checks.discovery).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Public SEO policy failed"),
    });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toContain("/api/v1/seo");
  });

  it("keeps strict discovery fallback only when explicitly allowed", async () => {
    const fetchImpl = releaseFetch(async (url) => {
      const parsed = new URL(url);

      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") {
          return jsonResponse({
            success: true,
            data: { discovery: { sitemap: { enabled: false } } },
          });
        }
      }

      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }

      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxtWithoutSitemap());
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--skip-wrangler",
        "--allow-strict-seo-policy-fallback",
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl: vi.fn(),
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("robots.txt failed");
    expect(thrown.message).toContain("must advertise at least one absolute Sitemap URL");
    const requestedPaths = fetchImpl.mock.calls.map(([url]) => new URL(url).pathname);
    expect(requestedPaths).toContain("/api/v1/seo");
    expect(requestedPaths).toContain("/robots.txt");
  });

  it.each([
    {
      label: "persistent degraded readiness",
      responses: [degradedResponse(), degradedResponse(), degradedResponse(), degradedResponse()],
      expectedDetail: "0/4 ready",
    },
    {
      label: "final degraded readiness",
      responses: [readyResponse(), readyResponse(), readyResponse(), degradedResponse()],
      expectedDetail: "3/4 ready; final=503",
    },
  ])("fails $label during API ops", async ({ responses, expectedDetail }) => {
    const readyzResponses = [...responses];
    const fetchImpl = releaseFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyzResponses.shift() ?? degradedResponse();
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn();

    let thrown;
    try {
      await runReleaseCheck(parseReleaseCheckArgs([
        "--api-base-url", "https://api.example.test",
        "--storefront-url", "https://storefront.example.test",
        "--dashboard-url", "https://dashboard.example.test",
      ]), {
        apiConfig: monitoringApiConfig(),
        fetchImpl,
        execFileImpl,
        rootDir: "/repo",
        readFileImpl: () => verifiedTracker(),
        fileExistsImpl: () => true,
        pnpmExecutable: "pnpm",
        logger: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("API /readyz remained degraded");
    expect(thrown.message).toContain(expectedDetail);
    expect(thrown.result.checks.apiOps).toMatchObject({
      status: "failed",
      error: expect.stringContaining(expectedDetail),
    });
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname === "/api/v1/readyz")).toHaveLength(4);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("skips live checks without calling fetch or exec", async () => {
    const fetchImpl = vi.fn();
    const execFileImpl = vi.fn();

    const result = await runReleaseCheck(parseReleaseCheckArgs(["--skip-live"]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.live).toMatchObject({ status: "skipped" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("honors --skip-wrangler while still running live HTTP checks", async () => {
    const fetchImpl = releaseFetch(async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === "api.example.test") {
        if (parsed.pathname === "/api/v1/health") return textResponse("ok");
        if (parsed.pathname === "/api/v1/readyz") return readyResponse();
        if (parsed.pathname === "/api/v1/openapi.json") return openApiResponse({ "/x": {} });
        if (parsed.pathname === "/api/v1/seo") return seoPolicyResponse();
      }
      if (parsed.hostname === "dashboard.example.test" && parsed.pathname === "/admin") {
        return textResponse("", 307, { location: "/auth/login" });
      }
      if (parsed.hostname === "storefront.example.test") {
        if (parsed.pathname === "/health") return textResponse("ok");
        if (parsed.pathname === "/" || parsed.pathname === "/search") return textResponse("<html></html>");
        if (parsed.pathname === "/robots.txt") return discoveryResponse(robotsTxt());
        if (parsed.pathname.startsWith("/sitemap-") || parsed.pathname === "/sitemap.xml") {
          return discoveryResponse(sitemapXml());
        }
        if (
          (parsed.pathname === "/api/product-feed.xml" || parsed.pathname === "/api/facebook-feed.xml") &&
          (parsed.search === "?limit=5" || parsed.search === "?page=2&limit=5")
        ) {
          return discoveryResponse(
            feedXml({
              availability: parsed.pathname === "/api/product-feed.xml"
                ? "in_stock"
                : "in stock",
            }),
            FEED_CACHE_CONTROL,
          );
        }
        if (parsed.pathname === "/.well-known/ucp") return ucpProfileResponse();
        if (parsed.pathname === "/ucp/catalog/search") {
          return jsonResponse({
            ucp: { version: "2026-07", status: "success" },
            products: [],
            pagination: { has_next_page: false, total_count: 0 },
          });
        }
        if (parsed.pathname === "/ucp/catalog/lookup") {
          expect(JSON.parse(init.body)).toMatchObject({
            ids: ["https://storefront.example.test/products/demo-product"],
          });
          return ucpLookupResponse("https://storefront.example.test/products/demo-product");
        }
        if (parsed.pathname === "/ucp/catalog/product") {
          expect(JSON.parse(init.body)).toMatchObject({
            id: "https://storefront.example.test/products/demo-product",
          });
          return ucpProductResponse();
        }
        if (parsed.pathname === "/products/demo-product") return textResponse(productHtml());
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn();

    const result = await runReleaseCheck(parseReleaseCheckArgs([
      "--skip-wrangler",
      "--api-base-url", "https://api.example.test",
      "--storefront-url", "https://storefront.example.test",
      "--dashboard-url", "https://dashboard.example.test",
    ]), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      rootDir: "/repo",
      readFileImpl: () => verifiedTracker(),
      fileExistsImpl: () => true,
      logger: null,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.apiOps).toMatchObject({
      deploymentStatus: "skipped",
    });
    expect(result.checks.agentMcp).toMatchObject({
      status: "skipped",
      reason: "Skipped by --skip-wrangler.",
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});
