#!/usr/bin/env node

import { execFile as execFileCallback } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";
import {
  buildApiV1Url,
  parseOpsCheckArgs,
  readApiWranglerConfig,
  runOpsCheck,
} from "./ops-check.mjs";

const execFileAsync = promisify(execFileCallback);
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(__dirname, "..");
const defaultApiConfigPath = resolve(defaultRootDir, "apps/api/wrangler.jsonc");

const DEFAULT_API_BASE_URL = "https://api.scalius.com";
const DEFAULT_STOREFRONT_URL = "https://storefront.scalius.com";
export const DEFAULT_DASHBOARD_URL = "https://dashboard.scalius.com";
export const DEFAULT_AGENT_URL = "https://scalius-storefront-agent.abnidaala.workers.dev";
const DEFAULT_TIMEOUT_MS = 10_000;
const RELEASE_READYZ_SAMPLES = 4;
const MAX_BODY_PREVIEW_LENGTH = 180;
const ADMIN_BUSINESS_SETTINGS_PATH = "/api/v1/admin/settings/business";
const ADMIN_ASSISTANT_MCP_PATH = "/api/assistant/mcp";
const STOREFRONT_ASSISTANT_CHAT_PATH = "/api/assistant/chat";
const ADMIN_DASHBOARD_SUMMARY_PATH = "/api/v1/admin/dashboard/metrics-summary";
const ADMIN_SETTINGS_SUMMARY_PATH = "/api/v1/admin/settings/mcp-summary";
const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH =
  "/api/v1/admin/settings/notification-channels/mcp-summary";
const ADMIN_ANALYTICS_HEALTH_PATH = "/api/v1/admin/analytics/health";
const ADMIN_CUSTOMERS_MCP_SEARCH_PATH = "/api/v1/admin/customers/mcp-search";
const ADMIN_PRODUCT_COPY_CONTEXT_PATH = "/api/v1/admin/products/{id}";
const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_VERSION =
  "admin-notification-settings-summary:v1";
const ADMIN_ANALYTICS_SUMMARY_VERSION = "admin-analytics-summary:v1";
const INVALID_ADMIN_SESSION_COOKIE = "better-auth.session_token=release-check-invalid";
const ADMIN_API_READ_TIMEOUT_CODE = "ADMIN_API_READ_TIMEOUT";
const RELEASE_ADMIN_EMAIL_ENV = "SCALIUS_RELEASE_ADMIN_EMAIL";
const RELEASE_ADMIN_PASSWORD_ENV = "SCALIUS_RELEASE_ADMIN_PASSWORD";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_ACCEPT_HEADER = "application/json, text/event-stream";
const MCP_CLIENT_INFO = Object.freeze({
  name: "scalius-release-check",
  version: "1.0.0",
});
const ADMIN_SESSION_COOKIE_NAMES = Object.freeze([
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
]);
const ADMIN_MCP_EXPECTED_TOOL_NAMES = Object.freeze([
  "admin_session_context",
  "admin_navigation_context",
  "admin_dashboard_summary",
  "admin_settings_summary",
  "admin_notification_settings_summary",
  "admin_analytics_summary",
  "admin_category_search",
  "admin_collection_search",
  "admin_customer_search",
  "admin_inventory_lookup",
  "admin_media_search",
  "admin_page_search",
  "admin_product_copy_context",
  "admin_product_search",
  "admin_order_search",
]);
const ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE = Object.freeze({
  name: "admin_navigation_context",
  arguments: Object.freeze({}),
});
const ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE = Object.freeze({
  name: "admin_dashboard_summary",
  arguments: Object.freeze({}),
});
const ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE = Object.freeze({
  name: "admin_settings_summary",
  arguments: Object.freeze({}),
});
const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE = Object.freeze({
  name: "admin_notification_settings_summary",
  arguments: Object.freeze({}),
});
const ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE = Object.freeze({
  name: "admin_analytics_summary",
  arguments: Object.freeze({}),
});
const ADMIN_CATEGORY_SEARCH_TOOL_SMOKE = Object.freeze({
  name: "admin_category_search",
  arguments: Object.freeze({
    query: "test",
    limit: 1,
    page: 1,
  }),
});
const ADMIN_COLLECTION_SEARCH_TOOL_SMOKE = Object.freeze({
  name: "admin_collection_search",
  arguments: Object.freeze({
    query: "test",
    limit: 1,
    page: 1,
  }),
});
const ADMIN_PAGE_SEARCH_TOOL_SMOKE = Object.freeze({
  name: "admin_page_search",
  arguments: Object.freeze({
    query: "test",
    limit: 1,
    page: 1,
  }),
});
const ADMIN_MEDIA_SEARCH_TOOL_SMOKE = Object.freeze({
  name: "admin_media_search",
  arguments: Object.freeze({
    query: "test",
    limit: 1,
    page: 1,
  }),
});
const ADMIN_INVENTORY_LOOKUP_TOOL_SMOKE = Object.freeze({
  name: "admin_inventory_lookup",
  arguments: Object.freeze({
    query: "test",
    limit: 1,
    page: 1,
  }),
});
const ADMIN_PRODUCT_SEARCH_TOOL_SMOKE = Object.freeze({
  name: "admin_product_search",
  arguments: Object.freeze({
    query: "test",
    limit: 1,
    page: 1,
  }),
});
const ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME = "admin_product_copy_context";
const ADMIN_ORDER_SEARCH_TOOL_SMOKE = Object.freeze({
  name: "admin_order_search",
  arguments: Object.freeze({
    query: "DW8W05",
    limit: 1,
    page: 1,
  }),
});
const ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE = Object.freeze({
  name: "admin_customer_search",
  arguments: Object.freeze({
    query: "release-check@example.test +8801712345678",
    limit: 1,
    page: 1,
  }),
});
const AGENT_EXPECTED_TOOL_NAMES = Object.freeze([
  "cart_validate",
  "catalog_categories",
  "catalog_search",
  "catalog_lookup",
  "catalog_product",
  "catalog_profile",
  "storefront_discovery_policy",
]);
const AGENT_CATALOG_TOOL_SMOKE = Object.freeze({
  name: "catalog_profile",
  arguments: Object.freeze({}),
});
const AGENT_CATALOG_CATEGORIES_TOOL_SMOKE = Object.freeze({
  name: "catalog_categories",
  arguments: Object.freeze({
    limit: 1,
  }),
});
const AGENT_POLICY_TOOL_SMOKE = Object.freeze({
  name: "storefront_discovery_policy",
  arguments: Object.freeze({}),
});
const AGENT_CATALOG_SEARCH_TOOL_SMOKE = Object.freeze({
  name: "catalog_search",
  arguments: Object.freeze({
    query: "test",
    limit: 1,
  }),
});
const AGENT_CART_VALIDATION_TOOL_SMOKE = Object.freeze({
  name: "cart_validate",
  arguments: Object.freeze({
    items: Object.freeze([
      Object.freeze({
        productId: "release-check-missing-product",
        variantId: "release-check-missing-variant",
        quantity: 1,
        unitPrice: 1,
      }),
    ]),
  }),
});
const STOREFRONT_CHAT_SMOKE_BODY = Object.freeze({
  messages: Object.freeze([
    Object.freeze({
      role: "user",
      content: "Do you sell any release-check-catalog-probe products?",
    }),
  ]),
  pageContext: Object.freeze({
    version: 1,
    source: "storefront",
    page: Object.freeze({
      path: "/",
      route: "/",
      canonicalUrl: null,
      title: "Release check",
      kind: "home",
    }),
    cart: Object.freeze({
      totalItems: 0,
      subtotalAmount: 0,
      lineCount: 0,
      lines: Object.freeze([]),
      hasDiscount: false,
      truncated: false,
    }),
  }),
});
const ADMIN_MCP_UNAUTHENTICATED_SMOKE_BODY = Object.freeze({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: Object.freeze({
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: Object.freeze({}),
    clientInfo: MCP_CLIENT_INFO,
  }),
});
const AGENT_FORBIDDEN_TOOL_TERM_PATTERN =
  /(?:^|[^a-z0-9])(?:checkout|orders?|payments?|customers?|recovery)(?:$|[^a-z0-9])/i;
const AGENT_CART_TERM_PATTERN = /(?:^|[^a-z0-9])carts?(?:$|[^a-z0-9])/i;
const AGENT_CART_MUTATION_TERM_PATTERN =
  /(?:^|[^a-z0-9])(?:mutate|mutation|mutations|write|update|add|remove|clear|checkout|orders?|payments?|customers?|recovery)(?:$|[^a-z0-9])/i;
const STOREFRONT_CHAT_FAIL_CLOSED_PATTERN =
  /(?:disabled|unconfigured|not configured|missing (?:ai )?(?:model|provider|credentials?)|credentials? (?:missing|unavailable|not configured)|profile .*not ready|storefrontchat.*(?:not ready|unavailable))/i;
const STOREFRONT_CHAT_SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const STOREFRONT_CHAT_SAFE_QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const STOREFRONT_CHAT_EMAIL_QUERY_VALUE_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const STOREFRONT_CHAT_BANGLADESH_PHONE_QUERY_VALUE_PATTERN =
  /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/;
const STOREFRONT_CHAT_BROAD_PHONE_QUERY_VALUE_PATTERN =
  /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/;
const STOREFRONT_CHAT_SENSITIVE_QUERY_NAME_PATTERN =
  /(?:auth|bearer|code|credential|customer|email|jwt|key|mobile|otp|pass|password|phone|proof|receipt|secret|session|sig|signature|token)/i;
const STOREFRONT_CHAT_TOKEN_LIKE_QUERY_VALUE_PATTERN =
  /(?:\bBearer\s+|(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?|[A-Fa-f0-9]{32,})/i;
const STOREFRONT_CHAT_RAW_PATH_TRAVERSAL_PATTERN = /(^|\/)\.{1,2}(?:\/|$|[?#])/;
const STOREFRONT_CHAT_ENCODED_UNSAFE_PATH_PATTERN = /%(?:2e|2f|5c)/i;
const STOREFRONT_CHAT_NAVIGATION_TARGET_KEYS = Object.freeze([
  "path",
  "target",
  "url",
  "href",
]);
const STOREFRONT_CHAT_UNSAFE_ACTION_KEY_PATTERN =
  /^(?:autoExecute|autoNavigate|body|endpoint|execute|formData|handler|headers|method|mutation|payload|request)$/i;
const STOREFRONT_CHAT_BLOCKED_BUYER_PATH_SEGMENTS = new Set([
  "account",
  "admin",
  "api",
  "auth",
  "buy",
  "checkout",
  "order",
  "order-success",
  "orders",
  "payment",
  "payment-recovery",
  "private",
  "receipt",
  "receipts",
  "recovery",
  "status",
]);
const STOREFRONT_CHAT_RESERVED_CMS_PAGE_SLUGS = new Set([
  ...STOREFRONT_CHAT_BLOCKED_BUYER_PATH_SEGMENTS,
  "cart",
  "categories",
  "collections",
  "products",
  "search",
]);
const ADMIN_MCP_MUTATION_TOOL_TERM_PATTERN =
  /(?:^|[^a-z0-9])(?:add|archive|approve|cancel|capture|charge|clear|complete|create|delete|disable|enable|fulfill|import|invite|mark|mutate|mutation|mutations|publish|purge|reconcile|refund|remove|repair|restore|retry|set|ship|submit|sync|update|upsert|void|write)(?:$|[^a-z0-9])/i;
const ADMIN_DASHBOARD_SUMMARY_FORBIDDEN_KEY_PATTERN =
  /^(?:recentOrders|customerName|customerEmail|customerPhone|orderIds?|orderNumbers?|paymentEvidence|providerPayloads?|totalRevenue|lifetimeRevenue|dailyActivity|mutation)$/i;
const ADMIN_DASHBOARD_SUMMARY_FORBIDDEN_VALUE_PATTERN =
  /\b(?:recentOrders?|customerName|customerEmail|customerPhone|orderIds?|orderNumbers?|paymentEvidence|providerPayloads?|totalRevenue|lifetimeRevenue|dailyActivity|mutation)\b/i;
const ADMIN_SETTINGS_SUMMARY_FORBIDDEN_KEY_PATTERN =
  /(?:credentials?|tokens?|apiKeys?|secrets?|passwords?|cookies?|sessions?|otps?|receiptProof|providerPayloads?|rawSnippet|analyticsSnippet|customerEmail|customerPhone)/i;
const ADMIN_SETTINGS_SUMMARY_FORBIDDEN_VALUE_PATTERN =
  /\b(?:credentials?|tokens?|apiKeys?|secrets?|passwords?|cookies?|sessions?|otps?|receiptProof|providerPayloads?|rawSnippet|analyticsSnippet|customerEmail|customerPhone)\b/i;
const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_FORBIDDEN_KEY_PATTERN =
  /(?:credentials?|tokens?|apiKeys?|secrets?|passwords?|cookies?|sessions?|otps?|recipients?|recipientEmail|recipientPhone|orderIds?|deliveryReceipts?|providerPayloads?|providerMessages?|rawProviderErrors?|rawErrors?|rawMessages?|message|messages|templateName|languageCode|provider|providers)/i;
const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_FORBIDDEN_VALUE_PATTERN =
  /\b(?:credentials?|tokens?|apiKeys?|secrets?|passwords?|cookies?|sessions?|otps?|recipient|recipientEmail|recipientPhone|orderIds?|deliveryReceipts?|providerPayloads?|providerMessages?|rawProviderErrors?|rawErrors?|rawMessages?|templateName|languageCode|smsnetbd|resend|firebase|private[_ -]?key|access[_ -]?token|api[_ -]?key|graph api|invalid_grant)\b/i;
const ADMIN_ANALYTICS_SUMMARY_FORBIDDEN_KEY_PATTERN =
  /^(?:config|rawConfig|scriptConfig|snippet|rawSnippet|analyticsSnippet|customCode|htmlContent|jsContent|credential|credentials|token|accessToken|apiKey|secret|password|cookie|session|message|messages|issues|providerPayload|pixelId|measurementId|gtmId|beaconToken)$/i;
const ADMIN_ANALYTICS_SUMMARY_FORBIDDEN_VALUE_PATTERN =
  /(?:\b(?:access[_ -]?token|api[_ -]?key|secret|password|cookie|session|raw[_ -]?snippet|analytics[_ -]?snippet|custom[_ -]?code|measurement[_ -]?id|pixel[_ -]?id)\b|<script|data-cf-beacon)/i;
const ADMIN_CUSTOMER_SEARCH_RAW_QUERY_TERMS = Object.freeze([
  "release-check@example.test",
  "+8801712345678",
]);
const ADMIN_CUSTOMER_SEARCH_EMAIL_VALUE_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const ADMIN_CUSTOMER_SEARCH_PHONE_VALUE_PATTERN =
  /(?:\+?880|0)1[3-9]\d{8}/;
const ADMIN_PRODUCT_COPY_CONTEXT_FORBIDDEN_KEY_PATTERN =
  /(?:prices?|discounts?|skus?|stock|barcodes?|images?|primaryImage|variants?|deleted|providerPayloads?)/i;
const ADMIN_CUSTOMER_SEARCH_ALLOWED_TOP_LEVEL_KEYS = new Set([
  "source",
  "request",
  "customers",
  "pagination",
  "limits",
]);
const ADMIN_CUSTOMER_SEARCH_ALLOWED_SOURCE_KEYS = new Set(["path", "permission"]);
const ADMIN_CUSTOMER_SEARCH_ALLOWED_REQUEST_KEYS = new Set([
  "hasQuery",
  "page",
  "limit",
  "sort",
  "order",
]);
const ADMIN_CUSTOMER_SEARCH_ALLOWED_CUSTOMER_KEYS = new Set([
  "id",
  "totalOrders",
  "totalSpent",
  "lastOrderAt",
  "createdAt",
  "updatedAt",
]);
const ADMIN_CUSTOMER_SEARCH_ALLOWED_PAGINATION_KEYS = new Set([
  "page",
  "limit",
  "total",
  "totalPages",
]);
const ADMIN_CUSTOMER_SEARCH_ALLOWED_LIMIT_KEYS = new Set([
  "maxCustomers",
  "maxPage",
  "includesRawQuery",
  "includesTrashed",
  "includesNames",
  "includesContacts",
  "includesAddresses",
  "includesLocation",
  "includesHistory",
  "includesOrders",
  "canMutate",
]);
const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";
const UCP_CATALOG_SEARCH_CAPABILITY = "dev.ucp.shopping.catalog.search";
const UCP_CATALOG_LOOKUP_CAPABILITY = "dev.ucp.shopping.catalog.lookup";
const UCP_FORBIDDEN_CAPABILITY_PATTERN = /\b(?:checkout|carts?|orders?|payments?|payment_handlers)\b/i;
const UCP_AGENT_HEADER = 'profile="https://release-check.scalius.com/.well-known/ucp"';
const SITEMAP_SECTION_ENDPOINTS = [
  { endpoint: "/sitemap-static.xml", policyKey: "staticPages", label: "static pages sitemap" },
  { endpoint: "/sitemap-products.xml?page=1", policyKey: "products", label: "products sitemap" },
  { endpoint: "/sitemap-categories.xml", policyKey: "categories", label: "categories sitemap" },
  { endpoint: "/sitemap-collections.xml", policyKey: "collections", label: "collections sitemap" },
  { endpoint: "/sitemap-pages.xml", policyKey: "pages", label: "CMS pages sitemap" },
];
const FEED_ENDPOINTS = [
  {
    endpoint: "/api/product-feed.xml?limit=5",
    resultKey: "feed",
    label: "canonical product feed",
    page2Endpoint: "/api/product-feed.xml?page=2&limit=5",
    availabilityValues: ["in_stock", "out_of_stock"],
  },
  {
    endpoint: "/api/facebook-feed.xml?limit=5",
    resultKey: "compatibilityFeed",
    label: "compatibility Facebook feed",
    page2Endpoint: "/api/facebook-feed.xml?page=2&limit=5",
    availabilityValues: ["in stock", "out of stock"],
  },
];
const STOREFRONT_CACHE_HEADER_PATHS = [
  "/",
  "/search?sortBy=newest",
  "/checkout",
  "/api/product-feed.xml?limit=5",
  "/api/purge-cache",
];
const STRICT_SEO_DISCOVERY_POLICY = Object.freeze({
  source: "strict-default",
  sitemap: Object.freeze({
    enabled: true,
    staticPages: true,
    products: true,
    categories: true,
    collections: true,
    pages: true,
  }),
  feeds: Object.freeze({
    productCatalogEnabled: true,
  }),
  robots: Object.freeze({
    advertiseSitemap: true,
  }),
  structuredData: Object.freeze({
    organization: true,
    websiteSearch: true,
    products: true,
    productGroups: true,
    offerShippingDetails: true,
    breadcrumbs: true,
    collections: true,
  }),
});

const closedTrackerStatuses = new Set(["verified", "won't fix", "won’t fix", "wont fix"]);
const booleanOptions = new Set([
  "help",
  "json",
  "skip-live",
  "skip-wrangler",
  "allow-strict-seo-policy-fallback",
]);
const stringOptions = new Set([
  "timeout-ms",
  "api-base-url",
  "storefront-url",
  "dashboard-url",
  "agent-url",
]);
const knownOptions = new Set([...booleanOptions, ...stringOptions]);

const requiredDocs = [
  "audit/REMEDIATION_TRACKER.md",
  "audit/VERIFICATION_PLAYBOOK.md",
  "audit/STABLE_RELEASE_CHECKLIST.md",
  "docs/codex/PLATFORM-GOAL.md",
  "docs/codex/README.md",
  "docs/ARCHITECTURE.md",
  "README.md",
  "AGENTS.md",
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Option --${optionName} must be a positive integer.`);
  }
  return number;
}

function parseRawOptions(rawArgs) {
  const options = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown positional argument: ${arg}`);
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    if (!knownOptions.has(name)) {
      throw new Error(`Unknown option --${name}.`);
    }

    if (booleanOptions.has(name)) {
      if (equalsIndex >= 0) {
        throw new Error(`Option --${name} does not take a value.`);
      }
      options[name] = true;
      continue;
    }

    const value = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : rawArgs[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option --${name} requires a value.`);
    }
    options[name] = value;
    if (equalsIndex < 0) index += 1;
  }

  return options;
}

export function normalizeHttpBaseUrl(value, label = "URL") {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be a valid URL: ${errorMessage(error)}`, { cause: error });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use http or https: ${value}`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials.`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function parseReleaseCheckArgs(rawArgs, {
  defaultApiBaseUrl = DEFAULT_API_BASE_URL,
  defaultStorefrontUrl = DEFAULT_STOREFRONT_URL,
  defaultDashboardUrl = DEFAULT_DASHBOARD_URL,
  defaultAgentUrl = DEFAULT_AGENT_URL,
} = {}) {
  const rawOptions = parseRawOptions(rawArgs);
  if (rawOptions.help) return { help: true };

  return {
    help: false,
    json: rawOptions.json === true,
    skipLive: rawOptions["skip-live"] === true,
    skipWrangler: rawOptions["skip-wrangler"] === true,
    allowStrictSeoPolicyFallback:
      rawOptions["allow-strict-seo-policy-fallback"] === true,
    timeoutMs: rawOptions["timeout-ms"] === undefined
      ? DEFAULT_TIMEOUT_MS
      : parsePositiveInteger(rawOptions["timeout-ms"], "timeout-ms"),
    apiBaseUrl: normalizeHttpBaseUrl(rawOptions["api-base-url"] ?? defaultApiBaseUrl, "API base URL"),
    storefrontUrl: normalizeHttpBaseUrl(rawOptions["storefront-url"] ?? defaultStorefrontUrl, "Storefront URL"),
    dashboardUrl: normalizeHttpBaseUrl(rawOptions["dashboard-url"] ?? defaultDashboardUrl, "Dashboard URL"),
    agentUrl: normalizeHttpBaseUrl(rawOptions["agent-url"] ?? defaultAgentUrl, "Agent URL"),
  };
}

function buildUrl(baseUrl, path) {
  const url = new URL(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${normalizedPath}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildUrlWithSearch(baseUrl, pathWithSearch) {
  const [path, search = ""] = pathWithSearch.split("?");
  const url = new URL(buildUrl(baseUrl, path));
  if (search) url.search = search;
  return url.toString();
}

function redactUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|key|proof|password|otp/i.test(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }
  return url.toString();
}

function responsePreview(body) {
  return body.replace(/\s+/g, " ").trim().slice(0, MAX_BODY_PREVIEW_LENGTH);
}

function appendUnique(list, values) {
  for (const value of values) {
    if (typeof value === "string" && value && !list.includes(value)) {
      list.push(value);
    }
  }
}

function requestHeaders(accept) {
  return {
    Accept: accept,
    "Cache-Control": "no-cache",
  };
}

async function fetchJson(url, {
  fetchImpl,
  timeoutMs,
  method = "GET",
  body,
  headers = {},
}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestInit = {
    method,
    headers: {
      ...requestHeaders("application/json, */*;q=0.8"),
      ...headers,
    },
    signal: controller.signal,
  };

  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
    requestInit.headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetchImpl(url, requestInit);
    const responseBody = await response.text();
    return {
      url,
      statusCode: response.status,
      ok: response.ok,
      body: responseBody,
      headers: response.headers,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, {
  fetchImpl,
  timeoutMs,
  accept = "text/plain, text/html, application/xml, text/xml;q=0.9, */*;q=0.8",
  redirect = "follow",
}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: requestHeaders(accept),
      redirect,
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      url,
      statusCode: response.status,
      ok: response.ok,
      body,
      headers: response.headers,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function requireStatus(response, label, allowed) {
  if (!allowed(response.statusCode)) {
    throw new Error(
      `${label} returned HTTP ${response.statusCode}: ${responsePreview(response.body)}`,
    );
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isSameOrigin(value, origin) {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnField(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function readBoolean(record, key) {
  return typeof record?.[key] === "boolean" ? record[key] : null;
}

function getSeoSettingsPayload(payload) {
  if (isRecord(payload) && isRecord(payload.data)) return payload.data;
  return isRecord(payload) ? payload : null;
}

function parseSeoDiscoveryPolicyPayload(payload) {
  const settings = getSeoSettingsPayload(payload);
  const discovery = isRecord(settings?.discovery) ? settings.discovery : null;
  const sitemap = isRecord(discovery?.sitemap) ? discovery.sitemap : null;
  const feeds = isRecord(discovery?.feeds) ? discovery.feeds : null;
  const robots = isRecord(discovery?.robots) ? discovery.robots : null;
  const structuredData = isRecord(discovery?.structuredData)
    ? discovery.structuredData
    : null;

  if (!sitemap || !feeds || !robots || !structuredData) return null;

  const parsed = {
    source: "public-seo",
    sitemap: {
      enabled: readBoolean(sitemap, "enabled"),
      staticPages: readBoolean(sitemap, "staticPages"),
      products: readBoolean(sitemap, "products"),
      categories: readBoolean(sitemap, "categories"),
      collections: readBoolean(sitemap, "collections"),
      pages: readBoolean(sitemap, "pages"),
    },
    feeds: {
      productCatalogEnabled: readBoolean(feeds, "productCatalogEnabled"),
    },
    robots: {
      advertiseSitemap: readBoolean(robots, "advertiseSitemap"),
    },
    structuredData: {
      organization: readBoolean(structuredData, "organization"),
      websiteSearch: readBoolean(structuredData, "websiteSearch"),
      products: readBoolean(structuredData, "products"),
      productGroups: readBoolean(structuredData, "productGroups"),
      offerShippingDetails: readBoolean(structuredData, "offerShippingDetails"),
      breadcrumbs: readBoolean(structuredData, "breadcrumbs"),
      collections: readBoolean(structuredData, "collections"),
    },
  };

  const complete =
    Object.values(parsed.sitemap).every((value) => typeof value === "boolean") &&
    typeof parsed.feeds.productCatalogEnabled === "boolean" &&
    typeof parsed.robots.advertiseSitemap === "boolean" &&
    Object.values(parsed.structuredData).every((value) => typeof value === "boolean");

  return complete ? parsed : null;
}

function countEnabledSitemapSections(policy) {
  if (!policy.sitemap.enabled) return 0;
  return SITEMAP_SECTION_ENDPOINTS.filter(({ policyKey }) => policy.sitemap[policyKey]).length;
}

function summarizeSeoDiscoveryPolicy(policy) {
  const enabledSections = countEnabledSitemapSections(policy);
  const feedStatus = policy.feeds.productCatalogEnabled ? "feed enabled" : "feed disabled";
  const robotsStatus =
    policy.sitemap.enabled && policy.robots.advertiseSitemap
      ? "robots advertises sitemap"
      : "robots sitemap advertisement disabled";
  const productSchemaStatus = policy.structuredData.products
    ? "Product schema enabled"
    : "Product schema disabled";
  const globalSchemaStatus =
    policy.structuredData.organization || policy.structuredData.websiteSearch
      ? "global schema enabled"
      : "global schema disabled";
  return `sitemap ${policy.sitemap.enabled ? `${enabledSections} sections enabled` : "disabled"}, ${feedStatus}, ${robotsStatus}, ${productSchemaStatus}, ${globalSchemaStatus}`;
}

function strictSeoPolicyResult(url, reason, extra = {}) {
  return {
    source: STRICT_SEO_DISCOVERY_POLICY.source,
    url: redactUrl(url),
    reason,
    sitemap: STRICT_SEO_DISCOVERY_POLICY.sitemap,
    feeds: STRICT_SEO_DISCOVERY_POLICY.feeds,
    robots: STRICT_SEO_DISCOVERY_POLICY.robots,
    structuredData: STRICT_SEO_DISCOVERY_POLICY.structuredData,
    ...extra,
  };
}

function seoPolicyFailure(url, reason, extra = {}) {
  const result = strictSeoPolicyResult(url, reason, {
    status: "failed",
    ...extra,
  });
  const error = new Error(`Public SEO policy failed: ${reason}`);
  error.result = result;
  return error;
}

function strictSeoFallbackAllowed(options) {
  return options.allowStrictSeoPolicyFallback === true;
}

async function fetchSeoDiscoveryPolicy(options, { fetchImpl, logger }) {
  const url = buildApiV1Url(options.apiBaseUrl, "/seo");

  try {
    const response = await fetchText(url, {
      fetchImpl,
      timeoutMs: options.timeoutMs,
      accept: "application/json, */*;q=0.8",
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const reason = `Public SEO policy returned HTTP ${response.statusCode}.`;
      if (!strictSeoFallbackAllowed(options)) {
        throw seoPolicyFailure(url, reason, {
          statusCode: response.statusCode,
          durationMs: response.durationMs,
        });
      }
      const fallbackReason = `${reason} Using strict discovery defaults because --allow-strict-seo-policy-fallback was provided.`;
      logger?.warn(`WARN SEO policy: ${fallbackReason}`);
      return {
        policy: STRICT_SEO_DISCOVERY_POLICY,
        result: strictSeoPolicyResult(url, fallbackReason, {
          statusCode: response.statusCode,
          durationMs: response.durationMs,
        }),
      };
    }

    let payload;
    try {
      payload = response.body ? JSON.parse(response.body) : null;
    } catch (error) {
      const reason = `Public SEO policy returned invalid JSON (${errorMessage(error)}).`;
      if (!strictSeoFallbackAllowed(options)) {
        throw seoPolicyFailure(url, reason, {
          statusCode: response.statusCode,
          durationMs: response.durationMs,
        });
      }
      const fallbackReason = `${reason} Using strict discovery defaults because --allow-strict-seo-policy-fallback was provided.`;
      logger?.warn(`WARN SEO policy: ${fallbackReason}`);
      return {
        policy: STRICT_SEO_DISCOVERY_POLICY,
        result: strictSeoPolicyResult(url, fallbackReason, {
          statusCode: response.statusCode,
          durationMs: response.durationMs,
        }),
      };
    }

    const policy = parseSeoDiscoveryPolicyPayload(payload);
    if (!policy) {
      const reason = "Public SEO policy shape is unknown.";
      if (!strictSeoFallbackAllowed(options)) {
        throw seoPolicyFailure(url, reason, {
          statusCode: response.statusCode,
          durationMs: response.durationMs,
        });
      }
      const fallbackReason = `${reason} Using strict discovery defaults because --allow-strict-seo-policy-fallback was provided.`;
      logger?.warn(`WARN SEO policy: ${fallbackReason}`);
      return {
        policy: STRICT_SEO_DISCOVERY_POLICY,
        result: strictSeoPolicyResult(url, fallbackReason, {
          statusCode: response.statusCode,
          durationMs: response.durationMs,
        }),
      };
    }

    logger?.log(`PASS SEO policy: ${summarizeSeoDiscoveryPolicy(policy)}.`);
    return {
      policy,
      result: {
        source: policy.source,
        url: redactUrl(url),
        statusCode: response.statusCode,
        durationMs: response.durationMs,
        summary: summarizeSeoDiscoveryPolicy(policy),
        sitemap: policy.sitemap,
        feeds: policy.feeds,
        robots: policy.robots,
        structuredData: policy.structuredData,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.result) {
      throw error;
    }
    const reason = `Public SEO policy could not be fetched (${errorMessage(error)}).`;
    if (!strictSeoFallbackAllowed(options)) {
      throw seoPolicyFailure(url, reason);
    }
    const fallbackReason = `${reason} Using strict discovery defaults because --allow-strict-seo-policy-fallback was provided.`;
    logger?.warn(`WARN SEO policy: ${fallbackReason}`);
    return {
      policy: STRICT_SEO_DISCOVERY_POLICY,
      result: strictSeoPolicyResult(url, fallbackReason),
    };
  }
}

function extractTagValues(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "gi");
  const values = [];
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    values.push(decodeXml(match[1].trim()));
  }
  return values;
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function normalizeTrackerStatus(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasPositiveCacheTtl(cacheControl) {
  const matches = cacheControl.matchAll(/\b(?:s-maxage|max-age)=(\d+)\b/gi);
  for (const match of matches) {
    if (Number(match[1]) > 0) return true;
  }
  return false;
}

function normalizeHeaderValue(headers, name) {
  return headers.get(name) ?? "";
}

function hasHeaderToken(value, token) {
  return new RegExp(`(?:^|[,;\\s])${token}(?:$|[,;\\s])`, "i").test(value);
}

function evaluatePublicStorefrontCacheHeaders(headers, { label }) {
  const cacheControl = normalizeHeaderValue(headers, "cache-control");
  const cacheStatus = normalizeHeaderValue(headers, "x-cache-status");
  const normalizedCacheStatus = cacheStatus.toLowerCase();
  const errors = [];

  if (!cacheStatus) {
    errors.push(`${label} must include X-Cache-Status.`);
  } else {
    if (hasHeaderToken(normalizedCacheStatus, "no_cache")) {
      errors.push(`${label} must not report NO_CACHE.`);
    }
    if (!/^[A-Z][A-Z0-9_ -]*(?:;|$)/.test(cacheStatus)) {
      errors.push(`${label} X-Cache-Status must start with a cache state.`);
    }
    if (!/\bv=[^;,\s]+/i.test(cacheStatus)) {
      errors.push(`${label} X-Cache-Status must include a cache version marker.`);
    }
    if (!/\bbuild=[^;,\s]+/i.test(cacheStatus)) {
      errors.push(`${label} X-Cache-Status must include a build marker.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    cacheControl: cacheControl || null,
    cacheStatus: cacheStatus || null,
  };
}

function evaluateCheckoutCacheHeaders(headers) {
  const cacheControl = normalizeHeaderValue(headers, "cache-control");
  const cacheStatus = normalizeHeaderValue(headers, "x-cache-status");
  const normalizedCacheControl = cacheControl.toLowerCase();
  const normalizedCacheStatus = cacheStatus.toLowerCase();
  const errors = [];

  if (!cacheControl) {
    errors.push("checkout must include Cache-Control.");
  } else {
    if (!hasHeaderToken(normalizedCacheControl, "private")) {
      errors.push("checkout Cache-Control must include private.");
    }
    if (!hasHeaderToken(normalizedCacheControl, "no-store")) {
      errors.push("checkout Cache-Control must include no-store.");
    }
  }
  if (!cacheStatus) {
    errors.push("checkout must include X-Cache-Status.");
  } else if (!hasHeaderToken(normalizedCacheStatus, "no_cache")) {
    errors.push("checkout X-Cache-Status must report NO_CACHE.");
  }

  return {
    ok: errors.length === 0,
    errors,
    cacheControl: cacheControl || null,
    cacheStatus: cacheStatus || null,
  };
}

function evaluateFeedGenerationCacheHeaders(headers) {
  const cacheControl = normalizeHeaderValue(headers, "cache-control");
  const cacheStatus = normalizeHeaderValue(headers, "x-cache-status");
  const generationHeader =
    normalizeHeaderValue(headers, "x-cache-generation") ||
    normalizeHeaderValue(headers, "x-storefront-cache-generation");
  const discoveryCache = evaluateDiscoveryCacheHeaders(headers, { label: "product feed" });
  const errors = [...discoveryCache.errors];
  const hasGenerationMarker =
    /\bgen(?:eration)?=[^;,\s]+/i.test(cacheStatus) ||
    generationHeader.trim().length > 0;

  if (!cacheStatus && !generationHeader) {
    errors.push("product feed must include X-Cache-Status or an explicit cache generation header.");
  }
  if (!hasGenerationMarker) {
    errors.push("product feed cache headers must include a generation marker.");
  }

  return {
    ok: errors.length === 0,
    errors,
    cacheControl: cacheControl || null,
    cacheStatus: cacheStatus || null,
    generationHeader: generationHeader || null,
  };
}

function evaluatePurgeGetHeaders(headers) {
  const cacheControl = normalizeHeaderValue(headers, "cache-control");
  const allow = normalizeHeaderValue(headers, "allow");
  const normalizedCacheControl = cacheControl.toLowerCase();
  const errors = [];

  if (!hasHeaderToken(allow, "POST")) {
    errors.push("purge-cache GET must advertise Allow: POST.");
  }
  if (!cacheControl) {
    errors.push("purge-cache GET must include Cache-Control.");
  } else if (!hasHeaderToken(normalizedCacheControl, "no-store")) {
    errors.push("purge-cache GET Cache-Control must include no-store.");
  }

  return {
    ok: errors.length === 0,
    errors,
    allow: allow || null,
    cacheControl: cacheControl || null,
  };
}

export function evaluateDiscoveryCacheHeaders(headers, { label = "discovery response" } = {}) {
  const cacheControl = typeof headers === "string"
    ? headers
    : headers.get("cache-control");
  const normalized = cacheControl?.toLowerCase() ?? "";
  const errors = [];

  if (!cacheControl) {
    errors.push(`${label} must include Cache-Control.`);
  } else {
    if (/\bno-store\b/.test(normalized)) {
      errors.push(`${label} Cache-Control must not include no-store on successful discovery responses.`);
    }
    if (/\bprivate\b/.test(normalized)) {
      errors.push(`${label} Cache-Control must not be private on successful discovery responses.`);
    }
    if (!/\bpublic\b/.test(normalized)) {
      errors.push(`${label} Cache-Control must include public cacheability.`);
    }
    if (!hasPositiveCacheTtl(cacheControl)) {
      errors.push(`${label} Cache-Control must include a positive max-age or s-maxage.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    cacheControl: cacheControl ?? null,
  };
}

export function evaluateRemediationTracker(markdown) {
  const blockers = [];
  const rows = [];

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*([^|]+?)\s*\|\s*(P[0-9])\s*\|\s*([^|]+?)\s*\|/);
    if (!match) continue;
    const [, id, severity, status] = match;
    if (id.trim() === "ID") continue;

    const row = {
      id: id.trim(),
      severity: severity.trim(),
      status: status.trim(),
    };
    rows.push(row);
    if ((row.severity === "P0" || row.severity === "P1") &&
      !closedTrackerStatuses.has(normalizeTrackerStatus(row.status))) {
      blockers.push(row);
    }
  }

  return {
    ok: blockers.length === 0,
    checkedRows: rows.length,
    blockers,
  };
}

export function evaluateRequiredDocs({
  rootDir = defaultRootDir,
  required = requiredDocs,
  fileExistsImpl = existsSync,
} = {}) {
  const missing = required.filter((path) => !fileExistsImpl(resolve(rootDir, path)));
  return {
    ok: missing.length === 0,
    checkedFiles: required.length,
    missing,
  };
}

export function evaluateRobotsTxt(
  body,
  {
    storefrontOrigin,
    expectedSitemapUrl,
    requireSitemap = true,
    allowSitemap = true,
  } = {},
) {
  const sitemapUrls = [];
  const errors = [];

  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i);
    if (!match) continue;
    const value = decodeXml(match[1]);
    sitemapUrls.push(value);
    if (!allowSitemap) continue;
    if (!isHttpUrl(value)) {
      errors.push(`robots sitemap URL is not absolute http(s): ${value}`);
    } else if (!isSameOrigin(value, storefrontOrigin)) {
      errors.push(`robots sitemap URL is not on storefront origin: ${value}`);
    } else if (expectedSitemapUrl && value !== expectedSitemapUrl) {
      errors.push(`robots sitemap URL must be canonical: ${expectedSitemapUrl}`);
    }
  }

  if (!allowSitemap && sitemapUrls.length > 0) {
    errors.push("robots.txt must not advertise Sitemap URLs when policy disables sitemap advertisement.");
  } else if (requireSitemap && sitemapUrls.length === 0) {
    errors.push("robots.txt must advertise at least one absolute Sitemap URL.");
  }

  return {
    ok: errors.length === 0,
    errors,
    sitemapUrls,
  };
}

export function evaluateSitemapXml(body, {
  storefrontOrigin,
  forbidPriority = false,
  forbidChangefreq = false,
  requireLoc = true,
} = {}) {
  const locs = extractTagValues(body, "loc");
  const errors = [];

  if (requireLoc && locs.length === 0) {
    errors.push("sitemap must include at least one <loc>.");
  }
  for (const loc of locs) {
    if (!isHttpUrl(loc)) {
      errors.push(`sitemap <loc> is not absolute http(s): ${loc}`);
    } else if (storefrontOrigin && !isSameOrigin(loc, storefrontOrigin)) {
      errors.push(`sitemap <loc> is not on storefront origin: ${loc}`);
    }
  }
  if (forbidPriority && /<priority\b/i.test(body)) {
    errors.push("product sitemap must not include <priority>.");
  }
  if (forbidChangefreq && /<changefreq\b/i.test(body)) {
    errors.push("product sitemap must not include <changefreq>.");
  }

  return {
    ok: errors.length === 0,
    errors,
    locCount: locs.length,
    locs,
  };
}

export function evaluateSitemapIndexPolicy(locs, { policy, storefrontOrigin } = {}) {
  const errors = [];
  const sitemapPolicy = policy?.sitemap;
  if (!sitemapPolicy?.enabled) {
    return { ok: true, errors };
  }

  for (const loc of locs) {
    if (!isHttpUrl(loc) || (storefrontOrigin && !isSameOrigin(loc, storefrontOrigin))) {
      continue;
    }

    const parsed = new URL(loc);
    const section = SITEMAP_SECTION_ENDPOINTS.find(({ endpoint }) =>
      new URL(endpoint, "https://example.invalid").pathname === parsed.pathname
    );
    if (section && !sitemapPolicy[section.policyKey]) {
      errors.push(`sitemap index must not advertise disabled ${section.label}: ${loc}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function evaluateProductFeedXml(
  body,
  { availabilityValues, storefrontOrigin } = {},
) {
  const itemBlocks = body.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const itemCount = itemBlocks.length;
  const links = [];
  const imageLinks = [];
  const availabilityMarkers = [];
  const errors = [];

  if (!/<rss\b/i.test(body) || !/<channel\b/i.test(body)) {
    errors.push("Product feed must be RSS/XML with <rss> and <channel>.");
  }

  const allowedAvailability = availabilityValues?.length
    ? new Set(availabilityValues)
    : null;

  itemBlocks.forEach((item, index) => {
    const itemNumber = index + 1;
    const itemLinks = [
      ...extractTagValues(item, "link"),
      ...extractTagValues(item, "g:link"),
    ].filter(Boolean);
    const itemImageLinks = [
      ...extractTagValues(item, "image_link"),
      ...extractTagValues(item, "g:image_link"),
    ].filter(Boolean);
    const itemAvailability = [
      ...extractTagValues(item, "availability"),
      ...extractTagValues(item, "g:availability"),
    ].filter(Boolean);

    links.push(...itemLinks);
    imageLinks.push(...itemImageLinks);
    availabilityMarkers.push(...itemAvailability);

    if (itemLinks.length === 0) {
      errors.push(`feed item ${itemNumber} must include a product link.`);
    }
    if (itemImageLinks.length === 0) {
      errors.push(`feed item ${itemNumber} must include an image_link.`);
    }
    if (itemAvailability.length === 0) {
      errors.push(`feed item ${itemNumber} must include availability.`);
    }

    if (allowedAvailability) {
      for (const value of itemAvailability) {
        if (!allowedAvailability.has(value)) {
          errors.push(`feed availability value is not allowed: ${value}`);
        }
      }
    }
    for (const link of itemLinks) {
      if (!isHttpUrl(link)) {
        errors.push(`feed product link is not absolute http(s): ${link}`);
      } else if (storefrontOrigin && !isSameOrigin(link, storefrontOrigin)) {
        errors.push(`feed product link is not on storefront origin: ${link}`);
      }
    }
    for (const imageLink of itemImageLinks) {
      if (!isHttpUrl(imageLink)) {
        errors.push(`feed image link is not absolute http(s): ${imageLink}`);
      }
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    itemCount,
    linkCount: links.length,
    imageLinkCount: imageLinks.length,
    availabilityCount: availabilityMarkers.length,
    availabilityValues: availabilityMarkers,
    firstStorefrontItemUrl: links.find((link) => storefrontOrigin ? isSameOrigin(link, storefrontOrigin) : isHttpUrl(link)) ?? null,
  };
}

export const evaluateFacebookFeedXml = evaluateProductFeedXml;

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function schemaTypes(node) {
  return asArray(node?.["@type"]).filter((type) => typeof type === "string");
}

function collectSchemaNodes(value) {
  if (Array.isArray(value)) return value.flatMap(collectSchemaNodes);
  if (!value || typeof value !== "object") return [];
  return [
    value,
    ...asArray(value["@graph"]).flatMap(collectSchemaNodes),
  ];
}

function extractJsonLdScripts(html) {
  const scripts = [];
  const pattern = /<script\b(?=[^>]*\btype=(["'])application\/ld\+json\1)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    scripts.push(decodeXml((match[2] ?? "").trim()));
  }
  return scripts;
}

function isProductSchema(node) {
  const types = schemaTypes(node);
  return types.includes("Product") || types.includes("ProductGroup");
}

function collectProductOffers(productNode) {
  const offers = [...asArray(productNode.offers)];
  for (const variant of asArray(productNode.hasVariant)) {
    if (variant && typeof variant === "object") {
      offers.push(...asArray(variant.offers));
    }
  }
  return offers.filter((offer) => offer && typeof offer === "object");
}

function hasSchemaType(node, type) {
  return schemaTypes(node).includes(type);
}

function validateSameOriginHttpUrl(value, { label, storefrontOrigin, errors }) {
  if (!isHttpUrl(String(value ?? ""))) {
    errors.push(`${label} is not absolute http(s): ${String(value ?? "")}`);
    return false;
  }
  if (storefrontOrigin && !isSameOrigin(value, storefrontOrigin)) {
    errors.push(`${label} is not on storefront origin: ${value}`);
    return false;
  }
  return true;
}

function validateMerchantReturnPolicySchema(policy, errors) {
  if (!isRecord(policy) || !hasSchemaType(policy, "MerchantReturnPolicy")) {
    errors.push("MerchantReturnPolicy JSON-LD must be an object with @type MerchantReturnPolicy.");
    return;
  }

  if (policy.merchantReturnLink !== undefined && !isHttpUrl(String(policy.merchantReturnLink))) {
    errors.push(`MerchantReturnPolicy link is not absolute http(s): ${String(policy.merchantReturnLink)}`);
  }
  if (
    policy.returnPolicyCategory !== undefined &&
    !String(policy.returnPolicyCategory).startsWith("https://schema.org/")
  ) {
    errors.push("MerchantReturnPolicy returnPolicyCategory must use a schema.org URL.");
  }
  if (
    policy.merchantReturnDays !== undefined &&
    (!Number.isInteger(Number(policy.merchantReturnDays)) || Number(policy.merchantReturnDays) <= 0)
  ) {
    errors.push("MerchantReturnPolicy merchantReturnDays must be a positive integer.");
  }
  for (const country of asArray(policy.applicableCountry)) {
    if (typeof country !== "string" || country.trim().length === 0) {
      errors.push("MerchantReturnPolicy applicableCountry must contain non-empty country values.");
    }
  }
}

function validateOnlineStoreSchema(node, { storefrontOrigin }, errors) {
  validateSameOriginHttpUrl(node.url, {
    label: "OnlineStore URL",
    storefrontOrigin,
    errors,
  });
  if (!node.name || typeof node.name !== "string" || node.name.trim() === "Store") {
    errors.push('OnlineStore name must use saved business identity, not "Store".');
  }

  const logoUrl = typeof node.logo === "string" ? node.logo : node.logo?.url;
  if (!isHttpUrl(String(logoUrl ?? ""))) {
    errors.push(`OnlineStore logo is not absolute http(s): ${String(logoUrl ?? "")}`);
  }

  for (const url of asArray(node.sameAs)) {
    if (!isHttpUrl(String(url ?? ""))) {
      errors.push(`OnlineStore sameAs URL is not absolute http(s): ${String(url ?? "")}`);
    }
  }

  if (node.hasMerchantReturnPolicy !== undefined) {
    validateMerchantReturnPolicySchema(node.hasMerchantReturnPolicy, errors);
  }
}

function validateWebsiteSchema(node, { storefrontOrigin }, errors) {
  validateSameOriginHttpUrl(node.url, {
    label: "WebSite URL",
    storefrontOrigin,
    errors,
  });
  if (!node.name || typeof node.name !== "string" || node.name.trim() === "Store") {
    errors.push('WebSite name must use saved business identity, not "Store".');
  }

  const action = node.potentialAction;
  if (!isRecord(action) || !hasSchemaType(action, "SearchAction")) {
    errors.push("WebSite JSON-LD must include SearchAction potentialAction.");
    return;
  }
  const target = typeof action.target === "string" ? action.target : action.target?.urlTemplate;
  validateSameOriginHttpUrl(target, {
    label: "WebSite SearchAction target",
    storefrontOrigin,
    errors,
  });
  if (typeof target !== "string" || !target.includes("{search_term_string}")) {
    errors.push("WebSite SearchAction target must include {search_term_string}.");
  }
  if (action["query-input"] !== "required name=search_term_string") {
    errors.push("WebSite SearchAction query-input must be required name=search_term_string.");
  }
}

export function evaluateHomepageJsonLdHtml(html, {
  storefrontOrigin,
  policy,
} = {}) {
  const errors = [];
  const scripts = extractJsonLdScripts(html);
  const parsedRoots = [];

  for (const script of scripts) {
    try {
      parsedRoots.push(JSON.parse(script));
    } catch (error) {
      errors.push(`JSON-LD script is invalid JSON: ${errorMessage(error)}`);
    }
  }

  const nodes = parsedRoots.flatMap(collectSchemaNodes);
  const onlineStoreNodes = nodes.filter((node) => hasSchemaType(node, "OnlineStore"));
  const websiteNodes = nodes.filter((node) => hasSchemaType(node, "WebSite"));
  const returnPolicyNodes = nodes.filter((node) => hasSchemaType(node, "MerchantReturnPolicy"));
  const nestedReturnPolicyCount = onlineStoreNodes.filter((node) =>
    node.hasMerchantReturnPolicy !== undefined
  ).length;

  if (policy?.structuredData?.organization === false && onlineStoreNodes.length > 0) {
    errors.push("OnlineStore JSON-LD emitted while organization schema is disabled.");
  }
  if (policy?.structuredData?.websiteSearch === false && websiteNodes.length > 0) {
    errors.push("WebSite JSON-LD emitted while website search schema is disabled.");
  }

  for (const node of onlineStoreNodes) {
    validateOnlineStoreSchema(node, { storefrontOrigin }, errors);
  }
  for (const node of websiteNodes) {
    validateWebsiteSchema(node, { storefrontOrigin }, errors);
  }
  for (const node of returnPolicyNodes) {
    validateMerchantReturnPolicySchema(node, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    scriptCount: scripts.length,
    onlineStoreCount: onlineStoreNodes.length,
    websiteCount: websiteNodes.length,
    returnPolicyCount: returnPolicyNodes.length + nestedReturnPolicyCount,
  };
}

function validateProductSchemaImage(productNode, errors) {
  const images = asArray(productNode.image);
  if (images.length === 0) {
    errors.push("Product JSON-LD must include at least one image.");
    return;
  }
  for (const image of images) {
    const url = typeof image === "string" ? image : image?.url;
    if (!isHttpUrl(String(url ?? ""))) {
      errors.push(`Product JSON-LD image is not absolute http(s): ${String(url ?? "")}`);
    }
  }
}

function validateOfferShippingDetails(offer, errors) {
  for (const detail of asArray(offer.shippingDetails)) {
    if (!detail || typeof detail !== "object") {
      errors.push("Offer shippingDetails must be an object or object array.");
      continue;
    }
    const destination = detail.shippingDestination;
    const rate = detail.shippingRate;
    const addressCountry = destination?.addressCountry;
    const value = rate?.value;
    const currency = rate?.currency;
    if (!destination || typeof destination !== "object" || !addressCountry) {
      errors.push("Offer shippingDetails must include shippingDestination.addressCountry.");
    }
    if (!rate || typeof rate !== "object" || value === undefined || !currency) {
      errors.push("Offer shippingDetails must include shippingRate value and currency.");
    }
  }
}

function validateProductOffer(offer, { storefrontOrigin }, errors) {
  const url = offer.url;
  if (!isHttpUrl(String(url ?? ""))) {
    errors.push(`Offer URL is not absolute http(s): ${String(url ?? "")}`);
  } else if (storefrontOrigin && !isSameOrigin(url, storefrontOrigin)) {
    errors.push(`Offer URL is not on storefront origin: ${url}`);
  }

  if (!offer.priceCurrency || typeof offer.priceCurrency !== "string") {
    errors.push("Offer must include priceCurrency.");
  }
  const price = Number(offer.price);
  if (!Number.isFinite(price) || price < 0) {
    errors.push("Offer price must be a non-negative number or numeric string.");
  }
  if (
    offer.availability !== "https://schema.org/InStock" &&
    offer.availability !== "https://schema.org/OutOfStock"
  ) {
    errors.push("Offer availability must be InStock or OutOfStock.");
  }
  if (offer.shippingDetails !== undefined) {
    validateOfferShippingDetails(offer, errors);
  }
}

export function evaluateProductJsonLdHtml(html, {
  storefrontOrigin,
} = {}) {
  const errors = [];
  const scripts = extractJsonLdScripts(html);
  const parsedRoots = [];

  if (scripts.length === 0) {
    errors.push("Product page must include at least one application/ld+json script.");
  }

  for (const script of scripts) {
    try {
      parsedRoots.push(JSON.parse(script));
    } catch (error) {
      errors.push(`JSON-LD script is invalid JSON: ${errorMessage(error)}`);
    }
  }

  const nodes = parsedRoots.flatMap(collectSchemaNodes);
  const productNodes = nodes.filter(isProductSchema);
  if (productNodes.length === 0) {
    errors.push("Product page JSON-LD must include Product or ProductGroup.");
  }

  let offerCount = 0;
  let shippingDetailsCount = 0;
  for (const productNode of productNodes) {
    validateProductSchemaImage(productNode, errors);
    const offers = collectProductOffers(productNode);
    if (offers.length === 0) {
      errors.push("Product JSON-LD must include at least one Offer.");
    }
    for (const offer of offers) {
      offerCount += 1;
      shippingDetailsCount += asArray(offer.shippingDetails).length;
      validateProductOffer(offer, { storefrontOrigin }, errors);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    scriptCount: scripts.length,
    productSchemaCount: productNodes.length,
    offerCount,
    shippingDetailsCount,
  };
}

function requireJsonResponse(response, label) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/\bapplication\/json\b/i.test(contentType)) {
    throw new Error(`${label} must return application/json; got ${contentType || "missing Content-Type"}.`);
  }

  try {
    return response.body ? JSON.parse(response.body) : null;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${errorMessage(error)}`, { cause: error });
  }
}

function parseMcpJsonRpcMessages(response, label) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/\b(?:application\/json|text\/event-stream)\b/i.test(contentType)) {
    throw new Error(`${label} must return JSON or MCP event stream; got ${contentType || "missing Content-Type"}.`);
  }

  const body = response.body.trim();
  if (!body) return [];

  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall through to SSE parsing.
  }

  const messages = [];
  for (const frame of response.body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;

    try {
      messages.push(JSON.parse(data));
    } catch (error) {
      throw new Error(`${label} returned invalid MCP event JSON: ${errorMessage(error)}`, { cause: error });
    }
  }

  if (messages.length === 0) {
    throw new Error(`${label} returned neither JSON nor MCP event data: ${responsePreview(response.body)}`);
  }

  return messages;
}

function requireMcpJsonRpcResult(response, label, id) {
  requireStatus(response, label, (status) => status >= 200 && status < 300);
  const messages = parseMcpJsonRpcMessages(response, label);
  const message = messages.find((candidate) =>
    isRecord(candidate) && candidate.jsonrpc === "2.0" && candidate.id === id
  );

  if (!message) {
    throw new Error(`${label} did not return a JSON-RPC response for id ${id}.`);
  }
  if (isRecord(message.error)) {
    const code = message.error.code ?? "unknown";
    const messageText = typeof message.error.message === "string"
      ? message.error.message
      : "unknown MCP error";
    throw new Error(`${label} returned JSON-RPC error ${code}: ${messageText}`);
  }
  if (!isRecord(message.result)) {
    throw new Error(`${label} returned no JSON-RPC result object.`);
  }

  return message.result;
}

async function fetchMcpJsonRpc(url, {
  fetchImpl,
  timeoutMs,
  body,
  sessionId,
  protocolVersion,
  headers: additionalHeaders = {},
}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Accept: MCP_ACCEPT_HEADER,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
  for (const [name, value] of Object.entries(additionalHeaders)) {
    if (typeof value === "string" && value) headers[name] = value;
  }

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    return {
      url,
      statusCode: response.status,
      ok: response.ok,
      body: responseBody,
      headers: response.headers,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function splitSetCookieHeaderValue(value) {
  return value
    .split(/,(?=\s*[^;,=\s]+=)/g)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function getSetCookieHeaderValues(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().flatMap(splitSetCookieHeaderValue);
  }
  const combined = headers.get("set-cookie") ?? "";
  return combined ? splitSetCookieHeaderValue(combined) : [];
}

function adminSessionCookiePairFromSetCookie(value) {
  const firstPart = value.split(";")[0]?.trim() ?? "";
  const equalsIndex = firstPart.indexOf("=");
  if (equalsIndex <= 0) return null;

  const name = firstPart.slice(0, equalsIndex).trim();
  const cookieValue = firstPart.slice(equalsIndex + 1).trim();
  if (!ADMIN_SESSION_COOKIE_NAMES.includes(name) || !cookieValue) return null;

  return `${name}=${cookieValue}`;
}

function adminSessionCookieHeaderFromSetCookie(headers) {
  const pairs = [];
  const seen = new Set();
  for (const setCookie of getSetCookieHeaderValues(headers)) {
    const pair = adminSessionCookiePairFromSetCookie(setCookie);
    if (!pair) continue;
    const name = pair.slice(0, pair.indexOf("="));
    if (seen.has(name)) continue;
    seen.add(name);
    pairs.push(pair);
  }
  return pairs.join("; ");
}

function cookieNamesFromCookieHeader(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim().split("=")[0])
    .filter(Boolean);
}

function requireNoStoreCacheControl(response, label) {
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (!hasHeaderToken(cacheControl, "no-store")) {
    throw new Error(
      `${label} Cache-Control must include no-store; got ${cacheControl || "missing Cache-Control"}.`,
    );
  }
  return cacheControl;
}

function listDiff(actual, expected) {
  const actualSet = new Set(actual);
  return expected.filter((value) => !actualSet.has(value));
}

function serializableToolSafetyText(tool, name) {
  return JSON.stringify({
    name,
    title: typeof tool.title === "string" ? tool.title : null,
    description: typeof tool.description === "string" ? tool.description : null,
    meta: isRecord(tool._meta) ? tool._meta : null,
    annotations: isRecord(tool.annotations) ? tool.annotations : null,
  }).toLowerCase();
}

export function evaluateAgentMcpTools(tools, {
  expectedToolNames = AGENT_EXPECTED_TOOL_NAMES,
} = {}) {
  const errors = [];
  const expectedSorted = [...expectedToolNames].sort();

  if (!Array.isArray(tools)) {
    return {
      ok: false,
      errors: ["Agent MCP tools/list result must include a tools array."],
      toolNames: [],
      expectedToolNames: expectedSorted,
      readOnlyToolCount: 0,
    };
  }

  const toolNames = [];
  const unsafeTools = [];
  let readOnlyToolCount = 0;
  const duplicateNames = new Set();
  const seenNames = new Set();

  tools.forEach((tool, index) => {
    if (!isRecord(tool)) {
      errors.push(`Agent MCP tool ${index + 1} must be an object.`);
      return;
    }

    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name) {
      errors.push(`Agent MCP tool ${index + 1} must include a name.`);
    } else {
      toolNames.push(name);
      if (seenNames.has(name)) duplicateNames.add(name);
      seenNames.add(name);
    }

    const annotations = isRecord(tool.annotations) ? tool.annotations : null;
    if (annotations?.readOnlyHint === true) {
      readOnlyToolCount += 1;
    } else {
      errors.push(`Agent MCP tool ${name || index + 1} must set annotations.readOnlyHint=true.`);
    }
    if (annotations?.destructiveHint === true) {
      errors.push(`Agent MCP tool ${name || index + 1} must not be marked destructive.`);
    }

    const serialized = serializableToolSafetyText(tool, name);
    if (
      AGENT_FORBIDDEN_TOOL_TERM_PATTERN.test(serialized) ||
      (AGENT_CART_TERM_PATTERN.test(serialized) && AGENT_CART_MUTATION_TERM_PATTERN.test(serialized))
    ) {
      unsafeTools.push(name || `tool ${index + 1}`);
    }
  });

  const sortedNames = [...toolNames].sort();
  const missing = listDiff(sortedNames, expectedSorted);
  const unexpected = listDiff(expectedSorted, sortedNames);
  if (missing.length > 0 || unexpected.length > 0 || duplicateNames.size > 0) {
    const details = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      unexpected.length ? `unexpected ${unexpected.join(", ")}` : "",
      duplicateNames.size ? `duplicate ${[...duplicateNames].sort().join(", ")}` : "",
    ].filter(Boolean).join("; ");
    errors.push(
      `Agent MCP tools must list exactly ${expectedSorted.join(", ")}${details ? ` (${details})` : ""}.`,
    );
  }

  if (unsafeTools.length > 0) {
    errors.push(
      "Agent MCP tools must not include checkout/order/payment/customer/recovery or cart mutation terms: " +
      unsafeTools.join(", "),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    toolNames: sortedNames,
    expectedToolNames: expectedSorted,
    readOnlyToolCount,
  };
}

export function evaluateAdminMcpTools(tools, {
  expectedToolNames = ADMIN_MCP_EXPECTED_TOOL_NAMES,
} = {}) {
  const errors = [];
  const expectedSorted = [...expectedToolNames].sort();

  if (!Array.isArray(tools)) {
    return {
      ok: false,
      errors: ["Admin MCP tools/list result must include a tools array."],
      toolNames: [],
      expectedToolNames: expectedSorted,
      readOnlyToolCount: 0,
    };
  }

  const toolNames = [];
  const unsafeTools = [];
  let readOnlyToolCount = 0;
  const duplicateNames = new Set();
  const seenNames = new Set();

  tools.forEach((tool, index) => {
    if (!isRecord(tool)) {
      errors.push(`Admin MCP tool ${index + 1} must be an object.`);
      return;
    }

    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name) {
      errors.push(`Admin MCP tool ${index + 1} must include a name.`);
    } else {
      toolNames.push(name);
      if (seenNames.has(name)) duplicateNames.add(name);
      seenNames.add(name);
    }

    const annotations = isRecord(tool.annotations) ? tool.annotations : null;
    if (annotations?.readOnlyHint === true) {
      readOnlyToolCount += 1;
    } else {
      errors.push(`Admin MCP tool ${name || index + 1} must set annotations.readOnlyHint=true.`);
    }
    if (annotations?.destructiveHint === true) {
      errors.push(`Admin MCP tool ${name || index + 1} must not be marked destructive.`);
    }

    const serialized = serializableToolSafetyText(tool, name);
    if (ADMIN_MCP_MUTATION_TOOL_TERM_PATTERN.test(serialized)) {
      unsafeTools.push(name || `tool ${index + 1}`);
    }
  });

  const sortedNames = [...toolNames].sort();
  const missing = listDiff(sortedNames, expectedSorted);
  const unexpected = listDiff(expectedSorted, sortedNames);
  if (missing.length > 0 || unexpected.length > 0 || duplicateNames.size > 0) {
    const details = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      unexpected.length ? `unexpected ${unexpected.join(", ")}` : "",
      duplicateNames.size ? `duplicate ${[...duplicateNames].sort().join(", ")}` : "",
    ].filter(Boolean).join("; ");
    errors.push(
      `Admin MCP tools must list exactly ${expectedSorted.join(", ")}${details ? ` (${details})` : ""}.`,
    );
  }

  if (unsafeTools.length > 0) {
    errors.push(
      "Admin MCP tools must not include mutation-like terms in tool names or metadata: " +
      unsafeTools.join(", "),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    toolNames: sortedNames,
    expectedToolNames: expectedSorted,
    readOnlyToolCount,
  };
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function catalogProductsFromStructuredContent(structuredContent) {
  if (!isRecord(structuredContent)) return [];
  const products = Array.isArray(structuredContent.products)
    ? structuredContent.products
    : Array.isArray(structuredContent.catalogSearch?.products)
      ? structuredContent.catalogSearch.products
      : Array.isArray(structuredContent.catalogLookup?.products)
        ? structuredContent.catalogLookup.products
        : [];
  return products.filter(isRecord);
}

function catalogProductFromStructuredContent(structuredContent) {
  if (!isRecord(structuredContent)) return null;
  if (isRecord(structuredContent.product)) return structuredContent.product;
  return firstNonEmptyString(structuredContent.id, structuredContent.url)
    ? structuredContent
    : null;
}

function readCatalogCandidateId(candidate) {
  if (!isRecord(candidate)) return null;
  const directId = firstNonEmptyString(
    candidate.id,
    candidate.url,
    candidate.handle,
    candidate.slug,
    candidate.sku,
  );
  if (directId) return directId;
  const variants = Array.isArray(candidate.variants) ? candidate.variants : [];
  for (const variant of variants) {
    const variantId = readCatalogCandidateId(variant);
    if (variantId) return variantId;
  }
  return null;
}

function firstCatalogSearchCandidateId(structuredContent) {
  for (const product of catalogProductsFromStructuredContent(structuredContent)) {
    const candidateId = readCatalogCandidateId(product);
    if (candidateId) return candidateId;
  }
  return null;
}

function evaluateAgentCatalogToolSmokeResult(result, {
  toolName = AGENT_CATALOG_TOOL_SMOKE.name,
  storefrontOrigin,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;

  if (result?.isError === true) {
    errors.push(`Agent MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Agent MCP ${toolName} must return at least one content block.`);
  }
  if (!structuredContent) {
    errors.push(`Agent MCP ${toolName} must return structured catalog content.`);
  }

  let profileEvaluation = null;
  let categoryCount = null;
  let productCount = null;
  let candidateId = null;
  let productId = null;
  let variantCount = null;
  if (toolName === "catalog_profile" && structuredContent) {
    profileEvaluation = evaluateUcpProfile(structuredContent, { storefrontOrigin });
    if (!profileEvaluation.ok) {
      errors.push(
        `Agent MCP ${toolName} returned an invalid catalog-only UCP profile: ` +
        profileEvaluation.errors.join("; "),
      );
    }
  } else if (toolName === "catalog_categories" && structuredContent) {
    const catalogCategories = isRecord(structuredContent.catalogCategories)
      ? structuredContent.catalogCategories
      : null;
    if (!catalogCategories) {
      errors.push(`Agent MCP ${toolName} must return structured catalogCategories content.`);
    } else if (!Array.isArray(catalogCategories.categories)) {
      errors.push(`Agent MCP ${toolName} must return catalogCategories.categories as an array.`);
    } else {
      categoryCount = catalogCategories.categories.length;
    }
  } else if (toolName === "catalog_search" && structuredContent) {
    const products = catalogProductsFromStructuredContent(structuredContent);
    productCount = products.length;
    candidateId = firstCatalogSearchCandidateId(structuredContent);
    if (
      hasOwnField(structuredContent, "products") &&
      !Array.isArray(structuredContent.products)
    ) {
      errors.push(`Agent MCP ${toolName} must return products as an array when present.`);
    }
  } else if (toolName === "catalog_lookup" && structuredContent) {
    const products = catalogProductsFromStructuredContent(structuredContent);
    productCount = products.length;
    if (productCount < 1) {
      errors.push(`Agent MCP ${toolName} must return at least one product for the search candidate.`);
    }
  } else if (toolName === "catalog_product" && structuredContent) {
    const product = catalogProductFromStructuredContent(structuredContent);
    if (!product) {
      errors.push(`Agent MCP ${toolName} must return structured product content.`);
    } else {
      productId = firstNonEmptyString(product.id);
      const variants = Array.isArray(product.variants) ? product.variants : [];
      variantCount = variants.length;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    categoryCount,
    productCount,
    candidateId,
    productId,
    variantCount,
    profile: profileEvaluation
      ? {
          version: profileEvaluation.version,
          endpoint: profileEvaluation.endpoint,
          capabilities: profileEvaluation.capabilities,
        }
      : null,
  };
}

function evaluateAgentCartValidationSmokeResult(result, {
  toolName = AGENT_CART_VALIDATION_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const cartValidation = isRecord(structuredContent?.cartValidation)
    ? structuredContent.cartValidation
    : null;
  const issues = Array.isArray(cartValidation?.issues) ? cartValidation.issues : [];
  const firstIssue = isRecord(issues[0]) ? issues[0] : null;

  if (result?.isError === true) {
    errors.push(`Agent MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Agent MCP ${toolName} must return at least one content block.`);
  }
  if (!cartValidation) {
    errors.push(`Agent MCP ${toolName} must return structured cartValidation content.`);
  } else {
    if (cartValidation.valid !== false) {
      errors.push(`Agent MCP ${toolName} missing-product smoke must fail closed as invalid.`);
    }
    if (!firstIssue || firstIssue.code !== "PRODUCT_UNAVAILABLE" || firstIssue.action !== "remove") {
      errors.push(`Agent MCP ${toolName} missing-product smoke must return PRODUCT_UNAVAILABLE/remove.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    issueCount: typeof cartValidation?.issueCount === "number"
      ? cartValidation.issueCount
      : issues.length,
    firstIssueCode: typeof firstIssue?.code === "string" ? firstIssue.code : null,
  };
}

function evaluateAgentPolicySmokeResult(result, {
  toolName = AGENT_POLICY_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const storefrontDiscoveryPolicy = isRecord(structuredContent?.storefrontDiscoveryPolicy)
    ? structuredContent.storefrontDiscoveryPolicy
    : null;
  const discovery = isRecord(storefrontDiscoveryPolicy?.discovery)
    ? storefrontDiscoveryPolicy.discovery
    : null;
  const returnPolicy = isRecord(storefrontDiscoveryPolicy?.returnPolicy)
    ? storefrontDiscoveryPolicy.returnPolicy
    : null;
  const limits = isRecord(storefrontDiscoveryPolicy?.limits)
    ? storefrontDiscoveryPolicy.limits
    : null;
  const sitemap = isRecord(discovery?.sitemap) ? discovery.sitemap : null;
  const feeds = isRecord(discovery?.feeds) ? discovery.feeds : null;
  const robots = isRecord(discovery?.robots) ? discovery.robots : null;
  const structuredData = isRecord(discovery?.structuredData) ? discovery.structuredData : null;

  if (result?.isError === true) {
    errors.push(`Agent MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Agent MCP ${toolName} must return at least one content block.`);
  }
  if (!storefrontDiscoveryPolicy) {
    errors.push(`Agent MCP ${toolName} must return structured storefrontDiscoveryPolicy content.`);
  } else {
    if (!sitemap || typeof sitemap.enabled !== "boolean" || !Array.isArray(sitemap.urls)) {
      errors.push(`Agent MCP ${toolName} must return discovery.sitemap enabled and urls.`);
    }
    if (
      !feeds ||
      typeof feeds.productCatalogEnabled !== "boolean" ||
      typeof feeds.includeUnavailableProducts !== "boolean" ||
      !Array.isArray(feeds.urls)
    ) {
      errors.push(`Agent MCP ${toolName} must return discovery.feeds policy and urls.`);
    }
    if (!robots || typeof robots.advertiseSitemap !== "boolean") {
      errors.push(`Agent MCP ${toolName} must return discovery.robots.advertiseSitemap.`);
    }
    if (!structuredData || typeof structuredData.products !== "boolean") {
      errors.push(`Agent MCP ${toolName} must return discovery.structuredData products flag.`);
    }
    if (!returnPolicy || typeof returnPolicy.enabled !== "boolean") {
      errors.push(`Agent MCP ${toolName} must return returnPolicy.enabled as a boolean.`);
    }
    if (
      !limits ||
      limits.readOnly !== true ||
      limits.canMutate !== false ||
      limits.includesCustomerData !== false ||
      limits.includesPaymentData !== false ||
      limits.includesCheckoutData !== false
    ) {
      errors.push(`Agent MCP ${toolName} must return explicit read-only/no-private-data limits.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    sitemapEnabled: typeof sitemap?.enabled === "boolean" ? sitemap.enabled : null,
    feedEnabled: typeof feeds?.productCatalogEnabled === "boolean"
      ? feeds.productCatalogEnabled
      : null,
    returnsEnabled: typeof returnPolicy?.enabled === "boolean" ? returnPolicy.enabled : null,
  };
}

function evaluateAdminNavigationToolSmokeResult(result, {
  toolName = ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const navigationContext = isRecord(structuredContent?.adminNavigationContext)
    ? structuredContent.adminNavigationContext
    : null;
  const limits = isRecord(navigationContext?.limits) ? navigationContext.limits : null;
  const sections = Array.isArray(navigationContext?.sections)
    ? navigationContext.sections
    : [];

  if (result?.isError === true) {
    errors.push(`Admin MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Admin MCP ${toolName} must return at least one content block.`);
  }
  if (!navigationContext) {
    errors.push(`Admin MCP ${toolName} must return structured adminNavigationContext content.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    defaultPath: typeof navigationContext?.defaultPath === "string"
      ? navigationContext.defaultPath
      : null,
    returnedPages: typeof limits?.returnedPages === "number"
      ? limits.returnedPages
      : null,
    sectionCount: sections.length,
  };
}

function findForbiddenAdminDashboardSummaryPaths(value, path = "$", seen = new Set()) {
  const leaks = [];
  if (!isRecord(value) && !Array.isArray(value)) {
    if (typeof value === "string" && ADMIN_DASHBOARD_SUMMARY_FORBIDDEN_VALUE_PATTERN.test(value)) {
      leaks.push(path);
    }
    return leaks;
  }

  if (seen.has(value)) return leaks;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      leaks.push(...findForbiddenAdminDashboardSummaryPaths(item, `${path}[${index}]`, seen));
    });
    return leaks;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (path !== "$.limits" && ADMIN_DASHBOARD_SUMMARY_FORBIDDEN_KEY_PATTERN.test(key)) {
      leaks.push(childPath);
      continue;
    }
    leaks.push(...findForbiddenAdminDashboardSummaryPaths(child, childPath, seen));
  }

  return leaks;
}

function findForbiddenAdminSettingsSummaryPaths(value, path = "$", seen = new Set()) {
  const leaks = [];
  if (!isRecord(value) && !Array.isArray(value)) {
    if (typeof value === "string" && ADMIN_SETTINGS_SUMMARY_FORBIDDEN_VALUE_PATTERN.test(value)) {
      leaks.push(path);
    }
    return leaks;
  }

  if (seen.has(value)) return leaks;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      leaks.push(...findForbiddenAdminSettingsSummaryPaths(item, `${path}[${index}]`, seen));
    });
    return leaks;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (path !== "$.limits" && ADMIN_SETTINGS_SUMMARY_FORBIDDEN_KEY_PATTERN.test(key)) {
      leaks.push(childPath);
      continue;
    }
    leaks.push(...findForbiddenAdminSettingsSummaryPaths(child, childPath, seen));
  }

  return leaks;
}

function findForbiddenAdminNotificationSettingsSummaryPaths(value, path = "$", seen = new Set()) {
  const leaks = [];
  if (!isRecord(value) && !Array.isArray(value)) {
    if (
      typeof value === "string" &&
      ADMIN_NOTIFICATION_SETTINGS_SUMMARY_FORBIDDEN_VALUE_PATTERN.test(value)
    ) {
      leaks.push(path);
    }
    return leaks;
  }

  if (seen.has(value)) return leaks;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      leaks.push(...findForbiddenAdminNotificationSettingsSummaryPaths(
        item,
        `${path}[${index}]`,
        seen,
      ));
    });
    return leaks;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      path !== "$.limits" &&
      ADMIN_NOTIFICATION_SETTINGS_SUMMARY_FORBIDDEN_KEY_PATTERN.test(key)
    ) {
      leaks.push(childPath);
      continue;
    }
    leaks.push(...findForbiddenAdminNotificationSettingsSummaryPaths(child, childPath, seen));
  }

  return leaks;
}

function findForbiddenAdminAnalyticsSummaryPaths(value, path = "$", seen = new Set()) {
  const leaks = [];
  if (!isRecord(value) && !Array.isArray(value)) {
    if (typeof value === "string" && ADMIN_ANALYTICS_SUMMARY_FORBIDDEN_VALUE_PATTERN.test(value)) {
      leaks.push(path);
    }
    return leaks;
  }

  if (seen.has(value)) return leaks;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      leaks.push(...findForbiddenAdminAnalyticsSummaryPaths(item, `${path}[${index}]`, seen));
    });
    return leaks;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (path !== "$.limits" && ADMIN_ANALYTICS_SUMMARY_FORBIDDEN_KEY_PATTERN.test(key)) {
      leaks.push(childPath);
      continue;
    }
    leaks.push(...findForbiddenAdminAnalyticsSummaryPaths(child, childPath, seen));
  }

  return leaks;
}

function evaluateAdminDashboardSummaryToolSmokeResult(result, {
  toolName = ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const summary = isRecord(structuredContent?.adminDashboardSummary)
    ? structuredContent.adminDashboardSummary
    : null;
  const source = isRecord(summary?.source) ? summary.source : null;
  const stats = isRecord(summary?.stats) ? summary.stats : null;
  const limits = isRecord(summary?.limits) ? summary.limits : null;
  const requiredNumericStatPaths = [
    "totalProducts",
    "totalCustomers",
    "currentMonth.orders",
    "currentMonth.revenue",
    "currentMonth.orderGrowth",
    "currentMonth.revenueGrowth",
    "currentMonth.orderStatus.delivered",
    "currentMonth.orderStatus.processing",
    "currentMonth.orderStatus.shipping",
    "currentMonth.orderStatus.cancelled",
    "lastMonth.orders",
    "lastMonth.revenue",
  ];
  const getNestedValue = (value, dottedPath) => dottedPath
    .split(".")
    .reduce((current, key) => (isRecord(current) ? current[key] : undefined), value);
  const numericStatKeys = stats
    ? requiredNumericStatPaths.filter((path) => {
      const value = getNestedValue(stats, path);
      return typeof value === "number" && Number.isFinite(value);
    })
    : [];
  const missingNumericStatPaths = stats
    ? requiredNumericStatPaths.filter((path) => {
      const value = getNestedValue(stats, path);
      return typeof value !== "number" || !Number.isFinite(value);
    })
    : requiredNumericStatPaths;
  const leakPaths = summary ? findForbiddenAdminDashboardSummaryPaths(summary) : [];

  if (result?.isError === true) {
    errors.push(`Admin MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Admin MCP ${toolName} must return at least one content block.`);
  }
  if (!summary) {
    errors.push(`Admin MCP ${toolName} must return structured adminDashboardSummary content.`);
  } else {
    if (source?.path !== ADMIN_DASHBOARD_SUMMARY_PATH) {
      errors.push(
        `Admin MCP ${toolName} source.path must be ${ADMIN_DASHBOARD_SUMMARY_PATH}.`,
      );
    }
    if (!stats || missingNumericStatPaths.length > 0) {
      errors.push(
        `Admin MCP ${toolName} must return numeric stats for ` +
        missingNumericStatPaths.join(", ") + ".",
      );
    }
    if (!limits) {
      errors.push(`Admin MCP ${toolName} must return limits metadata.`);
    } else {
      const expectedLimitFlags = [
        "includesRecentOrders",
        "includesCustomerPii",
        "includesOrderIds",
        "includesProviderPayloads",
        "includesPaymentEvidence",
        "includesLifetimeRevenue",
        "includesDailyActivity",
        "canMutate",
      ];
      const unsafeLimits = expectedLimitFlags.filter((key) => limits[key] !== false);
      if (unsafeLimits.length > 0) {
        errors.push(
          `Admin MCP ${toolName} limits must explicitly disable ${unsafeLimits.join(", ")}.`,
        );
      }
    }
    if (leakPaths.length > 0) {
      errors.push(
        `Admin MCP ${toolName} summary must not leak recent orders, customer PII, order IDs, ` +
        `payment evidence, provider payloads, total revenue, or daily activity (${leakPaths.join(", ")}).`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    numericStatKeys,
  };
}

function evaluateAdminSettingsSummaryToolSmokeResult(result, {
  toolName = ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const summary = isRecord(structuredContent?.adminSettingsSummary)
    ? structuredContent.adminSettingsSummary
    : null;
  const source = isRecord(summary?.source) ? summary.source : null;
  const limits = isRecord(summary?.limits) ? summary.limits : null;
  const leakPaths = summary ? findForbiddenAdminSettingsSummaryPaths(summary) : [];

  if (result?.isError === true) {
    errors.push(`Admin MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Admin MCP ${toolName} must return at least one content block.`);
  }
  if (!summary) {
    errors.push(`Admin MCP ${toolName} must return structured adminSettingsSummary content.`);
  } else {
    if (source?.path !== ADMIN_SETTINGS_SUMMARY_PATH) {
      errors.push(
        `Admin MCP ${toolName} source.path must be ${ADMIN_SETTINGS_SUMMARY_PATH}.`,
      );
    }
    if (source?.permission !== "settings.general.view") {
      errors.push(
        "Admin MCP admin_settings_summary source.permission must be settings.general.view.",
      );
    }
    if (!limits) {
      errors.push(`Admin MCP ${toolName} must return limits metadata.`);
    } else {
      const expectedLimitFlags = [
        "includesCredentials",
        "includesMaskedSecrets",
        "includesProviderIdentifiers",
        "includesBusinessContacts",
        "includesAnalyticsSnippets",
        "includesRawLogs",
        "includesRawCustomCode",
        "canMutate",
      ];
      const unsafeLimits = expectedLimitFlags.filter((key) => limits[key] !== false);
      if (unsafeLimits.length > 0) {
        errors.push(
          `Admin MCP ${toolName} limits must explicitly disable ${unsafeLimits.join(", ")}.`,
        );
      }
    }
    if (leakPaths.length > 0) {
      errors.push(
        `Admin MCP ${toolName} summary must not leak credentials, tokens, API keys, secrets, ` +
        `passwords, cookies, sessions, OTPs, receipt proofs, provider payloads, snippets, ` +
        `customer contacts, or mutation data (${leakPaths.join(", ")}).`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
  };
}

function evaluateAdminNotificationSettingsSummaryToolSmokeResult(result, {
  toolName = ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const summary = isRecord(structuredContent?.adminNotificationSettingsSummary)
    ? structuredContent.adminNotificationSettingsSummary
    : null;
  const source = isRecord(summary?.source) ? summary.source : null;
  const customer = isRecord(summary?.customer) ? summary.customer : null;
  const merchant = isRecord(summary?.merchant) ? summary.merchant : null;
  const totals = isRecord(summary?.totals) ? summary.totals : null;
  const limits = isRecord(summary?.limits) ? summary.limits : null;
  const customerEvents = Array.isArray(customer?.events) ? customer.events : null;
  const merchantEvents = Array.isArray(merchant?.events) ? merchant.events : null;
  const leakPaths = summary ? findForbiddenAdminNotificationSettingsSummaryPaths(summary) : [];

  if (result?.isError === true) {
    errors.push(`Admin MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Admin MCP ${toolName} must return at least one content block.`);
  }
  if (!summary) {
    errors.push(`Admin MCP ${toolName} must return structured adminNotificationSettingsSummary content.`);
  } else {
    if (source?.path !== ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH) {
      errors.push(
        `Admin MCP ${toolName} source.path must be ${ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH}.`,
      );
    }
    if (source?.permission !== "settings.general.view") {
      errors.push(
        `Admin MCP ${toolName} source.permission must be settings.general.view.`,
      );
    }
    if (source?.version !== ADMIN_NOTIFICATION_SETTINGS_SUMMARY_VERSION) {
      errors.push(
        `Admin MCP ${toolName} source.version must be ${ADMIN_NOTIFICATION_SETTINGS_SUMMARY_VERSION}.`,
      );
    }
    if (
      !customer ||
      !isRecord(customer.readiness) ||
      !isRecord(customer.enabledEventCounts) ||
      !Array.isArray(customer.supportedChannels) ||
      !Array.isArray(customerEvents) ||
      !isRecord(customer.whatsappTemplate)
    ) {
      errors.push(`Admin MCP ${toolName} must return customer notification readiness and events.`);
    }
    if (
      !merchant ||
      !isRecord(merchant.readiness) ||
      !isRecord(merchant.enabledEventCounts) ||
      !Array.isArray(merchant.supportedChannels) ||
      !Array.isArray(merchantEvents)
    ) {
      errors.push(`Admin MCP ${toolName} must return merchant notification readiness and events.`);
    }
    if (
      !totals ||
      typeof totals.orderEventCount !== "number" ||
      typeof totals.customerEventsWithAnyChannel !== "number" ||
      typeof totals.merchantEventsWithPush !== "number" ||
      typeof totals.readinessIssueCount !== "number"
    ) {
      errors.push(`Admin MCP ${toolName} must return numeric notification totals.`);
    }
    if (!limits) {
      errors.push(`Admin MCP ${toolName} must return limits metadata.`);
    } else {
      const expectedLimitFlags = [
        "includesCredentials",
        "includesMaskedSecrets",
        "includesProviderIdentifiers",
        "includesRawProviderErrors",
        "includesRecipients",
        "includesOrderIds",
        "includesDeliveryReceipts",
        "canMutate",
      ];
      const unsafeLimits = expectedLimitFlags.filter((key) => limits[key] !== false);
      if (unsafeLimits.length > 0) {
        errors.push(
          `Admin MCP ${toolName} limits must explicitly disable ${unsafeLimits.join(", ")}.`,
        );
      }
    }
    if (leakPaths.length > 0) {
      errors.push(
        `Admin MCP ${toolName} summary must not leak credentials, tokens, provider identifiers, ` +
        `raw provider errors, recipients, order IDs, delivery receipts, or raw messages ` +
        `(${leakPaths.join(", ")}).`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    customerEventCount: Array.isArray(customerEvents) ? customerEvents.length : null,
    merchantEventCount: Array.isArray(merchantEvents) ? merchantEvents.length : null,
    readinessIssueCount: typeof totals?.readinessIssueCount === "number"
      ? totals.readinessIssueCount
      : null,
  };
}

function evaluateAdminAnalyticsSummaryToolSmokeResult(result, {
  toolName = ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const summary = isRecord(structuredContent?.adminAnalyticsSummary)
    ? structuredContent.adminAnalyticsSummary
    : null;
  const source = isRecord(summary?.source) ? summary.source : null;
  const stats = isRecord(summary?.summary) ? summary.summary : null;
  const providers = Array.isArray(summary?.providers) ? summary.providers : null;
  const limits = isRecord(summary?.limits) ? summary.limits : null;
  const requiredNumericStatPaths = [
    "totalProviders",
    "browserReadyProviders",
    "draftProviders",
    "blockedProviders",
    "notConfiguredProviders",
    "serverReadyProviders",
  ];
  const numericStatKeys = stats
    ? requiredNumericStatPaths.filter((key) => {
      const value = stats[key];
      return typeof value === "number" && Number.isFinite(value);
    })
    : [];
  const missingNumericStatPaths = stats
    ? requiredNumericStatPaths.filter((key) => {
      const value = stats[key];
      return typeof value !== "number" || !Number.isFinite(value);
    })
    : requiredNumericStatPaths;
  const leakPaths = summary ? findForbiddenAdminAnalyticsSummaryPaths(summary) : [];

  if (result?.isError === true) {
    errors.push(`Admin MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Admin MCP ${toolName} must return at least one content block.`);
  }
  if (!summary) {
    errors.push(`Admin MCP ${toolName} must return structured adminAnalyticsSummary content.`);
  } else {
    if (source?.path !== ADMIN_ANALYTICS_HEALTH_PATH) {
      errors.push(
        `Admin MCP ${toolName} source.path must be ${ADMIN_ANALYTICS_HEALTH_PATH}.`,
      );
    }
    if (source?.permission !== "analytics.view") {
      errors.push(
        "Admin MCP admin_analytics_summary source.permission must be analytics.view.",
      );
    }
    if (source?.version !== ADMIN_ANALYTICS_SUMMARY_VERSION) {
      errors.push(
        `Admin MCP ${toolName} source.version must be ${ADMIN_ANALYTICS_SUMMARY_VERSION}.`,
      );
    }
    if (!stats || missingNumericStatPaths.length > 0) {
      errors.push(
        `Admin MCP ${toolName} must return numeric summary stats for ` +
        missingNumericStatPaths.join(", ") + ".",
      );
    }
    if (!Array.isArray(providers)) {
      errors.push(`Admin MCP ${toolName} must return providers as an array.`);
    } else {
      for (const [index, provider] of providers.entries()) {
        if (!isRecord(provider)) {
          errors.push(`Admin MCP ${toolName} provider ${index + 1} must be an object.`);
          continue;
        }
        const browser = isRecord(provider.browser) ? provider.browser : null;
        const serverSide = isRecord(provider.serverSide) ? provider.serverSide : null;
        if (!browser || !serverSide) {
          errors.push(`Admin MCP ${toolName} provider ${index + 1} must include browser and serverSide readiness.`);
        }
      }
    }
    if (!limits) {
      errors.push(`Admin MCP ${toolName} must return limits metadata.`);
    } else {
      const expectedLimitFlags = [
        "includesScriptConfig",
        "includesAnalyticsSnippets",
        "includesCustomCode",
        "includesProviderIdentifiers",
        "includesCredentials",
        "includesRawIssues",
        "includesProviderMessages",
        "includesProviderPayloads",
        "canMutate",
      ];
      const unsafeLimits = expectedLimitFlags.filter((key) => limits[key] !== false);
      if (unsafeLimits.length > 0) {
        errors.push(
          `Admin MCP ${toolName} limits must explicitly disable ${unsafeLimits.join(", ")}.`,
        );
      }
    }
    if (leakPaths.length > 0) {
      errors.push(
        `Admin MCP ${toolName} summary must not leak analytics config, snippets, custom code, ` +
        `credentials, provider account identifiers, raw issues, provider messages, or provider payloads ` +
        `(${leakPaths.join(", ")}).`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    numericStatKeys,
    providerCount: Array.isArray(providers) ? providers.length : null,
  };
}

function unexpectedKeys(value, allowedKeys) {
  return Object.keys(value).filter((key) => !allowedKeys.has(key));
}

function missingKeys(value, requiredKeys) {
  return [...requiredKeys].filter((key) => !(key in value));
}

function findForbiddenAdminCustomerSearchValuePaths(value, path = "$", seen = new Set()) {
  const leaks = [];
  if (!isRecord(value) && !Array.isArray(value)) {
    if (typeof value === "string") {
      if (
        ADMIN_CUSTOMER_SEARCH_RAW_QUERY_TERMS.some((term) => value.includes(term)) ||
        ADMIN_CUSTOMER_SEARCH_EMAIL_VALUE_PATTERN.test(value) ||
        ADMIN_CUSTOMER_SEARCH_PHONE_VALUE_PATTERN.test(value)
      ) {
        leaks.push(path);
      }
    }
    return leaks;
  }

  if (seen.has(value)) return leaks;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      leaks.push(...findForbiddenAdminCustomerSearchValuePaths(item, `${path}[${index}]`, seen));
    });
    return leaks;
  }

  for (const [key, child] of Object.entries(value)) {
    leaks.push(...findForbiddenAdminCustomerSearchValuePaths(child, `${path}.${key}`, seen));
  }

  return leaks;
}

function evaluateAdminCustomerSearchToolSmokeResult(result, {
  toolName = ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const summary = isRecord(structuredContent?.adminCustomerSearch)
    ? structuredContent.adminCustomerSearch
    : null;
  const source = isRecord(summary?.source) ? summary.source : null;
  const request = isRecord(summary?.request) ? summary.request : null;
  const customers = Array.isArray(summary?.customers) ? summary.customers : null;
  const pagination = isRecord(summary?.pagination) ? summary.pagination : null;
  const limits = isRecord(summary?.limits) ? summary.limits : null;
  const leakPaths = findForbiddenAdminCustomerSearchValuePaths(result);

  if (result?.isError === true) {
    errors.push(`Admin MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Admin MCP ${toolName} must return at least one content block.`);
  }
  if (!summary) {
    errors.push(`Admin MCP ${toolName} must return structured adminCustomerSearch content.`);
  } else {
    const summaryExtraKeys = unexpectedKeys(summary, ADMIN_CUSTOMER_SEARCH_ALLOWED_TOP_LEVEL_KEYS);
    if (summaryExtraKeys.length > 0) {
      errors.push(
        `Admin MCP ${toolName} adminCustomerSearch must not include extra keys: ${summaryExtraKeys.join(", ")}.`,
      );
    }

    if (!source) {
      errors.push(`Admin MCP ${toolName} must return source metadata.`);
    } else {
      const sourceMissingKeys = missingKeys(source, ADMIN_CUSTOMER_SEARCH_ALLOWED_SOURCE_KEYS);
      const sourceExtraKeys = unexpectedKeys(source, ADMIN_CUSTOMER_SEARCH_ALLOWED_SOURCE_KEYS);
      if (sourceMissingKeys.length > 0 || sourceExtraKeys.length > 0) {
        errors.push(
          `Admin MCP ${toolName} source must contain only path and permission.`,
        );
      }
      if (source.path !== ADMIN_CUSTOMERS_MCP_SEARCH_PATH) {
        errors.push(
          `Admin MCP ${toolName} source.path must be ${ADMIN_CUSTOMERS_MCP_SEARCH_PATH}.`,
        );
      }
      if (source.permission !== "customers.view") {
        errors.push(
          "Admin MCP admin_customer_search source.permission must be customers.view.",
        );
      }
    }

    if (!request) {
      errors.push(`Admin MCP ${toolName} must return redacted request metadata.`);
    } else {
      const requestMissingKeys = missingKeys(request, ADMIN_CUSTOMER_SEARCH_ALLOWED_REQUEST_KEYS);
      const requestExtraKeys = unexpectedKeys(request, ADMIN_CUSTOMER_SEARCH_ALLOWED_REQUEST_KEYS);
      if (requestMissingKeys.length > 0 || requestExtraKeys.length > 0) {
        errors.push(
          `Admin MCP ${toolName} request must contain only hasQuery, page, limit, sort, and order.`,
        );
      }
      if (request.hasQuery !== true) {
        errors.push(`Admin MCP ${toolName} request.hasQuery must be true.`);
      }
      if (typeof request.page !== "number" || !Number.isFinite(request.page)) {
        errors.push(`Admin MCP ${toolName} request.page must be numeric.`);
      }
      if (typeof request.limit !== "number" || !Number.isFinite(request.limit)) {
        errors.push(`Admin MCP ${toolName} request.limit must be numeric.`);
      }
      if (typeof request.sort !== "string" || typeof request.order !== "string") {
        errors.push(`Admin MCP ${toolName} request.sort and request.order must be strings.`);
      }
    }

    if (!Array.isArray(customers)) {
      errors.push(`Admin MCP ${toolName} must return customers as an array.`);
    } else {
      for (const [index, customer] of customers.entries()) {
        if (!isRecord(customer)) {
          errors.push(`Admin MCP ${toolName} customer ${index + 1} must be an object.`);
          continue;
        }
        const customerExtraKeys = unexpectedKeys(customer, ADMIN_CUSTOMER_SEARCH_ALLOWED_CUSTOMER_KEYS);
        if (customerExtraKeys.length > 0) {
          errors.push(
            `Admin MCP ${toolName} customer ${index + 1} must contain only compact non-contact fields; extra keys: ` +
            customerExtraKeys.join(", ") + ".",
          );
        }
        if (typeof customer.id !== "string" || !customer.id.trim()) {
          errors.push(`Admin MCP ${toolName} customer ${index + 1} must include a non-empty id.`);
        }
      }
    }

    if (!pagination) {
      errors.push(`Admin MCP ${toolName} must return pagination metadata.`);
    } else {
      const paginationMissingKeys = missingKeys(pagination, ADMIN_CUSTOMER_SEARCH_ALLOWED_PAGINATION_KEYS);
      const paginationExtraKeys = unexpectedKeys(pagination, ADMIN_CUSTOMER_SEARCH_ALLOWED_PAGINATION_KEYS);
      if (paginationMissingKeys.length > 0 || paginationExtraKeys.length > 0) {
        errors.push(
          `Admin MCP ${toolName} pagination must contain only page, limit, total, and totalPages.`,
        );
      }
      for (const key of ADMIN_CUSTOMER_SEARCH_ALLOWED_PAGINATION_KEYS) {
        if (typeof pagination[key] !== "number" || !Number.isFinite(pagination[key])) {
          errors.push(`Admin MCP ${toolName} pagination.${key} must be numeric.`);
        }
      }
    }

    if (!limits) {
      errors.push(`Admin MCP ${toolName} must return limits metadata.`);
    } else {
      const limitsExtraKeys = unexpectedKeys(limits, ADMIN_CUSTOMER_SEARCH_ALLOWED_LIMIT_KEYS);
      if (limitsExtraKeys.length > 0) {
        errors.push(
          `Admin MCP ${toolName} limits must not include extra keys: ${limitsExtraKeys.join(", ")}.`,
        );
      }
      const expectedLimitFlags = [
        "includesRawQuery",
        "includesTrashed",
        "includesNames",
        "includesContacts",
        "includesAddresses",
        "includesLocation",
        "includesHistory",
        "includesOrders",
        "canMutate",
      ];
      const unsafeLimits = expectedLimitFlags.filter((key) => limits[key] !== false);
      if (unsafeLimits.length > 0) {
        errors.push(
          `Admin MCP ${toolName} limits must explicitly disable ${unsafeLimits.join(", ")}.`,
        );
      }
    }
  }

  if (leakPaths.length > 0) {
    errors.push(
      `Admin MCP ${toolName} must not leak the raw query, email, phone, or contact values ` +
      `(${leakPaths.join(", ")}).`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    customerCount: Array.isArray(customers) ? customers.length : null,
  };
}

function firstAdminProductSearchCandidateId(result) {
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const productSearch = isRecord(structuredContent?.adminProductSearch)
    ? structuredContent.adminProductSearch
    : null;
  const products = Array.isArray(productSearch?.products) ? productSearch.products : [];
  for (const product of products) {
    if (!isRecord(product)) continue;
    const id = typeof product.id === "string" ? product.id.trim() : "";
    if (id) return id;
  }
  return null;
}

function findForbiddenAdminProductCopyContextPaths(value, path = "$", seen = new Set()) {
  const leaks = [];
  if (!isRecord(value) && !Array.isArray(value)) return leaks;
  if (seen.has(value)) return leaks;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      leaks.push(...findForbiddenAdminProductCopyContextPaths(item, `${path}[${index}]`, seen));
    });
    return leaks;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "limits") continue;
    const childPath = `${path}.${key}`;
    if (ADMIN_PRODUCT_COPY_CONTEXT_FORBIDDEN_KEY_PATTERN.test(key)) {
      leaks.push(childPath);
    }
    leaks.push(...findForbiddenAdminProductCopyContextPaths(child, childPath, seen));
  }
  return leaks;
}

function evaluateAdminProductCopyContextToolSmokeResult(result, {
  toolName = ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  const structuredContent = isRecord(result?.structuredContent)
    ? result.structuredContent
    : null;
  const context = isRecord(structuredContent?.adminProductCopyContext)
    ? structuredContent.adminProductCopyContext
    : null;
  const source = isRecord(context?.source) ? context.source : null;
  const product = isRecord(context?.product) ? context.product : null;
  const description = isRecord(product?.description) ? product.description : null;
  const limits = isRecord(context?.limits) ? context.limits : null;

  if (result?.isError === true) {
    errors.push(`Admin MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Admin MCP ${toolName} must return at least one content block.`);
  }
  if (!context) {
    errors.push(`Admin MCP ${toolName} must return structured adminProductCopyContext content.`);
  }
  if (source?.path !== ADMIN_PRODUCT_COPY_CONTEXT_PATH) {
    errors.push(`Admin MCP ${toolName} source.path must be ${ADMIN_PRODUCT_COPY_CONTEXT_PATH}.`);
  }
  if (source?.permission !== "products.view") {
    errors.push(`Admin MCP ${toolName} source.permission must be products.view.`);
  }
  if (!product) {
    errors.push(`Admin MCP ${toolName} must return product copy context.`);
  } else {
    if (typeof product.id !== "string" || !product.id.trim()) {
      errors.push(`Admin MCP ${toolName} product must include a non-empty id.`);
    }
    if (typeof product.name !== "string" || !product.name.trim()) {
      errors.push(`Admin MCP ${toolName} product must include a non-empty name.`);
    }
    if (description) {
      if (typeof description.content !== "string" || description.content.length > 14_000) {
        errors.push(`Admin MCP ${toolName} description.content must be a bounded string.`);
      }
      if (typeof description.excerpt !== "string" || description.excerpt.length > 600) {
        errors.push(`Admin MCP ${toolName} description.excerpt must be a bounded string.`);
      }
    }
  }
  if (!limits) {
    errors.push(`Admin MCP ${toolName} must return limits metadata.`);
  } else {
    const unsafeLimits = [
      "includesPrices",
      "includesVariants",
      "includesSku",
      "includesStock",
      "includesBarcodes",
      "includesImages",
      "includesDeletedFields",
      "includesProviderPayloads",
      "canMutate",
    ].filter((key) => limits[key] !== false);
    if (unsafeLimits.length > 0) {
      errors.push(`Admin MCP ${toolName} limits must explicitly disable ${unsafeLimits.join(", ")}.`);
    }
  }

  const forbiddenPaths = context
    ? findForbiddenAdminProductCopyContextPaths(context).slice(0, 8)
    : [];
  if (forbiddenPaths.length > 0) {
    errors.push(
      `Admin MCP ${toolName} must not leak price, SKU, stock, barcode, image, variant, deleted, or provider-payload fields: ` +
      forbiddenPaths.join(", "),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
    productId: typeof product?.id === "string" ? product.id : null,
    descriptionLength: typeof description?.content === "string" ? description.content.length : 0,
  };
}

function evaluateAdminReadOnlyToolSmokeResult(result, {
  toolName = ADMIN_PRODUCT_SEARCH_TOOL_SMOKE.name,
} = {}) {
  const errors = [];
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;

  if (result?.isError === true) {
    errors.push(`Admin MCP ${toolName} returned an MCP tool error.`);
  }
  if (contentCount < 1) {
    errors.push(`Admin MCP ${toolName} must return at least one content block.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    toolName,
    contentCount,
  };
}

export async function smokeAgentWorker({
  agentUrl = DEFAULT_AGENT_URL,
  storefrontUrl,
  catalogToolSmoke = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const normalizedAgentUrl = normalizeHttpBaseUrl(agentUrl, "Agent URL");
  const storefrontOrigin = storefrontUrl
    ? new URL(normalizeHttpBaseUrl(storefrontUrl, "Storefront URL")).origin
    : undefined;
  const healthUrl = buildUrl(normalizedAgentUrl, "/health");
  const healthResponse = await fetchJson(healthUrl, {
    fetchImpl,
    timeoutMs,
  });
  requireStatus(healthResponse, "Agent /health", (status) => status === 200);
  const healthCache = healthResponse.headers.get("cache-control") ?? "";
  if (!hasHeaderToken(healthCache, "no-store")) {
    throw new Error("Agent /health Cache-Control must include no-store.");
  }
  const healthPayload = requireJsonResponse(healthResponse, "Agent /health");
  if (healthPayload?.success !== true || healthPayload?.status !== "ok") {
    throw new Error("Agent /health must return success=true and status=ok.");
  }

  const mcpUrl = buildUrl(normalizedAgentUrl, "/mcp");
  const initializeResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
    },
  });
  const initializeCacheControl = requireNoStoreCacheControl(
    initializeResponse,
    "Agent MCP initialize",
  );
  const initializeResult = requireMcpJsonRpcResult(
    initializeResponse,
    "Agent MCP initialize",
    1,
  );
  const sessionId = initializeResponse.headers.get("mcp-session-id") || null;
  const negotiatedProtocolVersion =
    typeof initializeResult.protocolVersion === "string"
      ? initializeResult.protocolVersion
      : MCP_PROTOCOL_VERSION;

  if (sessionId) {
    const initializedResponse = await fetchMcpJsonRpc(mcpUrl, {
      fetchImpl,
      timeoutMs,
      sessionId,
      protocolVersion: negotiatedProtocolVersion,
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    });
    requireStatus(initializedResponse, "Agent MCP initialized notification", (status) =>
      status >= 200 && status < 300);
    requireNoStoreCacheControl(initializedResponse, "Agent MCP initialized notification");
  }

  const toolsResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
  });
  const toolsCacheControl = requireNoStoreCacheControl(toolsResponse, "Agent MCP tools/list");
  const toolsResult = requireMcpJsonRpcResult(toolsResponse, "Agent MCP tools/list", 2);
  const toolEvaluation = evaluateAgentMcpTools(toolsResult.tools);
  if (!toolEvaluation.ok) {
    throw new Error(`Agent MCP tools/list failed: ${toolEvaluation.errors.join("; ")}`);
  }

  let catalogToolResult = null;
  let catalogCategoriesToolResult = null;
  let policyToolResult = null;
  let catalogSearchToolResult = null;
  let catalogLookupToolResult = null;
  let catalogProductToolResult = null;
  let cartValidationToolResult = null;
  let nextMcpRequestId = 3;

  async function callAgentMcpTool(toolSmoke) {
    const requestId = nextMcpRequestId;
    nextMcpRequestId += 1;
    const label = `Agent MCP ${toolSmoke.name}`;
    const response = await fetchMcpJsonRpc(mcpUrl, {
      fetchImpl,
      timeoutMs,
      sessionId,
      protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
      body: {
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: toolSmoke,
      },
    });
    const cacheControl = requireNoStoreCacheControl(response, label);
    const result = requireMcpJsonRpcResult(response, label, requestId);
    return { response, cacheControl, result };
  }

  if (catalogToolSmoke) {
    const catalogToolCall = await callAgentMcpTool(AGENT_CATALOG_TOOL_SMOKE);
    const catalogToolEvaluation = evaluateAgentCatalogToolSmokeResult(catalogToolCall.result, {
      toolName: AGENT_CATALOG_TOOL_SMOKE.name,
      storefrontOrigin,
    });
    if (!catalogToolEvaluation.ok) {
      throw new Error(
        `Agent MCP ${AGENT_CATALOG_TOOL_SMOKE.name} failed: ` +
        catalogToolEvaluation.errors.join("; "),
      );
    }
    catalogToolResult = {
      name: AGENT_CATALOG_TOOL_SMOKE.name,
      statusCode: catalogToolCall.response.statusCode,
      durationMs: catalogToolCall.response.durationMs,
      cacheControl: catalogToolCall.cacheControl,
      contentCount: catalogToolEvaluation.contentCount,
      profile: catalogToolEvaluation.profile,
    };

    const catalogCategoriesToolCall = await callAgentMcpTool(
      AGENT_CATALOG_CATEGORIES_TOOL_SMOKE,
    );
    const catalogCategoriesToolEvaluation = evaluateAgentCatalogToolSmokeResult(
      catalogCategoriesToolCall.result,
      {
        toolName: AGENT_CATALOG_CATEGORIES_TOOL_SMOKE.name,
        storefrontOrigin,
      },
    );
    if (!catalogCategoriesToolEvaluation.ok) {
      throw new Error(
        `Agent MCP ${AGENT_CATALOG_CATEGORIES_TOOL_SMOKE.name} failed: ` +
        catalogCategoriesToolEvaluation.errors.join("; "),
      );
    }
    catalogCategoriesToolResult = {
      name: AGENT_CATALOG_CATEGORIES_TOOL_SMOKE.name,
      statusCode: catalogCategoriesToolCall.response.statusCode,
      durationMs: catalogCategoriesToolCall.response.durationMs,
      cacheControl: catalogCategoriesToolCall.cacheControl,
      contentCount: catalogCategoriesToolEvaluation.contentCount,
      categoryCount: catalogCategoriesToolEvaluation.categoryCount,
    };

    const policyToolCall = await callAgentMcpTool(AGENT_POLICY_TOOL_SMOKE);
    const policyToolEvaluation = evaluateAgentPolicySmokeResult(
      policyToolCall.result,
      {
        toolName: AGENT_POLICY_TOOL_SMOKE.name,
      },
    );
    if (!policyToolEvaluation.ok) {
      throw new Error(
        `Agent MCP ${AGENT_POLICY_TOOL_SMOKE.name} failed: ` +
        policyToolEvaluation.errors.join("; "),
      );
    }
    policyToolResult = {
      name: AGENT_POLICY_TOOL_SMOKE.name,
      statusCode: policyToolCall.response.statusCode,
      durationMs: policyToolCall.response.durationMs,
      cacheControl: policyToolCall.cacheControl,
      contentCount: policyToolEvaluation.contentCount,
      sitemapEnabled: policyToolEvaluation.sitemapEnabled,
      feedEnabled: policyToolEvaluation.feedEnabled,
      returnsEnabled: policyToolEvaluation.returnsEnabled,
    };

    const catalogSearchToolCall = await callAgentMcpTool(AGENT_CATALOG_SEARCH_TOOL_SMOKE);
    const catalogSearchToolEvaluation = evaluateAgentCatalogToolSmokeResult(
      catalogSearchToolCall.result,
      {
        toolName: AGENT_CATALOG_SEARCH_TOOL_SMOKE.name,
        storefrontOrigin,
      },
    );
    if (!catalogSearchToolEvaluation.ok) {
      throw new Error(
        `Agent MCP ${AGENT_CATALOG_SEARCH_TOOL_SMOKE.name} failed: ` +
        catalogSearchToolEvaluation.errors.join("; "),
      );
    }
    const searchCandidateId = catalogSearchToolEvaluation.candidateId;
    catalogSearchToolResult = {
      name: AGENT_CATALOG_SEARCH_TOOL_SMOKE.name,
      statusCode: catalogSearchToolCall.response.statusCode,
      durationMs: catalogSearchToolCall.response.durationMs,
      cacheControl: catalogSearchToolCall.cacheControl,
      contentCount: catalogSearchToolEvaluation.contentCount,
      productCount: catalogSearchToolEvaluation.productCount,
      candidateId: searchCandidateId,
    };

    if (searchCandidateId) {
      const lookupToolSmoke = {
        name: "catalog_lookup",
        arguments: { ids: [searchCandidateId] },
      };
      const catalogLookupToolCall = await callAgentMcpTool(lookupToolSmoke);
      const catalogLookupToolEvaluation = evaluateAgentCatalogToolSmokeResult(
        catalogLookupToolCall.result,
        {
          toolName: lookupToolSmoke.name,
          storefrontOrigin,
        },
      );
      if (!catalogLookupToolEvaluation.ok) {
        throw new Error(
          `Agent MCP ${lookupToolSmoke.name} failed: ` +
          catalogLookupToolEvaluation.errors.join("; "),
        );
      }
      catalogLookupToolResult = {
        name: lookupToolSmoke.name,
        statusCode: catalogLookupToolCall.response.statusCode,
        durationMs: catalogLookupToolCall.response.durationMs,
        cacheControl: catalogLookupToolCall.cacheControl,
        contentCount: catalogLookupToolEvaluation.contentCount,
        productCount: catalogLookupToolEvaluation.productCount,
        inputId: searchCandidateId,
      };

      const productToolSmoke = {
        name: "catalog_product",
        arguments: { id: searchCandidateId },
      };
      const catalogProductToolCall = await callAgentMcpTool(productToolSmoke);
      const catalogProductToolEvaluation = evaluateAgentCatalogToolSmokeResult(
        catalogProductToolCall.result,
        {
          toolName: productToolSmoke.name,
          storefrontOrigin,
        },
      );
      if (!catalogProductToolEvaluation.ok) {
        throw new Error(
          `Agent MCP ${productToolSmoke.name} failed: ` +
          catalogProductToolEvaluation.errors.join("; "),
        );
      }
      catalogProductToolResult = {
        name: productToolSmoke.name,
        statusCode: catalogProductToolCall.response.statusCode,
        durationMs: catalogProductToolCall.response.durationMs,
        cacheControl: catalogProductToolCall.cacheControl,
        contentCount: catalogProductToolEvaluation.contentCount,
        productId: catalogProductToolEvaluation.productId,
        variantCount: catalogProductToolEvaluation.variantCount,
        inputId: searchCandidateId,
      };
    } else {
      catalogLookupToolResult = {
        name: "catalog_lookup",
        skipped: "no_catalog_search_candidate",
      };
      catalogProductToolResult = {
        name: "catalog_product",
        skipped: "no_catalog_search_candidate",
      };
    }

    const cartValidationToolCall = await callAgentMcpTool(AGENT_CART_VALIDATION_TOOL_SMOKE);
    const cartValidationToolEvaluation = evaluateAgentCartValidationSmokeResult(
      cartValidationToolCall.result,
      {
        toolName: AGENT_CART_VALIDATION_TOOL_SMOKE.name,
      },
    );
    if (!cartValidationToolEvaluation.ok) {
      throw new Error(
        `Agent MCP ${AGENT_CART_VALIDATION_TOOL_SMOKE.name} failed: ` +
        cartValidationToolEvaluation.errors.join("; "),
      );
    }
    cartValidationToolResult = {
      name: AGENT_CART_VALIDATION_TOOL_SMOKE.name,
      statusCode: cartValidationToolCall.response.statusCode,
      durationMs: cartValidationToolCall.response.durationMs,
      cacheControl: cartValidationToolCall.cacheControl,
      contentCount: cartValidationToolEvaluation.contentCount,
      issueCount: cartValidationToolEvaluation.issueCount,
      firstIssueCode: cartValidationToolEvaluation.firstIssueCode,
    };
  }

  const catalogToolSummary = catalogToolResult
    ? `, ${catalogToolResult.name} call ok`
    : "";
  const catalogCategoriesToolSummary = catalogCategoriesToolResult
    ? `, ${catalogCategoriesToolResult.name} call ok`
    : "";
  const policyToolSummary = policyToolResult
    ? `, ${policyToolResult.name} call ok`
    : "";
  const catalogSearchToolSummary = catalogSearchToolResult
    ? `, ${catalogSearchToolResult.name} call ok`
    : "";
  const catalogLookupToolSummary = catalogLookupToolResult
    ? (catalogLookupToolResult.skipped
        ? `, ${catalogLookupToolResult.name} skipped: ${catalogLookupToolResult.skipped}`
        : `, ${catalogLookupToolResult.name} call ok`)
    : "";
  const catalogProductToolSummary = catalogProductToolResult
    ? (catalogProductToolResult.skipped
        ? `, ${catalogProductToolResult.name} skipped: ${catalogProductToolResult.skipped}`
        : `, ${catalogProductToolResult.name} call ok`)
    : "";
  const cartValidationToolSummary = cartValidationToolResult
    ? `, ${cartValidationToolResult.name} call ok`
    : "";
  logger?.log(
    `PASS agent MCP: /health ${healthResponse.statusCode}, tools ${toolEvaluation.toolNames.join(", ")}${catalogToolSummary}${catalogCategoriesToolSummary}${policyToolSummary}${catalogSearchToolSummary}${catalogLookupToolSummary}${catalogProductToolSummary}${cartValidationToolSummary}.`,
  );
  return {
    agentUrl: redactUrl(normalizedAgentUrl),
    health: {
      url: redactUrl(healthUrl),
      statusCode: healthResponse.statusCode,
      durationMs: healthResponse.durationMs,
      cacheControl: healthCache,
      service: typeof healthPayload.service === "string" ? healthPayload.service : null,
    },
    mcp: {
      url: redactUrl(mcpUrl),
      initialize: {
        statusCode: initializeResponse.statusCode,
        durationMs: initializeResponse.durationMs,
        cacheControl: initializeCacheControl,
        protocolVersion: negotiatedProtocolVersion,
        session: sessionId ? "present" : "none",
      },
      tools: {
        statusCode: toolsResponse.statusCode,
        durationMs: toolsResponse.durationMs,
        cacheControl: toolsCacheControl,
        toolNames: toolEvaluation.toolNames,
        readOnlyToolCount: toolEvaluation.readOnlyToolCount,
      },
      ...(catalogToolResult ? { catalogTool: catalogToolResult } : {}),
      ...(catalogCategoriesToolResult ? { catalogCategoriesTool: catalogCategoriesToolResult } : {}),
      ...(policyToolResult ? { policyTool: policyToolResult } : {}),
      ...(catalogSearchToolResult ? { catalogSearchTool: catalogSearchToolResult } : {}),
      ...(catalogLookupToolResult ? { catalogLookupTool: catalogLookupToolResult } : {}),
      ...(catalogProductToolResult ? { catalogProductTool: catalogProductToolResult } : {}),
      ...(cartValidationToolResult ? { cartValidationTool: cartValidationToolResult } : {}),
    },
  };
}

function releaseAdminCredentialEnvStatus(env) {
  const email = typeof env?.[RELEASE_ADMIN_EMAIL_ENV] === "string"
    ? env[RELEASE_ADMIN_EMAIL_ENV].trim()
    : "";
  const password = typeof env?.[RELEASE_ADMIN_PASSWORD_ENV] === "string"
    ? env[RELEASE_ADMIN_PASSWORD_ENV]
    : "";
  const missing = [];
  if (!email) missing.push(RELEASE_ADMIN_EMAIL_ENV);
  if (!password) missing.push(RELEASE_ADMIN_PASSWORD_ENV);
  return {
    missing,
    credentials: missing.length === 0 ? { email, password } : null,
  };
}

async function signInReleaseAdmin({
  dashboardUrl,
  email,
  password,
  timeoutMs,
  fetchImpl,
}) {
  const signInUrl = buildUrl(dashboardUrl, "/api/auth/sign-in/email");
  const response = await fetchJson(signInUrl, {
    fetchImpl,
    timeoutMs,
    method: "POST",
    headers: {
      Origin: new URL(dashboardUrl).origin,
    },
    body: {
      email,
      password,
      rememberMe: false,
    },
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Admin MCP authenticated sign-in returned HTTP ${response.statusCode}; ` +
      `check ${RELEASE_ADMIN_EMAIL_ENV}/${RELEASE_ADMIN_PASSWORD_ENV}.`,
    );
  }

  const cookieHeader = adminSessionCookieHeaderFromSetCookie(response.headers);
  if (!cookieHeader) {
    throw new Error(
      "Admin MCP authenticated sign-in did not return a Better Auth session cookie.",
    );
  }

  return {
    cookieHeader,
    result: {
      url: redactUrl(signInUrl),
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      sessionCookieNames: cookieNamesFromCookieHeader(cookieHeader),
    },
  };
}

export async function smokeAdminMcpAuthenticated({
  dashboardUrl = DEFAULT_DASHBOARD_URL,
  email,
  password,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  if (!email || !password) {
    throw new Error(
      `Admin MCP authenticated smoke requires ${RELEASE_ADMIN_EMAIL_ENV} and ${RELEASE_ADMIN_PASSWORD_ENV}.`,
    );
  }

  const normalizedDashboardUrl = normalizeHttpBaseUrl(dashboardUrl, "Dashboard URL");
  const { cookieHeader, result: signIn } = await signInReleaseAdmin({
    dashboardUrl: normalizedDashboardUrl,
    email,
    password,
    timeoutMs,
    fetchImpl,
  });
  const mcpUrl = buildUrl(normalizedDashboardUrl, ADMIN_ASSISTANT_MCP_PATH);
  const authenticatedHeaders = {
    Cookie: cookieHeader,
    Origin: new URL(normalizedDashboardUrl).origin,
  };

  const initializeResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
    },
  });
  const initializeCacheControl = requireNoStoreCacheControl(
    initializeResponse,
    "Authenticated Admin MCP initialize",
  );
  const initializeResult = requireMcpJsonRpcResult(
    initializeResponse,
    "Authenticated Admin MCP initialize",
    1,
  );
  const sessionId = initializeResponse.headers.get("mcp-session-id") || null;
  const negotiatedProtocolVersion =
    typeof initializeResult.protocolVersion === "string"
      ? initializeResult.protocolVersion
      : MCP_PROTOCOL_VERSION;

  if (sessionId) {
    const initializedResponse = await fetchMcpJsonRpc(mcpUrl, {
      fetchImpl,
      timeoutMs,
      headers: authenticatedHeaders,
      sessionId,
      protocolVersion: negotiatedProtocolVersion,
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    });
    requireNoStoreCacheControl(
      initializedResponse,
      "Authenticated Admin MCP initialized notification",
    );
    requireStatus(initializedResponse, "Authenticated Admin MCP initialized notification", (status) =>
      status >= 200 && status < 300);
  }

  const toolsResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
  });
  const toolsCacheControl = requireNoStoreCacheControl(
    toolsResponse,
    "Authenticated Admin MCP tools/list",
  );
  const toolsResult = requireMcpJsonRpcResult(
    toolsResponse,
    "Authenticated Admin MCP tools/list",
    2,
  );
  const toolEvaluation = evaluateAdminMcpTools(toolsResult.tools);
  if (!toolEvaluation.ok) {
    throw new Error(`Admin MCP tools/list failed: ${toolEvaluation.errors.join("; ")}`);
  }

  const navigationToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE,
    },
  });
  const navigationToolCacheControl = requireNoStoreCacheControl(
    navigationToolResponse,
    `Authenticated Admin MCP ${ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE.name}`,
  );
  const navigationToolResult = requireMcpJsonRpcResult(
    navigationToolResponse,
    `Authenticated Admin MCP ${ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE.name}`,
    3,
  );
  const navigationToolEvaluation = evaluateAdminNavigationToolSmokeResult(
    navigationToolResult,
    { toolName: ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE.name },
  );
  if (!navigationToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE.name} failed: ` +
      navigationToolEvaluation.errors.join("; "),
    );
  }

  const dashboardSummaryToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE,
    },
  });
  const dashboardSummaryToolCacheControl = requireNoStoreCacheControl(
    dashboardSummaryToolResponse,
    `Authenticated Admin MCP ${ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE.name}`,
  );
  const dashboardSummaryToolResult = requireMcpJsonRpcResult(
    dashboardSummaryToolResponse,
    `Authenticated Admin MCP ${ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE.name}`,
    4,
  );
  const dashboardSummaryToolEvaluation = evaluateAdminDashboardSummaryToolSmokeResult(
    dashboardSummaryToolResult,
    { toolName: ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE.name },
  );
  if (!dashboardSummaryToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE.name} failed: ` +
      dashboardSummaryToolEvaluation.errors.join("; "),
    );
  }

  const settingsSummaryToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE,
    },
  });
  const settingsSummaryToolCacheControl = requireNoStoreCacheControl(
    settingsSummaryToolResponse,
    `Authenticated Admin MCP ${ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE.name}`,
  );
  const settingsSummaryToolResult = requireMcpJsonRpcResult(
    settingsSummaryToolResponse,
    `Authenticated Admin MCP ${ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE.name}`,
    5,
  );
  const settingsSummaryToolEvaluation = evaluateAdminSettingsSummaryToolSmokeResult(
    settingsSummaryToolResult,
    { toolName: ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE.name },
  );
  if (!settingsSummaryToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE.name} failed: ` +
      settingsSummaryToolEvaluation.errors.join("; "),
    );
  }

  const notificationSettingsSummaryToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE,
    },
  });
  const notificationSettingsSummaryToolCacheControl = requireNoStoreCacheControl(
    notificationSettingsSummaryToolResponse,
    `Authenticated Admin MCP ${ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE.name}`,
  );
  const notificationSettingsSummaryToolResult = requireMcpJsonRpcResult(
    notificationSettingsSummaryToolResponse,
    `Authenticated Admin MCP ${ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE.name}`,
    6,
  );
  const notificationSettingsSummaryToolEvaluation =
    evaluateAdminNotificationSettingsSummaryToolSmokeResult(
      notificationSettingsSummaryToolResult,
      { toolName: ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE.name },
    );
  if (!notificationSettingsSummaryToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE.name} failed: ` +
      notificationSettingsSummaryToolEvaluation.errors.join("; "),
    );
  }

  const analyticsSummaryToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE,
    },
  });
  const analyticsSummaryToolCacheControl = requireNoStoreCacheControl(
    analyticsSummaryToolResponse,
    `Authenticated Admin MCP ${ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE.name}`,
  );
  const analyticsSummaryToolResult = requireMcpJsonRpcResult(
    analyticsSummaryToolResponse,
    `Authenticated Admin MCP ${ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE.name}`,
    7,
  );
  const analyticsSummaryToolEvaluation = evaluateAdminAnalyticsSummaryToolSmokeResult(
    analyticsSummaryToolResult,
    { toolName: ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE.name },
  );
  if (!analyticsSummaryToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE.name} failed: ` +
      analyticsSummaryToolEvaluation.errors.join("; "),
    );
  }

  const categorySearchToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: ADMIN_CATEGORY_SEARCH_TOOL_SMOKE,
    },
  });
  const categorySearchToolCacheControl = requireNoStoreCacheControl(
    categorySearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_CATEGORY_SEARCH_TOOL_SMOKE.name}`,
  );
  const categorySearchToolResult = requireMcpJsonRpcResult(
    categorySearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_CATEGORY_SEARCH_TOOL_SMOKE.name}`,
    8,
  );
  const categorySearchToolEvaluation = evaluateAdminReadOnlyToolSmokeResult(
    categorySearchToolResult,
    { toolName: ADMIN_CATEGORY_SEARCH_TOOL_SMOKE.name },
  );
  if (!categorySearchToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_CATEGORY_SEARCH_TOOL_SMOKE.name} failed: ` +
      categorySearchToolEvaluation.errors.join("; "),
    );
  }

  const collectionSearchToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: ADMIN_COLLECTION_SEARCH_TOOL_SMOKE,
    },
  });
  const collectionSearchToolCacheControl = requireNoStoreCacheControl(
    collectionSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_COLLECTION_SEARCH_TOOL_SMOKE.name}`,
  );
  const collectionSearchToolResult = requireMcpJsonRpcResult(
    collectionSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_COLLECTION_SEARCH_TOOL_SMOKE.name}`,
    9,
  );
  const collectionSearchToolEvaluation = evaluateAdminReadOnlyToolSmokeResult(
    collectionSearchToolResult,
    { toolName: ADMIN_COLLECTION_SEARCH_TOOL_SMOKE.name },
  );
  if (!collectionSearchToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_COLLECTION_SEARCH_TOOL_SMOKE.name} failed: ` +
      collectionSearchToolEvaluation.errors.join("; "),
    );
  }

  const pageSearchToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: ADMIN_PAGE_SEARCH_TOOL_SMOKE,
    },
  });
  const pageSearchToolCacheControl = requireNoStoreCacheControl(
    pageSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_PAGE_SEARCH_TOOL_SMOKE.name}`,
  );
  const pageSearchToolResult = requireMcpJsonRpcResult(
    pageSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_PAGE_SEARCH_TOOL_SMOKE.name}`,
    10,
  );
  const pageSearchToolEvaluation = evaluateAdminReadOnlyToolSmokeResult(
    pageSearchToolResult,
    { toolName: ADMIN_PAGE_SEARCH_TOOL_SMOKE.name },
  );
  if (!pageSearchToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_PAGE_SEARCH_TOOL_SMOKE.name} failed: ` +
      pageSearchToolEvaluation.errors.join("; "),
    );
  }

  const mediaSearchToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: ADMIN_MEDIA_SEARCH_TOOL_SMOKE,
    },
  });
  const mediaSearchToolCacheControl = requireNoStoreCacheControl(
    mediaSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_MEDIA_SEARCH_TOOL_SMOKE.name}`,
  );
  const mediaSearchToolResult = requireMcpJsonRpcResult(
    mediaSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_MEDIA_SEARCH_TOOL_SMOKE.name}`,
    11,
  );
  const mediaSearchToolEvaluation = evaluateAdminReadOnlyToolSmokeResult(
    mediaSearchToolResult,
    { toolName: ADMIN_MEDIA_SEARCH_TOOL_SMOKE.name },
  );
  if (!mediaSearchToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_MEDIA_SEARCH_TOOL_SMOKE.name} failed: ` +
      mediaSearchToolEvaluation.errors.join("; "),
    );
  }

  const productSearchToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: ADMIN_PRODUCT_SEARCH_TOOL_SMOKE,
    },
  });
  const productSearchToolCacheControl = requireNoStoreCacheControl(
    productSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_PRODUCT_SEARCH_TOOL_SMOKE.name}`,
  );
  const productSearchToolResult = requireMcpJsonRpcResult(
    productSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_PRODUCT_SEARCH_TOOL_SMOKE.name}`,
    12,
  );
  const productSearchToolEvaluation = evaluateAdminReadOnlyToolSmokeResult(
    productSearchToolResult,
    { toolName: ADMIN_PRODUCT_SEARCH_TOOL_SMOKE.name },
  );
  if (!productSearchToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_PRODUCT_SEARCH_TOOL_SMOKE.name} failed: ` +
      productSearchToolEvaluation.errors.join("; "),
    );
  }

  const productCopyCandidateId = firstAdminProductSearchCandidateId(productSearchToolResult);
  let productCopyContextToolResponse = null;
  let productCopyContextToolCacheControl = null;
  let productCopyContextToolEvaluation = null;
  if (productCopyCandidateId) {
    const productCopyContextToolSmoke = {
      name: ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME,
      arguments: {
        id: productCopyCandidateId,
      },
    };
    productCopyContextToolResponse = await fetchMcpJsonRpc(mcpUrl, {
      fetchImpl,
      timeoutMs,
      headers: authenticatedHeaders,
      sessionId,
      protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
      body: {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: productCopyContextToolSmoke,
      },
    });
    productCopyContextToolCacheControl = requireNoStoreCacheControl(
      productCopyContextToolResponse,
      `Authenticated Admin MCP ${ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME}`,
    );
    const productCopyContextToolResult = requireMcpJsonRpcResult(
      productCopyContextToolResponse,
      `Authenticated Admin MCP ${ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME}`,
      13,
    );
    productCopyContextToolEvaluation = evaluateAdminProductCopyContextToolSmokeResult(
      productCopyContextToolResult,
      { toolName: ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME },
    );
    if (!productCopyContextToolEvaluation.ok) {
      throw new Error(
        `Admin MCP ${ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME} failed: ` +
        productCopyContextToolEvaluation.errors.join("; "),
      );
    }
  }

  const orderSearchToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: ADMIN_ORDER_SEARCH_TOOL_SMOKE,
    },
  });
  const orderSearchToolCacheControl = requireNoStoreCacheControl(
    orderSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_ORDER_SEARCH_TOOL_SMOKE.name}`,
  );
  const orderSearchToolResult = requireMcpJsonRpcResult(
    orderSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_ORDER_SEARCH_TOOL_SMOKE.name}`,
    14,
  );
  const orderSearchToolEvaluation = evaluateAdminReadOnlyToolSmokeResult(
    orderSearchToolResult,
    { toolName: ADMIN_ORDER_SEARCH_TOOL_SMOKE.name },
  );
  if (!orderSearchToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_ORDER_SEARCH_TOOL_SMOKE.name} failed: ` +
      orderSearchToolEvaluation.errors.join("; "),
    );
  }

  const customerSearchToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE,
    },
  });
  const customerSearchToolCacheControl = requireNoStoreCacheControl(
    customerSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE.name}`,
  );
  const customerSearchToolResult = requireMcpJsonRpcResult(
    customerSearchToolResponse,
    `Authenticated Admin MCP ${ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE.name}`,
    15,
  );
  const customerSearchToolEvaluation = evaluateAdminCustomerSearchToolSmokeResult(
    customerSearchToolResult,
    { toolName: ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE.name },
  );
  if (!customerSearchToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE.name} failed: ` +
      customerSearchToolEvaluation.errors.join("; "),
    );
  }

  const inventoryLookupToolResponse = await fetchMcpJsonRpc(mcpUrl, {
    fetchImpl,
    timeoutMs,
    headers: authenticatedHeaders,
    sessionId,
    protocolVersion: sessionId ? negotiatedProtocolVersion : undefined,
    body: {
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: ADMIN_INVENTORY_LOOKUP_TOOL_SMOKE,
    },
  });
  const inventoryLookupToolCacheControl = requireNoStoreCacheControl(
    inventoryLookupToolResponse,
    `Authenticated Admin MCP ${ADMIN_INVENTORY_LOOKUP_TOOL_SMOKE.name}`,
  );
  const inventoryLookupToolResult = requireMcpJsonRpcResult(
    inventoryLookupToolResponse,
    `Authenticated Admin MCP ${ADMIN_INVENTORY_LOOKUP_TOOL_SMOKE.name}`,
    16,
  );
  const inventoryLookupToolEvaluation = evaluateAdminReadOnlyToolSmokeResult(
    inventoryLookupToolResult,
    { toolName: ADMIN_INVENTORY_LOOKUP_TOOL_SMOKE.name },
  );
  if (!inventoryLookupToolEvaluation.ok) {
    throw new Error(
      `Admin MCP ${ADMIN_INVENTORY_LOOKUP_TOOL_SMOKE.name} failed: ` +
      inventoryLookupToolEvaluation.errors.join("; "),
    );
  }

  const productCopyContextCallSummary = productCopyContextToolEvaluation
    ? ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME
    : `${ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME} skipped (no product candidate)`;

  logger?.log(
    `PASS admin MCP authenticated: tools ${toolEvaluation.toolNames.join(", ")}, ` +
    `calls ${ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE.name}, ` +
    `${ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE.name}, ` +
    `${ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE.name}, ` +
    `${ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE.name}, ` +
    `${ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE.name}, ` +
    `${ADMIN_CATEGORY_SEARCH_TOOL_SMOKE.name}, ` +
    `${ADMIN_COLLECTION_SEARCH_TOOL_SMOKE.name}, ` +
    `${ADMIN_PAGE_SEARCH_TOOL_SMOKE.name}, ` +
    `${ADMIN_MEDIA_SEARCH_TOOL_SMOKE.name}, ` +
    `${ADMIN_PRODUCT_SEARCH_TOOL_SMOKE.name}, ${productCopyContextCallSummary}, ` +
    `${ADMIN_ORDER_SEARCH_TOOL_SMOKE.name}, ` +
    `${ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE.name}, ` +
    `${ADMIN_INVENTORY_LOOKUP_TOOL_SMOKE.name} ok.`,
  );
  return {
    dashboardUrl: redactUrl(normalizedDashboardUrl),
    signIn,
    mcp: {
      url: redactUrl(mcpUrl),
      initialize: {
        statusCode: initializeResponse.statusCode,
        durationMs: initializeResponse.durationMs,
        cacheControl: initializeCacheControl,
        protocolVersion: negotiatedProtocolVersion,
        session: sessionId ? "present" : "none",
      },
      tools: {
        statusCode: toolsResponse.statusCode,
        durationMs: toolsResponse.durationMs,
        cacheControl: toolsCacheControl,
        toolNames: toolEvaluation.toolNames,
        readOnlyToolCount: toolEvaluation.readOnlyToolCount,
      },
      navigationTool: {
        name: ADMIN_NAVIGATION_CONTEXT_TOOL_SMOKE.name,
        statusCode: navigationToolResponse.statusCode,
        durationMs: navigationToolResponse.durationMs,
        cacheControl: navigationToolCacheControl,
        contentCount: navigationToolEvaluation.contentCount,
        defaultPath: navigationToolEvaluation.defaultPath,
        returnedPages: navigationToolEvaluation.returnedPages,
        sectionCount: navigationToolEvaluation.sectionCount,
      },
      dashboardSummaryTool: {
        name: ADMIN_DASHBOARD_SUMMARY_TOOL_SMOKE.name,
        statusCode: dashboardSummaryToolResponse.statusCode,
        durationMs: dashboardSummaryToolResponse.durationMs,
        cacheControl: dashboardSummaryToolCacheControl,
        contentCount: dashboardSummaryToolEvaluation.contentCount,
        numericStatKeys: dashboardSummaryToolEvaluation.numericStatKeys,
      },
      settingsSummaryTool: {
        name: ADMIN_SETTINGS_SUMMARY_TOOL_SMOKE.name,
        statusCode: settingsSummaryToolResponse.statusCode,
        durationMs: settingsSummaryToolResponse.durationMs,
        cacheControl: settingsSummaryToolCacheControl,
        contentCount: settingsSummaryToolEvaluation.contentCount,
      },
      notificationSettingsSummaryTool: {
        name: ADMIN_NOTIFICATION_SETTINGS_SUMMARY_TOOL_SMOKE.name,
        statusCode: notificationSettingsSummaryToolResponse.statusCode,
        durationMs: notificationSettingsSummaryToolResponse.durationMs,
        cacheControl: notificationSettingsSummaryToolCacheControl,
        contentCount: notificationSettingsSummaryToolEvaluation.contentCount,
        customerEventCount: notificationSettingsSummaryToolEvaluation.customerEventCount,
        merchantEventCount: notificationSettingsSummaryToolEvaluation.merchantEventCount,
        readinessIssueCount: notificationSettingsSummaryToolEvaluation.readinessIssueCount,
      },
      analyticsSummaryTool: {
        name: ADMIN_ANALYTICS_SUMMARY_TOOL_SMOKE.name,
        statusCode: analyticsSummaryToolResponse.statusCode,
        durationMs: analyticsSummaryToolResponse.durationMs,
        cacheControl: analyticsSummaryToolCacheControl,
        contentCount: analyticsSummaryToolEvaluation.contentCount,
        numericStatKeys: analyticsSummaryToolEvaluation.numericStatKeys,
        providerCount: analyticsSummaryToolEvaluation.providerCount,
      },
      categorySearchTool: {
        name: ADMIN_CATEGORY_SEARCH_TOOL_SMOKE.name,
        statusCode: categorySearchToolResponse.statusCode,
        durationMs: categorySearchToolResponse.durationMs,
        cacheControl: categorySearchToolCacheControl,
        contentCount: categorySearchToolEvaluation.contentCount,
      },
      collectionSearchTool: {
        name: ADMIN_COLLECTION_SEARCH_TOOL_SMOKE.name,
        statusCode: collectionSearchToolResponse.statusCode,
        durationMs: collectionSearchToolResponse.durationMs,
        cacheControl: collectionSearchToolCacheControl,
        contentCount: collectionSearchToolEvaluation.contentCount,
      },
      pageSearchTool: {
        name: ADMIN_PAGE_SEARCH_TOOL_SMOKE.name,
        statusCode: pageSearchToolResponse.statusCode,
        durationMs: pageSearchToolResponse.durationMs,
        cacheControl: pageSearchToolCacheControl,
        contentCount: pageSearchToolEvaluation.contentCount,
      },
      mediaSearchTool: {
        name: ADMIN_MEDIA_SEARCH_TOOL_SMOKE.name,
        statusCode: mediaSearchToolResponse.statusCode,
        durationMs: mediaSearchToolResponse.durationMs,
        cacheControl: mediaSearchToolCacheControl,
        contentCount: mediaSearchToolEvaluation.contentCount,
      },
      productSearchTool: {
        name: ADMIN_PRODUCT_SEARCH_TOOL_SMOKE.name,
        statusCode: productSearchToolResponse.statusCode,
        durationMs: productSearchToolResponse.durationMs,
        cacheControl: productSearchToolCacheControl,
        contentCount: productSearchToolEvaluation.contentCount,
      },
      productCopyContextTool: productCopyContextToolEvaluation && productCopyContextToolResponse
        ? {
            name: ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME,
            statusCode: productCopyContextToolResponse.statusCode,
            durationMs: productCopyContextToolResponse.durationMs,
            cacheControl: productCopyContextToolCacheControl,
            contentCount: productCopyContextToolEvaluation.contentCount,
            productId: productCopyContextToolEvaluation.productId,
            descriptionLength: productCopyContextToolEvaluation.descriptionLength,
          }
        : {
            name: ADMIN_PRODUCT_COPY_CONTEXT_TOOL_NAME,
            skipped: true,
            reason: "admin_product_search returned no product candidate",
          },
      orderSearchTool: {
        name: ADMIN_ORDER_SEARCH_TOOL_SMOKE.name,
        statusCode: orderSearchToolResponse.statusCode,
        durationMs: orderSearchToolResponse.durationMs,
        cacheControl: orderSearchToolCacheControl,
        contentCount: orderSearchToolEvaluation.contentCount,
      },
      customerSearchTool: {
        name: ADMIN_CUSTOMER_SEARCH_TOOL_SMOKE.name,
        statusCode: customerSearchToolResponse.statusCode,
        durationMs: customerSearchToolResponse.durationMs,
        cacheControl: customerSearchToolCacheControl,
        contentCount: customerSearchToolEvaluation.contentCount,
        customerCount: customerSearchToolEvaluation.customerCount,
      },
      inventoryLookupTool: {
        name: ADMIN_INVENTORY_LOOKUP_TOOL_SMOKE.name,
        statusCode: inventoryLookupToolResponse.statusCode,
        durationMs: inventoryLookupToolResponse.durationMs,
        cacheControl: inventoryLookupToolCacheControl,
        contentCount: inventoryLookupToolEvaluation.contentCount,
      },
    },
  };
}

function hasNoStoreishFailureCache(cacheControl) {
  return (
    hasHeaderToken(cacheControl, "no-store") ||
    (hasHeaderToken(cacheControl, "private") && hasHeaderToken(cacheControl, "no-cache"))
  );
}

function hasControlCharacter(value) {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isSafeStorefrontChatPathSegment(segment) {
  if (
    !segment ||
    segment.length > 160 ||
    !STOREFRONT_CHAT_SAFE_PATH_SEGMENT_PATTERN.test(segment)
  ) {
    return false;
  }

  try {
    const decoded = decodeURIComponent(segment);
    return decoded === segment && decoded !== "." && decoded !== ".." && !hasControlCharacter(decoded);
  } catch {
    return false;
  }
}

function storefrontChatPathSegments(pathname) {
  if (
    !pathname.startsWith("/") ||
    pathname.includes("\\") ||
    STOREFRONT_CHAT_ENCODED_UNSAFE_PATH_PATTERN.test(pathname)
  ) {
    return null;
  }

  const segments = pathname.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => !segment)) return null;
  return segments.every(isSafeStorefrontChatPathSegment) ? segments : null;
}

function storefrontChatPathHasBlockedSegment(segments) {
  return segments.some((segment) =>
    STOREFRONT_CHAT_BLOCKED_BUYER_PATH_SEGMENTS.has(segment.toLowerCase())
  );
}

function isSafeStorefrontChatCatalogPath(pathname, prefix) {
  if (!pathname.startsWith(`/${prefix}/`)) return false;
  const segments = storefrontChatPathSegments(pathname);
  if (!segments || segments[0] !== prefix) return false;
  const rest = segments.slice(1);
  return rest.length > 0 && !storefrontChatPathHasBlockedSegment(rest);
}

function isSafeStorefrontChatCmsPagePath(pathname) {
  const segments = storefrontChatPathSegments(pathname);
  if (!segments || segments.length !== 1) return false;
  return !STOREFRONT_CHAT_RESERVED_CMS_PAGE_SLUGS.has(segments[0].toLowerCase());
}

function hasSensitiveStorefrontChatQueryValue(value) {
  return (
    STOREFRONT_CHAT_TOKEN_LIKE_QUERY_VALUE_PATTERN.test(value) ||
    STOREFRONT_CHAT_EMAIL_QUERY_VALUE_PATTERN.test(value) ||
    STOREFRONT_CHAT_BANGLADESH_PHONE_QUERY_VALUE_PATTERN.test(value) ||
    STOREFRONT_CHAT_BROAD_PHONE_QUERY_VALUE_PATTERN.test(value)
  );
}

function isSafeStorefrontChatSearchQuery(search, params) {
  if (search.length > 512) return false;
  const entries = Array.from(params.entries());
  if (entries.length > 20) return false;

  return entries.every(([key, value]) => {
    return (
      key &&
      key.length <= 64 &&
      value.length <= 180 &&
      STOREFRONT_CHAT_SAFE_QUERY_KEY_PATTERN.test(key) &&
      !hasControlCharacter(key) &&
      !hasControlCharacter(value) &&
      !STOREFRONT_CHAT_SENSITIVE_QUERY_NAME_PATTERN.test(key) &&
      !hasSensitiveStorefrontChatQueryValue(value)
    );
  });
}

function isAllowedStorefrontChatNavigationUrl(url) {
  if (url.hash || url.username || url.password) return false;
  if (url.pathname === "/cart") return url.search === "";
  if (url.pathname === "/search") {
    return isSafeStorefrontChatSearchQuery(url.search, url.searchParams);
  }
  if (url.search) return false;
  return (
    isSafeStorefrontChatCatalogPath(url.pathname, "products") ||
    isSafeStorefrontChatCatalogPath(url.pathname, "categories") ||
    isSafeStorefrontChatCatalogPath(url.pathname, "collections") ||
    isSafeStorefrontChatCmsPagePath(url.pathname)
  );
}

function normalizeStorefrontChatNavigationTarget(target, storefrontOrigin) {
  if (typeof target !== "string") return null;
  if (
    target !== target.trim() ||
    target.length > 2048 ||
    hasControlCharacter(target) ||
    target.startsWith("//") ||
    target.includes("\\") ||
    STOREFRONT_CHAT_RAW_PATH_TRAVERSAL_PATTERN.test(target) ||
    STOREFRONT_CHAT_ENCODED_UNSAFE_PATH_PATTERN.test(target)
  ) {
    return null;
  }

  const isAbsoluteHttpUrl = /^https?:\/\//i.test(target);
  if (!target.startsWith("/") && !isAbsoluteHttpUrl) return null;

  let url;
  try {
    url = new URL(target, storefrontOrigin);
  } catch {
    return null;
  }

  if (
    url.origin !== storefrontOrigin ||
    !["http:", "https:"].includes(url.protocol) ||
    !isAllowedStorefrontChatNavigationUrl(url)
  ) {
    return null;
  }

  return `${url.pathname}${url.search}`;
}

function readStorefrontChatActionTarget(action) {
  for (const key of STOREFRONT_CHAT_NAVIGATION_TARGET_KEYS) {
    const value = action[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function collectStorefrontChatActionArrays(value, path = "$", seen = new Set()) {
  const arrays = [];
  if (!isRecord(value) && !Array.isArray(value)) return arrays;
  if (seen.has(value)) return arrays;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      arrays.push(...collectStorefrontChatActionArrays(item, `${path}[${index}]`, seen));
    });
    return arrays;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (Array.isArray(child) && /(?:^|_)(?:actions?|navigationActions?)$/i.test(key)) {
      arrays.push({ path: childPath, actions: child });
    } else if (isRecord(child) && /(?:^|_)(?:action|navigationAction)$/i.test(key)) {
      arrays.push({ path: childPath, actions: [child] });
    }
    arrays.push(...collectStorefrontChatActionArrays(child, childPath, seen));
  }

  return arrays;
}

function evaluateStorefrontChatActionSafety(payload, { storefrontOrigin } = {}) {
  const errors = [];
  const targets = [];
  let actionCount = 0;

  for (const { path, actions } of collectStorefrontChatActionArrays(payload)) {
    if (actions.length > 5) {
      errors.push(`Storefront chat ${path} must return at most 5 click-confirmed actions.`);
    }

    actions.forEach((action, index) => {
      const label = `${path}[${index}]`;
      actionCount += 1;
      if (!isRecord(action)) {
        errors.push(`Storefront chat ${label} action must be an object.`);
        return;
      }

      if (action.type !== "navigate") {
        errors.push(`Storefront chat ${label} must be a click-confirmed navigate action.`);
      }

      for (const key of Object.keys(action)) {
        if (STOREFRONT_CHAT_UNSAFE_ACTION_KEY_PATTERN.test(key)) {
          errors.push(`Storefront chat ${label} must not include unsafe action field ${key}.`);
        }
      }

      const rawTarget = readStorefrontChatActionTarget(action);
      const target = normalizeStorefrontChatNavigationTarget(rawTarget, storefrontOrigin);
      if (!target) {
        errors.push(
          `Storefront chat ${label} target is not a safe same-origin public buyer path: ` +
          String(rawTarget ?? "missing"),
        );
      } else {
        targets.push(target);
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    actionCount,
    targets,
  };
}

function isExpectedStorefrontChatFailClosedPayload(payload) {
  if (payload?.status === "disabled") {
    const text = [
      typeof payload.reason === "string" ? payload.reason : "",
      typeof payload.message === "string" ? payload.message : "",
    ].join(" ");
    return STOREFRONT_CHAT_FAIL_CLOSED_PATTERN.test(text);
  }

  const error = isRecord(payload?.error) ? payload.error : null;
  const text = [
    typeof error?.code === "string" ? error.code : "",
    typeof error?.message === "string" ? error.message : "",
  ].join(" ");

  return payload?.success === false && STOREFRONT_CHAT_FAIL_CLOSED_PATTERN.test(text);
}

function readStorefrontChatSuccessData(payload) {
  if (payload?.success === true && isRecord(payload?.data)) return payload.data;
  if (payload?.status === "ok" && isRecord(payload)) return payload;
  return null;
}

function evaluateStorefrontChatSuccessPayload(payload, { storefrontOrigin }) {
  const errors = [];
  const data = readStorefrontChatSuccessData(payload);
  const message = isRecord(data?.message) ? data.message : null;
  const actionSafety = evaluateStorefrontChatActionSafety(payload, { storefrontOrigin });

  if (payload?.success !== true && payload?.status !== "ok") {
    errors.push('Storefront chat success response must set success=true or status="ok".');
  }
  if (!data) {
    errors.push("Storefront chat success response must include a data object.");
  } else {
    if (data.profile !== undefined && data.profile !== "storefrontChat") {
      errors.push('Storefront chat success response must use profile "storefrontChat".');
    }
    if (!message) {
      errors.push("Storefront chat success response must include an assistant message.");
    } else {
      if (message.role !== "assistant") {
        errors.push("Storefront chat message role must be assistant.");
      }
      if (typeof message.content !== "string" || !message.content.trim()) {
        errors.push("Storefront chat message content must be a non-empty string.");
      } else if (message.content.length > 8_000) {
        errors.push("Storefront chat message content must be bounded.");
      }
    }
  }

  errors.push(...actionSafety.errors);
  return {
    ok: errors.length === 0,
    errors,
    actionCount: actionSafety.actionCount,
    actionTargets: actionSafety.targets,
    profile: typeof data?.profile === "string" ? data.profile : null,
    model: typeof data?.model === "string" ? data.model : null,
  };
}

export async function smokeStorefrontChat({
  storefrontUrl = DEFAULT_STOREFRONT_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const normalizedStorefrontUrl = normalizeHttpBaseUrl(storefrontUrl, "Storefront URL");
  const storefrontOrigin = new URL(normalizedStorefrontUrl).origin;
  const chatUrl = buildUrl(normalizedStorefrontUrl, STOREFRONT_ASSISTANT_CHAT_PATH);
  const response = await fetchJson(chatUrl, {
    fetchImpl,
    timeoutMs,
    method: "POST",
    headers: {
      Origin: storefrontOrigin,
    },
    body: STOREFRONT_CHAT_SMOKE_BODY,
  });

  if (response.statusCode === 404) {
    const reason = "Storefront chat endpoint is not deployed yet.";
    logger?.warn(`WARN storefront chat skipped (${reason})`);
    return {
      status: "skipped",
      reason,
      url: redactUrl(chatUrl),
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      cacheControl: response.headers.get("cache-control") ?? "",
    };
  }

  const cacheControl = requireNoStoreCacheControl(response, "Storefront chat smoke");
  const payload = requireJsonResponse(response, "Storefront chat smoke");

  if (response.statusCode >= 200 && response.statusCode < 300) {
    const evaluation = evaluateStorefrontChatSuccessPayload(payload, { storefrontOrigin });
    if (!evaluation.ok) {
      throw new Error(`Storefront chat smoke failed: ${evaluation.errors.join("; ")}`);
    }

    logger?.log(
      `PASS storefront chat: configured public chat returned ${response.statusCode} no-store with ` +
      `${evaluation.actionCount} safe actions.`,
    );
    return {
      url: redactUrl(chatUrl),
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      cacheControl,
      mode: "configured",
      profile: evaluation.profile,
      model: evaluation.model,
      actionCount: evaluation.actionCount,
      actionTargets: evaluation.actionTargets,
    };
  }

  const actionSafety = evaluateStorefrontChatActionSafety(payload, { storefrontOrigin });
  if (!isExpectedStorefrontChatFailClosedPayload(payload)) {
    throw new Error(
      `Storefront chat smoke returned HTTP ${response.statusCode} without a disabled/unconfigured fail-closed error: ` +
      responsePreview(response.body),
    );
  }
  if (!actionSafety.ok || actionSafety.actionCount > 0) {
    throw new Error(
      "Storefront chat fail-closed response must not include unsafe or executable actions: " +
      [
        ...actionSafety.errors,
        actionSafety.actionCount > 0 ? "fail-closed response included actions" : "",
      ].filter(Boolean).join("; "),
    );
  }

  const error = isRecord(payload.error) ? payload.error : {};
  logger?.log(
    `PASS storefront chat: fail-closed ${response.statusCode} no-store while storefrontChat is disabled/unconfigured.`,
  );
  return {
    url: redactUrl(chatUrl),
    statusCode: response.statusCode,
    durationMs: response.durationMs,
    cacheControl,
    mode: "fail_closed",
    errorCode: typeof error.code === "string" ? error.code : null,
  };
}

export async function smokeAdminMcpUnauthenticated({
  dashboardUrl = DEFAULT_DASHBOARD_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const normalizedDashboardUrl = normalizeHttpBaseUrl(dashboardUrl, "Dashboard URL");
  const mcpUrl = buildUrl(normalizedDashboardUrl, ADMIN_ASSISTANT_MCP_PATH);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        Accept: MCP_ACCEPT_HEADER,
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ADMIN_MCP_UNAUTHENTICATED_SMOKE_BODY),
      signal: controller.signal,
    });
    const body = await response.text();
    const cacheControl = response.headers.get("cache-control") ?? "";

    if (response.status !== 401 && response.status !== 403) {
      throw new Error(
        `Admin MCP unauthenticated smoke returned HTTP ${response.status}; ` +
        `expected 401/403: ${responsePreview(body)}`,
      );
    }
    if (!hasNoStoreishFailureCache(cacheControl)) {
      throw new Error(
        "Admin MCP unauthenticated smoke must return no-store-ish Cache-Control; " +
        `got ${cacheControl || "missing Cache-Control"}.`,
      );
    }

    logger?.log(
      `PASS admin MCP auth: unauthenticated dashboard proxy returned ${response.status}.`,
    );
    return {
      url: redactUrl(mcpUrl),
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      cacheControl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function collectUcpCapabilityNames(profile) {
  const capabilities = isRecord(profile?.ucp?.capabilities)
    ? profile.ucp.capabilities
    : {};
  return Object.keys(capabilities);
}

function readUcpShoppingService(profile) {
  const services = isRecord(profile?.ucp?.services) ? profile.ucp.services : null;
  const shoppingServices = Array.isArray(services?.[UCP_SHOPPING_SERVICE])
    ? services[UCP_SHOPPING_SERVICE]
    : [];
  return shoppingServices.find((service) =>
    isRecord(service) &&
    service.transport === "rest" &&
    typeof service.endpoint === "string"
  ) ?? null;
}

function firstUcpCapabilityDescriptor(profile, capability) {
  const descriptors = isRecord(profile?.ucp?.capabilities) &&
    Array.isArray(profile.ucp.capabilities[capability])
    ? profile.ucp.capabilities[capability]
    : [];
  return descriptors.find(isRecord) ?? null;
}

function validateUcpDescriptor(
  descriptor,
  {
    label,
    version,
    spec,
    schema,
    errors,
  },
) {
  if (!isRecord(descriptor)) {
    errors.push(`${label} descriptor must be an object.`);
    return;
  }
  if (descriptor.version !== version) {
    errors.push(`${label} descriptor version must be ${version}.`);
  }
  if (descriptor.spec !== spec) {
    errors.push(`${label} descriptor spec must be ${spec}.`);
  }
  if (descriptor.schema !== schema) {
    errors.push(`${label} descriptor schema must be ${schema}.`);
  }
}

export function evaluateUcpProfile(profile, { storefrontOrigin } = {}) {
  const errors = [];
  const version = typeof profile?.ucp?.version === "string" ? profile.ucp.version : null;
  const service = readUcpShoppingService(profile);
  const endpoint = typeof service?.endpoint === "string" ? service.endpoint : null;
  const capabilities = collectUcpCapabilityNames(profile);
  const forbiddenCapabilities = capabilities.filter((name) =>
    UCP_FORBIDDEN_CAPABILITY_PATTERN.test(name)
  );
  const requiredCapabilities = [
    UCP_CATALOG_SEARCH_CAPABILITY,
    UCP_CATALOG_LOOKUP_CAPABILITY,
  ];
  const unexpectedCapabilities = capabilities.filter((name) => !requiredCapabilities.includes(name));

  if (!isRecord(profile?.ucp)) {
    errors.push("UCP profile must include a ucp object.");
  }
  if (hasOwnField(profile, "payment_handlers") || hasOwnField(profile?.ucp, "payment_handlers")) {
    errors.push("UCP profile must not include a top-level payment_handlers field.");
  }
  if (!version) {
    errors.push("UCP profile must include ucp.version.");
  }
  if (!endpoint) {
    errors.push(`UCP profile must advertise a REST ${UCP_SHOPPING_SERVICE} service endpoint.`);
  } else if (!isHttpUrl(endpoint)) {
    errors.push(`UCP service endpoint is not absolute http(s): ${endpoint}`);
  } else if (storefrontOrigin && !isSameOrigin(endpoint, storefrontOrigin)) {
    errors.push(`UCP service endpoint is not on storefront origin: ${endpoint}`);
  } else {
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.pathname !== "/ucp" && !endpointUrl.pathname.startsWith("/ucp/")) {
      errors.push(`UCP service endpoint must be under /ucp: ${endpoint}`);
    }
    if (endpointUrl.pathname.endsWith("/") && endpointUrl.pathname !== "/") {
      errors.push("UCP service endpoint should not have a trailing slash.");
    }
  }

  if (version && service) {
    validateUcpDescriptor(service, {
      label: "UCP shopping REST service",
      version,
      spec: `https://ucp.dev/${version}/specification/overview`,
      schema: `https://ucp.dev/${version}/services/shopping/rest.openapi.json`,
      errors,
    });
  }

  for (const capability of requiredCapabilities) {
    if (!capabilities.includes(capability)) {
      errors.push(`UCP profile must advertise ${capability}.`);
      continue;
    }

    if (version) {
      const suffix = capability === UCP_CATALOG_SEARCH_CAPABILITY
        ? { spec: "catalog/search", schema: "catalog_search" }
        : { spec: "catalog/lookup", schema: "catalog_lookup" };
      validateUcpDescriptor(firstUcpCapabilityDescriptor(profile, capability), {
        label: capability,
        version,
        spec: `https://ucp.dev/${version}/specification/${suffix.spec}`,
        schema: `https://ucp.dev/${version}/schemas/shopping/${suffix.schema}.json`,
        errors,
      });
    }
    if (capability.startsWith("dev.ucp.")) {
      const descriptor = firstUcpCapabilityDescriptor(profile, capability);
      for (const field of ["spec", "schema"]) {
        const value = descriptor?.[field];
        if (typeof value === "string" && !value.startsWith("https://ucp.dev/")) {
          errors.push(`${capability} descriptor ${field} must be hosted on https://ucp.dev/.`);
        }
      }
    }
  }
  if (unexpectedCapabilities.length > 0) {
    errors.push(`UCP profile must advertise only catalog search/lookup capabilities: ${unexpectedCapabilities.join(", ")}`);
  }
  if (forbiddenCapabilities.length > 0) {
    errors.push(`UCP profile must not advertise checkout/cart/order/payment capabilities: ${forbiddenCapabilities.join(", ")}`);
  }

  const supportedVersions = isRecord(profile?.ucp?.supported_versions)
    ? profile.ucp.supported_versions
    : {};
  const supportedProfileUrl = version ? supportedVersions[version] : null;
  if (version && typeof supportedProfileUrl === "string") {
    if (!isHttpUrl(supportedProfileUrl)) {
      errors.push(`UCP supported version URL is not absolute http(s): ${supportedProfileUrl}`);
    } else if (storefrontOrigin && !isSameOrigin(supportedProfileUrl, storefrontOrigin)) {
      errors.push(`UCP supported version URL is not on storefront origin: ${supportedProfileUrl}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    version,
    endpoint,
    capabilities,
  };
}

function productSearchQueryFromUrl(productUrl, storefrontOrigin) {
  if (!productUrl || !isSameOrigin(productUrl, storefrontOrigin)) return null;
  const parsed = new URL(productUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const lastSegment = segments.at(-1);
  if (!lastSegment) return null;
  try {
    return decodeURIComponent(lastSegment).replace(/[-_]+/g, " ").trim() || null;
  } catch {
    return lastSegment.replace(/[-_]+/g, " ").trim() || null;
  }
}

function firstUcpSearchCandidate(searchPayload) {
  const products = Array.isArray(searchPayload?.products) ? searchPayload.products : [];
  for (const product of products) {
    if (!isRecord(product)) continue;
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variant = variants.find(isRecord);
    const id = typeof variant?.id === "string"
      ? variant.id
      : typeof product.id === "string"
        ? product.id
        : typeof product.url === "string"
          ? product.url
          : null;
    if (id) {
      return {
        id,
        productId: typeof product.id === "string" ? product.id : null,
        variantId: typeof variant?.id === "string" ? variant.id : null,
      };
    }
  }
  return null;
}

function lookupPayloadHasInputCorrelation(lookupPayload, inputId) {
  const products = Array.isArray(lookupPayload?.products) ? lookupPayload.products : [];
  return products.some((product) => {
    if (!isRecord(product) || !Array.isArray(product.variants)) return false;
    return product.variants.some((variant) => {
      if (!isRecord(variant) || !Array.isArray(variant.inputs)) return false;
      return variant.inputs.some((input) => isRecord(input) && input.id === inputId);
    });
  });
}

function evaluateUcpProductPayload(productPayload, { expectedFirstVariantId } = {}) {
  const errors = [];
  const product = isRecord(productPayload?.product) ? productPayload.product : null;
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const firstVariant = variants.find((variant, index) => index === 0 && isRecord(variant)) ?? null;
  const firstVariantId = typeof firstVariant?.id === "string" ? firstVariant.id : null;

  if (productPayload?.ucp?.status !== "success") {
    errors.push("UCP catalog product must return ucp.status=success.");
  }
  if (!product) {
    errors.push("UCP catalog product must include a product object.");
  }
  if (variants.length === 0) {
    errors.push("UCP catalog product must include at least one variant.");
  }
  if (!firstVariantId) {
    errors.push("UCP catalog product first variant must include an id.");
  } else if (expectedFirstVariantId && firstVariantId !== expectedFirstVariantId) {
    errors.push(
      `UCP catalog product first variant ${firstVariantId} did not match requested variant ${expectedFirstVariantId}.`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    productId: typeof product?.id === "string" ? product.id : null,
    firstVariantId,
    variantCount: variants.length,
  };
}

function createCheckError(message, result) {
  const error = new Error(message);
  error.result = result;
  return error;
}

async function runStep(result, name, fn) {
  try {
    const stepResult = await fn();
    const { status = "passed", ...rest } = stepResult ?? {};
    result.checks[name] = { status, ...rest };
    return result.checks[name];
  } catch (error) {
    const message = errorMessage(error);
    result.checks[name] = { status: "failed", error: message };
    throw createCheckError(message, result);
  }
}

async function checkTracker({ rootDir, readFileImpl, logger }) {
  const trackerPath = resolve(rootDir, "audit/REMEDIATION_TRACKER.md");
  const evaluation = evaluateRemediationTracker(readFileImpl(trackerPath, "utf8"));
  if (!evaluation.ok) {
    throw new Error(
      "Open P0/P1 tracker blockers: " +
      evaluation.blockers.map((item) => `${item.id} ${item.severity} ${item.status}`).join("; "),
    );
  }

  logger?.log(`PASS tracker: ${evaluation.checkedRows} rows checked; no open P0/P1 blockers.`);
  return evaluation;
}

async function checkRequiredDocs({ rootDir, fileExistsImpl, logger }) {
  const evaluation = evaluateRequiredDocs({ rootDir, fileExistsImpl });
  if (!evaluation.ok) {
    throw new Error(`Missing release docs: ${evaluation.missing.join(", ")}`);
  }

  logger?.log(`PASS docs: ${evaluation.checkedFiles} required docs present.`);
  return evaluation;
}

async function checkApiOps(options, {
  apiConfig,
  fetchImpl,
  execFileImpl,
  sleepImpl,
  pnpmExecutable,
  rootDir,
  logger,
  opsMonitorConfig,
}) {
  const opsArgs = [
    "--api-base-url", options.apiBaseUrl,
    "--samples", String(RELEASE_READYZ_SAMPLES),
    "--timeout-ms", String(options.timeoutMs),
  ];
  if (options.skipWrangler) {
    opsArgs.push("--skip-wrangler");
  } else {
    opsArgs.push("--queues");
  }

  const opsOptions = parseOpsCheckArgs(opsArgs, {
    defaultApiBaseUrl: options.apiBaseUrl,
  });
  const result = await runOpsCheck(opsOptions, {
    apiConfig,
    fetchImpl,
    execFileImpl,
    sleepImpl,
    pnpmExecutable,
    rootDir,
    logger: null,
    requestId: "release-check",
    opsMonitorConfig,
  });

  const deployment = result.checks.deployment;
  const deploymentSummary = deployment?.status === "skipped"
    ? "deployment skipped"
    : `deployment ${deployment?.versionId ?? "unknown"}`;
  const queues = result.checks.queues;
  const queueSummary = queues?.status === "skipped"
    ? "queues skipped"
    : `queues ${queues?.queueCount ?? 0} checked`;
  logger?.log(
    `PASS API ops: health ${result.checks.health.statusCode}, ` +
    `readyz ${result.checks.readyz.readyCount}/${result.checks.readyz.sampleCount}, ` +
    `openapi ${result.checks.openapi.pathCount} paths, ${deploymentSummary}, ${queueSummary}.`,
  );

  return {
    apiBaseUrl: redactUrl(options.apiBaseUrl),
    healthStatusCode: result.checks.health.statusCode,
    readyCount: result.checks.readyz.readyCount,
    readySampleCount: result.checks.readyz.sampleCount,
    openApiPathCount: result.checks.openapi.pathCount,
    deploymentStatus: deployment?.status ?? "passed",
    deploymentVersionId: deployment?.versionId ?? null,
    queueStatus: queues?.status ?? "unknown",
    queueCount: queues?.queueCount ?? 0,
    queues,
    monitoringConfigStatus: result.checks.monitoringConfig.status,
    opsMonitorAlertChannel: result.checks.opsMonitorAlertChannel,
    warnings: result.warnings,
    requiredActions: result.requiredActions,
  };
}

async function checkDashboard(options, { fetchImpl, logger }) {
  const url = buildUrl(options.dashboardUrl, "/admin");
  const response = await fetchText(url, {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    accept: "text/html, */*;q=0.8",
    redirect: "manual",
  });
  requireStatus(response, "Dashboard /admin", (status) =>
    (status >= 200 && status < 400) || status === 401 || status === 403);
  const location = response.headers.get("location") ?? "";
  const bodyLower = response.body.toLowerCase();
  const gateVisible =
    response.statusCode === 401 ||
    response.statusCode === 403 ||
    location.includes("/auth/login") ||
    location.includes("/login") ||
    bodyLower.includes("sign in") ||
    bodyLower.includes("log in") ||
    bodyLower.includes("login");
  if (!gateVisible) {
    throw new Error("Dashboard /admin did not prove an auth gate or login surface.");
  }

  logger?.log(`PASS dashboard: /admin returned ${response.statusCode}.`);
  return {
    url: redactUrl(url),
    statusCode: response.statusCode,
    durationMs: response.durationMs,
    location: location || null,
  };
}

async function checkInvalidAdminCookieFailure({ url, label, fetchImpl, timeoutMs }) {
  const response = await fetchJson(url, {
    fetchImpl,
    timeoutMs,
    headers: {
      Cookie: INVALID_ADMIN_SESSION_COOKIE,
    },
  });

  if (
    response.statusCode === 504 ||
    response.body.includes(ADMIN_API_READ_TIMEOUT_CODE)
  ) {
    throw new Error(
      `${label} hit ${ADMIN_API_READ_TIMEOUT_CODE}/504 instead of rejecting the invalid admin cookie quickly.`,
    );
  }
  if (response.statusCode >= 200 && response.statusCode < 300) {
    throw new Error(
      `${label} accepted an invalid better-auth.session_token with HTTP ${response.statusCode}.`,
    );
  }
  if (response.statusCode !== 401 && response.statusCode !== 403) {
    throw new Error(
      `${label} returned HTTP ${response.statusCode}; expected 401/403 for an invalid better-auth.session_token: ${responsePreview(response.body)}`,
    );
  }

  return {
    url: redactUrl(url),
    statusCode: response.statusCode,
    durationMs: response.durationMs,
  };
}

async function checkInvalidAdminCookieAuth(options, { fetchImpl, logger }) {
  const apiUrl = buildUrl(options.apiBaseUrl, ADMIN_BUSINESS_SETTINGS_PATH);
  const dashboardProxyUrl = buildUrl(options.dashboardUrl, ADMIN_BUSINESS_SETTINGS_PATH);

  const api = await checkInvalidAdminCookieFailure({
    url: apiUrl,
    label: "API admin business settings invalid-cookie smoke",
    fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const dashboardProxy = await checkInvalidAdminCookieFailure({
    url: dashboardProxyUrl,
    label: "Dashboard proxy admin business settings invalid-cookie smoke",
    fetchImpl,
    timeoutMs: options.timeoutMs,
  });

  logger?.log(
    `PASS admin auth: invalid cookie rejected by API (${api.statusCode}) and dashboard proxy (${dashboardProxy.statusCode}).`,
  );
  return { api, dashboardProxy };
}

async function checkStorefrontPages(options, { fetchImpl, logger }) {
  const pages = [];
  for (const path of ["/health", "/", "/search"]) {
    const url = buildUrl(options.storefrontUrl, path);
    const response = await fetchText(url, {
      fetchImpl,
      timeoutMs: options.timeoutMs,
      accept: path === "/health" ? "text/plain, */*;q=0.8" : "text/html, */*;q=0.8",
    });
    requireStatus(response, `Storefront ${path}`, (status) => status >= 200 && status < 300);
    pages.push({
      path,
      statusCode: response.statusCode,
      durationMs: response.durationMs,
    });
  }

  logger?.log("PASS storefront: /health, /, and /search returned 2xx.");
  return { pages };
}

async function checkStorefrontCacheHeaders(options, { fetchImpl, logger }) {
  const publicPages = [];
  for (const path of ["/", "/search?sortBy=newest"]) {
    const response = await fetchText(buildUrlWithSearch(options.storefrontUrl, path), {
      fetchImpl,
      timeoutMs: options.timeoutMs,
      accept: "text/html, */*;q=0.8",
    });
    requireStatus(response, `Storefront cache headers ${path}`, (status) =>
      status >= 200 && status < 300);
    const cache = evaluatePublicStorefrontCacheHeaders(response.headers, {
      label: `Storefront ${path}`,
    });
    if (!cache.ok) {
      throw new Error(`Storefront ${path} cache headers failed: ${cache.errors.join("; ")}`);
    }
    publicPages.push({
      path,
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      cacheControl: cache.cacheControl,
      cacheStatus: cache.cacheStatus,
    });
  }

  const checkoutResponse = await fetchText(buildUrl(options.storefrontUrl, "/checkout"), {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    accept: "text/html, */*;q=0.8",
  });
  requireStatus(checkoutResponse, "Storefront /checkout cache headers", (status) =>
    status >= 200 && status < 400);
  const checkout = evaluateCheckoutCacheHeaders(checkoutResponse.headers);
  if (!checkout.ok) {
    throw new Error(`Storefront /checkout cache headers failed: ${checkout.errors.join("; ")}`);
  }

  const productFeedResponse = await fetchText(
    buildUrlWithSearch(options.storefrontUrl, "/api/product-feed.xml?limit=5"),
    {
      fetchImpl,
      timeoutMs: options.timeoutMs,
      accept: "application/xml, text/xml, */*;q=0.8",
    },
  );
  requireStatus(productFeedResponse, "Storefront /api/product-feed.xml cache headers", (status) =>
    status >= 200 && status < 300);
  const productFeed = evaluateFeedGenerationCacheHeaders(productFeedResponse.headers);
  if (!productFeed.ok) {
    throw new Error(
      `Storefront /api/product-feed.xml cache headers failed: ${productFeed.errors.join("; ")}`,
    );
  }

  const purgeGetResponse = await fetchText(buildUrl(options.storefrontUrl, "/api/purge-cache"), {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    accept: "text/plain, application/json, */*;q=0.8",
  });
  requireStatus(purgeGetResponse, "Storefront /api/purge-cache GET", (status) => status === 405);
  const purgeGet = evaluatePurgeGetHeaders(purgeGetResponse.headers);
  if (!purgeGet.ok) {
    throw new Error(`Storefront /api/purge-cache GET headers failed: ${purgeGet.errors.join("; ")}`);
  }

  logger?.log(
    "PASS storefront cache headers: public pages report cache version/build, checkout is no-store, feed is generation-tagged, and purge GET is non-mutating.",
  );
  return {
    paths: [...STOREFRONT_CACHE_HEADER_PATHS],
    publicPages,
    checkout: {
      path: "/checkout",
      statusCode: checkoutResponse.statusCode,
      durationMs: checkoutResponse.durationMs,
      cacheControl: checkout.cacheControl,
      cacheStatus: checkout.cacheStatus,
    },
    productFeed: {
      path: "/api/product-feed.xml?limit=5",
      statusCode: productFeedResponse.statusCode,
      durationMs: productFeedResponse.durationMs,
      cacheControl: productFeed.cacheControl,
      cacheStatus: productFeed.cacheStatus,
      generationHeader: productFeed.generationHeader,
    },
    purgeGet: {
      path: "/api/purge-cache",
      statusCode: purgeGetResponse.statusCode,
      durationMs: purgeGetResponse.durationMs,
      allow: purgeGet.allow,
      cacheControl: purgeGet.cacheControl,
    },
  };
}

async function checkStorefrontChat(options, { fetchImpl, logger }) {
  return smokeStorefrontChat({
    storefrontUrl: options.storefrontUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl,
    logger,
  });
}

async function checkAgentMcp(options, { fetchImpl, logger }) {
  if (options.skipWrangler) {
    logger?.warn("WARN agent MCP skipped (--skip-wrangler).");
    return {
      status: "skipped",
      reason: "Skipped by --skip-wrangler.",
      agentUrl: redactUrl(options.agentUrl),
    };
  }

  return smokeAgentWorker({
    agentUrl: options.agentUrl,
    storefrontUrl: options.storefrontUrl,
    catalogToolSmoke: true,
    timeoutMs: options.timeoutMs,
    fetchImpl,
    logger,
  });
}

async function checkAdminMcpAuth(options, { fetchImpl, logger }) {
  return smokeAdminMcpUnauthenticated({
    dashboardUrl: options.dashboardUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl,
    logger,
  });
}

async function checkAdminMcpAuthenticated(options, { fetchImpl, logger, env }) {
  const credentialStatus = releaseAdminCredentialEnvStatus(env);
  if (!credentialStatus.credentials) {
    const reason =
      `Set ${RELEASE_ADMIN_EMAIL_ENV} and ${RELEASE_ADMIN_PASSWORD_ENV} ` +
      "to enable authenticated Admin MCP smoke.";
    logger?.warn(
      `WARN admin MCP authenticated smoke skipped (${credentialStatus.missing.join(", ")} not set).`,
    );
    return {
      status: "skipped",
      reason,
      env: {
        email: RELEASE_ADMIN_EMAIL_ENV,
        password: RELEASE_ADMIN_PASSWORD_ENV,
      },
      missingEnv: credentialStatus.missing,
    };
  }

  return smokeAdminMcpAuthenticated({
    dashboardUrl: options.dashboardUrl,
    email: credentialStatus.credentials.email,
    password: credentialStatus.credentials.password,
    timeoutMs: options.timeoutMs,
    fetchImpl,
    logger,
  });
}

async function checkDiscovery(options, { fetchImpl, logger }) {
  const storefrontOrigin = new URL(options.storefrontUrl).origin;
  const responses = {};
  const checks = {};
  const { policy, result: policyResult } = await fetchSeoDiscoveryPolicy(options, {
    fetchImpl,
    logger,
  });
  responses.policy = policyResult;

  const homepage = await fetchText(buildUrl(options.storefrontUrl, "/"), {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    accept: "text/html, */*;q=0.8",
  });
  requireStatus(homepage, "Storefront homepage for structured data", (status) =>
    status >= 200 && status < 300);
  checks.homepageStructuredData = evaluateHomepageJsonLdHtml(homepage.body, {
    storefrontOrigin,
    policy,
  });
  if (!checks.homepageStructuredData.ok) {
    throw new Error(
      `Homepage JSON-LD failed: ${checks.homepageStructuredData.errors.join("; ")}`,
    );
  }
  responses.homepageStructuredData = {
    statusCode: homepage.statusCode,
    durationMs: homepage.durationMs,
    ...checks.homepageStructuredData,
  };

  const robots = await fetchText(buildUrl(options.storefrontUrl, "/robots.txt"), {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    accept: "text/plain, */*;q=0.8",
  });
  requireStatus(robots, "Storefront /robots.txt", (status) => status >= 200 && status < 300);
  const robotsCache = evaluateDiscoveryCacheHeaders(robots.headers, { label: "robots.txt" });
  if (!robotsCache.ok) throw new Error(`robots.txt cache headers failed: ${robotsCache.errors.join("; ")}`);
  const robotsShouldAdvertiseSitemap = policy.sitemap.enabled && policy.robots.advertiseSitemap;
  checks.robots = evaluateRobotsTxt(robots.body, {
    storefrontOrigin,
    expectedSitemapUrl: buildUrl(options.storefrontUrl, "/sitemap.xml"),
    requireSitemap: robotsShouldAdvertiseSitemap,
    allowSitemap: robotsShouldAdvertiseSitemap,
  });
  if (!checks.robots.ok) throw new Error(`robots.txt failed: ${checks.robots.errors.join("; ")}`);
  responses.robots = {
    statusCode: robots.statusCode,
    durationMs: robots.durationMs,
    cacheControl: robotsCache.cacheControl,
    sitemapUrls: checks.robots.sitemapUrls,
  };

  responses.sitemaps = {};
  const verifySitemapEndpoint = async (endpoint, { requireLoc }) => {
    const response = await fetchText(buildUrlWithSearch(options.storefrontUrl, endpoint), {
      fetchImpl,
      timeoutMs: options.timeoutMs,
      accept: "application/xml, text/xml, */*;q=0.8",
    });
    requireStatus(response, `Storefront ${endpoint}`, (status) => status >= 200 && status < 300);
    const cacheEvaluation = evaluateDiscoveryCacheHeaders(response.headers, { label: endpoint });
    if (!cacheEvaluation.ok) {
      throw new Error(`${endpoint} cache headers failed: ${cacheEvaluation.errors.join("; ")}`);
    }
    const evaluation = evaluateSitemapXml(response.body, {
      storefrontOrigin,
      forbidPriority: endpoint.startsWith("/sitemap-products.xml"),
      forbidChangefreq: endpoint.startsWith("/sitemap-products.xml"),
      requireLoc,
    });
    if (!evaluation.ok) {
      throw new Error(`${endpoint} failed: ${evaluation.errors.join("; ")}`);
    }
    if (endpoint.startsWith("/sitemap-products.xml")) {
      checks.productSitemapFirstUrl ??= evaluation.locs.find((loc) =>
        isSameOrigin(loc, storefrontOrigin)
      ) ?? null;
    }
    responses.sitemaps[endpoint] = {
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      cacheControl: cacheEvaluation.cacheControl,
      locCount: evaluation.locCount,
    };
    return evaluation;
  };

  const enabledSitemapSectionCount = countEnabledSitemapSections(policy);
  if (policy.sitemap.enabled) {
    const sitemapIndexEvaluation = await verifySitemapEndpoint("/sitemap.xml", {
      requireLoc: enabledSitemapSectionCount > 0,
    });
    const sitemapIndexPolicy = evaluateSitemapIndexPolicy(sitemapIndexEvaluation.locs, {
      policy,
      storefrontOrigin,
    });
    if (!sitemapIndexPolicy.ok) {
      throw new Error(`sitemap index failed: ${sitemapIndexPolicy.errors.join("; ")}`);
    }
  } else {
    responses.sitemaps["/sitemap.xml"] = {
      status: "skipped",
      reason: "Global sitemap disabled by public SEO policy.",
    };
  }

  for (const { endpoint, policyKey, label } of SITEMAP_SECTION_ENDPOINTS) {
    if (!policy.sitemap.enabled) {
      responses.sitemaps[endpoint] = {
        status: "skipped",
        reason: "Global sitemap disabled by public SEO policy.",
      };
      continue;
    }
    if (!policy.sitemap[policyKey]) {
      responses.sitemaps[endpoint] = {
        status: "skipped",
        reason: `${label} disabled by public SEO policy.`,
      };
      continue;
    }

    await verifySitemapEndpoint(endpoint, {
      requireLoc: policyKey === "staticPages",
    });
  }

  responses.feeds = {};
  if (!policy.feeds.productCatalogEnabled) {
    for (const { endpoint, resultKey, page2Endpoint } of FEED_ENDPOINTS) {
      const skipped = {
        status: "skipped",
        reason: "Product catalog feed disabled by public SEO policy.",
      };
      responses[resultKey] = skipped;
      responses.feeds[endpoint] = skipped;
      if (page2Endpoint) responses.feeds[page2Endpoint] = skipped;
    }
  } else {
    for (const {
      endpoint,
      resultKey,
      label,
      page2Endpoint,
      availabilityValues,
    } of FEED_ENDPOINTS) {
      const responseLabel = `Storefront ${label} (${endpoint})`;
      const response = await fetchText(buildUrlWithSearch(options.storefrontUrl, endpoint), {
        fetchImpl,
        timeoutMs: options.timeoutMs,
        accept: "application/xml, text/xml, */*;q=0.8",
      });
      requireStatus(response, responseLabel, (status) => status >= 200 && status < 300);
      const cacheEvaluation = evaluateDiscoveryCacheHeaders(response.headers, { label: endpoint });
      if (!cacheEvaluation.ok) {
        throw new Error(`${endpoint} cache headers failed: ${cacheEvaluation.errors.join("; ")}`);
      }
      const evaluation = evaluateProductFeedXml(response.body, {
        availabilityValues,
        storefrontOrigin,
      });
      if (!evaluation.ok) {
        throw new Error(`${endpoint} failed: ${evaluation.errors.join("; ")}`);
      }
      const feedResult = {
        statusCode: response.statusCode,
        durationMs: response.durationMs,
        cacheControl: cacheEvaluation.cacheControl,
        itemCount: evaluation.itemCount,
        linkCount: evaluation.linkCount,
        imageLinkCount: evaluation.imageLinkCount,
        availabilityCount: evaluation.availabilityCount,
        firstStorefrontItemUrl: evaluation.firstStorefrontItemUrl,
      };
      checks[resultKey] = evaluation;
      responses[resultKey] = feedResult;
      responses.feeds[endpoint] = feedResult;

      if (page2Endpoint) {
        const page2Response = await fetchText(
          buildUrlWithSearch(options.storefrontUrl, page2Endpoint),
          {
            fetchImpl,
            timeoutMs: options.timeoutMs,
            accept: "application/xml, text/xml, */*;q=0.8",
          },
        );
        requireStatus(
          page2Response,
          `Storefront ${label} page 2 (${page2Endpoint})`,
          (status) => (status >= 200 && status < 300) || status === 404,
        );
        if (page2Response.statusCode >= 200 && page2Response.statusCode < 300) {
          const page2CacheEvaluation = evaluateDiscoveryCacheHeaders(
            page2Response.headers,
            { label: page2Endpoint },
          );
          if (!page2CacheEvaluation.ok) {
            throw new Error(
              `${page2Endpoint} cache headers failed: ${page2CacheEvaluation.errors.join("; ")}`,
            );
          }
          const page2Evaluation = evaluateProductFeedXml(page2Response.body, {
            availabilityValues,
            storefrontOrigin,
          });
          if (!page2Evaluation.ok) {
            throw new Error(`${page2Endpoint} failed: ${page2Evaluation.errors.join("; ")}`);
          }
          responses.feeds[page2Endpoint] = {
            statusCode: page2Response.statusCode,
            durationMs: page2Response.durationMs,
            cacheControl: page2CacheEvaluation.cacheControl,
            itemCount: page2Evaluation.itemCount,
            linkCount: page2Evaluation.linkCount,
            imageLinkCount: page2Evaluation.imageLinkCount,
            availabilityCount: page2Evaluation.availabilityCount,
            firstStorefrontItemUrl: page2Evaluation.firstStorefrontItemUrl,
          };
        } else {
          responses.feeds[page2Endpoint] = {
            statusCode: page2Response.statusCode,
            durationMs: page2Response.durationMs,
            cacheControl: page2Response.headers.get("Cache-Control") ?? "",
            itemCount: 0,
            linkCount: 0,
            imageLinkCount: 0,
            availabilityCount: 0,
            firstStorefrontItemUrl: null,
          };
        }
      }
    }
  }

  const checkedSitemapCount = Object.values(responses.sitemaps)
    .filter((result) => result.status !== "skipped").length;
  const skippedSitemapCount = Object.values(responses.sitemaps)
    .filter((result) => result.status === "skipped").length;
  const feedSummary = policy.feeds.productCatalogEnabled
    ? `canonical feed (${checks.feed.itemCount} items), compatibility feed (${checks.compatibilityFeed.itemCount} items)`
    : "catalog feeds skipped by policy";
  logger?.log(
    `PASS discovery: robots, ${checkedSitemapCount} sitemap checks` +
    `${skippedSitemapCount ? ` (${skippedSitemapCount} skipped by policy)` : ""}, ` +
    `${feedSummary}.`,
  );

  return {
    ...responses,
    firstStorefrontItemUrl:
      checks.feed?.firstStorefrontItemUrl ??
      checks.productSitemapFirstUrl ??
      null,
  };
}

async function checkDiscoveredProductRoute(
  options,
  { fetchImpl, productUrl, logger, requireProductJsonLd = true },
) {
  if (!productUrl) {
    logger?.warn("WARN product route: skipped because discovery did not expose a storefront product URL.");
    return {
      status: "skipped",
      reason: "No storefront product URL discovered from the catalog feed or product sitemap.",
    };
  }

  const storefrontOrigin = new URL(options.storefrontUrl).origin;
  if (!isSameOrigin(productUrl, storefrontOrigin)) {
    throw new Error(`Discovered product URL is not on storefront origin: ${productUrl}`);
  }

  const response = await fetchText(productUrl, {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    accept: "text/html, */*;q=0.8",
  });
  requireStatus(response, "Discovered storefront product route", (status) => status >= 200 && status < 300);
  if (!requireProductJsonLd) {
    logger?.log("PASS product route: returned 2xx; Product JSON-LD skipped by public SEO policy.");
    return {
      url: productUrl,
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      schema: {
        status: "skipped",
        reason: "Product JSON-LD disabled by public SEO policy.",
      },
    };
  }

  const schemaEvaluation = evaluateProductJsonLdHtml(response.body, {
    storefrontOrigin,
  });
  if (!schemaEvaluation.ok) {
    throw new Error(
      `Discovered product JSON-LD failed: ${schemaEvaluation.errors.join("; ")}`,
    );
  }
  logger?.log(
    `PASS product route: ${new URL(productUrl).pathname} returned ${response.statusCode} with ` +
    `${schemaEvaluation.productSchemaCount} product schema and ${schemaEvaluation.offerCount} offers.`,
  );

  return {
    url: redactUrl(productUrl),
    statusCode: response.statusCode,
    durationMs: response.durationMs,
    schema: schemaEvaluation,
  };
}

async function checkUcpDiscovery(options, { fetchImpl, productUrl, logger }) {
  const storefront = new URL(options.storefrontUrl);
  const storefrontOrigin = storefront.origin;
  if (storefront.protocol !== "https:") {
    throw new Error("UCP discovery requires the configured Storefront URL to use HTTPS.");
  }

  const profileUrl = buildUrl(options.storefrontUrl, "/.well-known/ucp");
  const profileResponse = await fetchJson(profileUrl, {
    fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  requireStatus(profileResponse, "Storefront /.well-known/ucp", (status) => status >= 200 && status < 300);
  const profileCache = evaluateDiscoveryCacheHeaders(profileResponse.headers, {
    label: "UCP profile",
  });
  if (!profileCache.ok) {
    throw new Error(`UCP profile cache headers failed: ${profileCache.errors.join("; ")}`);
  }
  const profilePayload = requireJsonResponse(profileResponse, "Storefront /.well-known/ucp");
  const profileEvaluation = evaluateUcpProfile(profilePayload, { storefrontOrigin });
  if (!profileEvaluation.ok) {
    throw new Error(`UCP profile failed: ${profileEvaluation.errors.join("; ")}`);
  }

  const result = {
    profile: {
      url: redactUrl(profileUrl),
      statusCode: profileResponse.statusCode,
      durationMs: profileResponse.durationMs,
      cacheControl: profileCache.cacheControl,
      version: profileEvaluation.version,
      endpoint: profileEvaluation.endpoint,
      capabilities: profileEvaluation.capabilities,
    },
  };

  const searchQuery = productSearchQueryFromUrl(productUrl, storefrontOrigin);
  if (!searchQuery) {
    logger?.warn("WARN UCP catalog: search/lookup skipped because discovery did not expose a safe product candidate.");
    result.catalog = {
      status: "skipped",
      reason: "No safe product candidate from discovery for read-only UCP catalog search/lookup.",
    };
    logger?.log("PASS UCP discovery: HTTPS profile advertises catalog search/lookup only.");
    return result;
  }

  const serviceEndpoint = profileEvaluation.endpoint.replace(/\/+$/, "");
  const searchResponse = await fetchJson(`${serviceEndpoint}/catalog/search`, {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    method: "POST",
    headers: {
      "UCP-Agent": UCP_AGENT_HEADER,
    },
    body: {
      ...(profileEvaluation.version ? { ucp: { version: profileEvaluation.version } } : {}),
      query: searchQuery,
      pagination: { limit: 5 },
    },
  });
  requireStatus(searchResponse, "UCP catalog search", (status) => status >= 200 && status < 300);
  const searchPayload = requireJsonResponse(searchResponse, "UCP catalog search");
  const searchedProducts = Array.isArray(searchPayload?.products) ? searchPayload.products.length : 0;
  const searchCandidate = firstUcpSearchCandidate(searchPayload);
  const candidate = searchCandidate ?? {
    id: productUrl,
    productId: null,
    variantId: null,
  };

  result.catalog = {
    search: {
      url: redactUrl(`${serviceEndpoint}/catalog/search`),
      statusCode: searchResponse.statusCode,
      durationMs: searchResponse.durationMs,
      query: searchQuery,
      productCount: searchedProducts,
      ...(searchCandidate ? {} : { fallbackInputId: redactUrl(productUrl) }),
    },
  };

  const lookupResponse = await fetchJson(`${serviceEndpoint}/catalog/lookup`, {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    method: "POST",
    headers: {
      "UCP-Agent": UCP_AGENT_HEADER,
    },
    body: {
      ...(profileEvaluation.version ? { ucp: { version: profileEvaluation.version } } : {}),
      ids: [candidate.id],
    },
  });
  requireStatus(lookupResponse, "UCP catalog lookup", (status) => status >= 200 && status < 300);
  const lookupPayload = requireJsonResponse(lookupResponse, "UCP catalog lookup");
  if (!lookupPayloadHasInputCorrelation(lookupPayload, candidate.id)) {
    throw new Error(`UCP catalog lookup did not correlate requested id: ${candidate.id}`);
  }
  result.catalog.lookup = {
    url: redactUrl(`${serviceEndpoint}/catalog/lookup`),
    statusCode: lookupResponse.statusCode,
    durationMs: lookupResponse.durationMs,
    inputId: candidate.id,
    productCount: Array.isArray(lookupPayload?.products) ? lookupPayload.products.length : 0,
  };

  const productResponse = await fetchJson(`${serviceEndpoint}/catalog/product`, {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    method: "POST",
    headers: {
      "UCP-Agent": UCP_AGENT_HEADER,
    },
    body: {
      ...(profileEvaluation.version ? { ucp: { version: profileEvaluation.version } } : {}),
      id: candidate.id,
    },
  });
  requireStatus(productResponse, "UCP catalog product", (status) => status >= 200 && status < 300);
  const productPayload = requireJsonResponse(productResponse, "UCP catalog product");
  const productEvaluation = evaluateUcpProductPayload(productPayload, {
    expectedFirstVariantId: candidate.variantId,
  });
  if (!productEvaluation.ok) {
    throw new Error(`UCP catalog product failed: ${productEvaluation.errors.join("; ")}`);
  }
  result.catalog.product = {
    url: redactUrl(`${serviceEndpoint}/catalog/product`),
    statusCode: productResponse.statusCode,
    durationMs: productResponse.durationMs,
    inputId: candidate.id,
    productId: productEvaluation.productId,
    firstVariantId: productEvaluation.firstVariantId,
    variantCount: productEvaluation.variantCount,
  };

  logger?.log(
    `PASS UCP discovery: HTTPS profile plus catalog search/lookup/product for ${candidate.id}.`,
  );
  return result;
}

export async function runReleaseCheck(options, {
  apiConfig = {},
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  sleepImpl = async () => undefined,
  logger = console,
  pnpmExecutable = resolvePnpmExecutable(),
  rootDir = defaultRootDir,
  readFileImpl = readFileSync,
  fileExistsImpl = existsSync,
  opsMonitorConfig,
  env = {},
} = {}) {
  const result = {
    status: "running",
    apiBaseUrl: redactUrl(options.apiBaseUrl),
    storefrontUrl: redactUrl(options.storefrontUrl),
    dashboardUrl: redactUrl(options.dashboardUrl),
    agentUrl: redactUrl(options.agentUrl),
    checks: {},
    warnings: [],
    requiredActions: [],
  };

  logger?.log("Release readiness check");
  await runStep(result, "tracker", () =>
    checkTracker({ rootDir, readFileImpl, logger }));
  await runStep(result, "docs", () =>
    checkRequiredDocs({ rootDir, fileExistsImpl, logger }));

  if (options.skipLive) {
    result.checks.live = {
      status: "skipped",
      reason: "Skipped by --skip-live.",
    };
    result.status = "passed";
    logger?.warn("WARN live checks skipped (--skip-live).");
    logger?.log("Release readiness check passed.");
    return result;
  }

  const apiOps = await runStep(result, "apiOps", () =>
    checkApiOps(options, {
      apiConfig,
      fetchImpl,
      execFileImpl,
      sleepImpl,
      pnpmExecutable,
      rootDir,
      logger,
      opsMonitorConfig,
    }));
  appendUnique(result.warnings, apiOps.warnings ?? []);
  appendUnique(result.requiredActions, apiOps.requiredActions ?? []);
  for (const warning of apiOps.warnings ?? []) {
    logger?.warn(`WARN API ops: ${warning}`);
  }
  for (const action of apiOps.requiredActions ?? []) {
    logger?.warn(`ACTION API ops: ${action}`);
  }
  await runStep(result, "adminInvalidCookieAuth", () =>
    checkInvalidAdminCookieAuth(options, { fetchImpl, logger }));
  await runStep(result, "adminMcpAuth", () =>
    checkAdminMcpAuth(options, { fetchImpl, logger }));
  await runStep(result, "adminMcpAuthenticated", () =>
    checkAdminMcpAuthenticated(options, { fetchImpl, logger, env }));
  await runStep(result, "dashboard", () =>
    checkDashboard(options, { fetchImpl, logger }));
  await runStep(result, "storefront", () =>
    checkStorefrontPages(options, { fetchImpl, logger }));
  await runStep(result, "storefrontCacheHeaders", () =>
    checkStorefrontCacheHeaders(options, { fetchImpl, logger }));
  await runStep(result, "storefrontChat", () =>
    checkStorefrontChat(options, { fetchImpl, logger }));
  await runStep(result, "agentMcp", () =>
    checkAgentMcp(options, { fetchImpl, logger }));
  const discovery = await runStep(result, "discovery", () =>
    checkDiscovery(options, { fetchImpl, logger }));
  await runStep(result, "ucpDiscovery", () =>
    checkUcpDiscovery(options, {
      fetchImpl,
      productUrl: discovery.firstStorefrontItemUrl,
      logger,
    }));
  await runStep(result, "productRoute", () =>
    checkDiscoveredProductRoute(options, {
      fetchImpl,
      productUrl: discovery.firstStorefrontItemUrl,
      logger,
      requireProductJsonLd:
        discovery.policy?.structuredData?.products !== false,
    }));

  result.status = "passed";
  logger?.log("Release readiness check passed.");
  return result;
}

function printUsage() {
  console.log(`Usage: pnpm release:check [options]

Read-only production release smoke checks. This complements pnpm ops:check with
storefront, dashboard, discovery XML/feed, UCP catalog discovery, tracker, and doc gates.

Options:
  --api-base-url <url>     API base URL (default ${DEFAULT_API_BASE_URL})
  --storefront-url <url>   Storefront URL (default ${DEFAULT_STOREFRONT_URL})
  --dashboard-url <url>    Dashboard URL (default ${DEFAULT_DASHBOARD_URL})
  --agent-url <url>        Agent Worker URL (default ${DEFAULT_AGENT_URL})
  --timeout-ms <ms>        Per-request/per-command timeout (default ${DEFAULT_TIMEOUT_MS})
  --skip-live              Run only local tracker/doc gates
  --skip-wrangler          Skip read-only Wrangler deployment proof and agent Worker smoke
  --allow-strict-seo-policy-fallback
                           Continue with strict discovery defaults if public SEO policy cannot be read
  --json                   Emit JSON
  -h, --help               Show this help

Environment:
  ${RELEASE_ADMIN_EMAIL_ENV} / ${RELEASE_ADMIN_PASSWORD_ENV}
                           Optional Better Auth admin credentials for authenticated Admin MCP smoke
`);
}

export async function main(rawArgs = process.argv.slice(2), {
  configPath = defaultApiConfigPath,
  stdout = console.log,
  stderr = console.error,
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  sleepImpl = async () => undefined,
  pnpmExecutable = resolvePnpmExecutable(),
  rootDir = defaultRootDir,
  readFileImpl = readFileSync,
  fileExistsImpl = existsSync,
  env = process.env,
} = {}) {
  const wantsJson = rawArgs.includes("--json");
  let options;

  try {
    const rawOptions = parseRawOptions(rawArgs);
    if (rawOptions.help) {
      printUsage();
      return 0;
    }

    const apiConfig = readApiWranglerConfig(configPath);
    options = parseReleaseCheckArgs(rawArgs, {
      defaultApiBaseUrl: apiConfig.vars?.PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL,
      defaultStorefrontUrl: apiConfig.vars?.STOREFRONT_URL ?? DEFAULT_STOREFRONT_URL,
      defaultDashboardUrl: DEFAULT_DASHBOARD_URL,
      defaultAgentUrl: env.SCALIUS_STOREFRONT_AGENT_URL ?? DEFAULT_AGENT_URL,
    });

    const result = await runReleaseCheck(options, {
      apiConfig,
      fetchImpl,
      execFileImpl,
      sleepImpl,
      pnpmExecutable,
      rootDir,
      readFileImpl,
      fileExistsImpl,
      env,
      logger: options.json ? null : console,
    });

    if (options.json) stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const message = errorMessage(error);
    const result = error?.result
      ? { ...error.result, status: "failed", error: message }
      : { status: "failed", error: message };

    if (wantsJson || options?.json) {
      stdout(JSON.stringify(result, null, 2));
    } else {
      stderr(`FAIL ${message}`);
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
