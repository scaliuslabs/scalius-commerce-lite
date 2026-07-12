#!/usr/bin/env node

import { execFile as execFileCallback } from "child_process";
import { existsSync } from "fs";
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
const DEFAULT_TIMEOUT_MS = 10_000;
const RELEASE_READYZ_SAMPLES = 4;
const MAX_BODY_PREVIEW_LENGTH = 180;
const ADMIN_BUSINESS_SETTINGS_PATH = "/api/v1/admin/settings/business";
const INVALID_ADMIN_SESSION_COOKIE = "better-auth.session_token=release-check-invalid";
const ADMIN_API_READ_TIMEOUT_CODE = "ADMIN_API_READ_TIMEOUT";

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
]);
const knownOptions = new Set([...booleanOptions, ...stringOptions]);

const requiredDocs = [
  "audit/README.md",
  "audit/OPERATIONAL_RUNBOOK.md",
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

export function requestHeaders(accept, { bypassCache = true } = {}) {
  return {
    Accept: accept,
    ...(bypassCache ? { "Cache-Control": "no-cache" } : {}),
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
  bypassCache = true,
}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: requestHeaders(accept, { bypassCache }),
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

export function shouldRetryFeedGeneration(result) {
  return result?.ok === false &&
    /\bBYPASS_GENERATION\b/i.test(result.cacheStatus ?? "");
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

function extractDirectChildTagValues(xml, parentTagName, childTagNames) {
  const escapedParent = parentTagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parentStart = new RegExp(`<${escapedParent}\\b[^>]*>`, "i").exec(xml);
  if (!parentStart) return [];

  const targetNames = new Set(childTagNames.map((name) => name.toLowerCase()));
  const tokenPattern =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?([A-Za-z_][\w:.-]*)\b[^>]*>/g;
  tokenPattern.lastIndex = parentStart.index + parentStart[0].length;
  const stack = [
    {
      name: parentTagName.toLowerCase(),
      contentStart: tokenPattern.lastIndex,
      capture: false,
    },
  ];
  const values = [];
  let match;

  while ((match = tokenPattern.exec(xml)) !== null) {
    const rawName = match[1];
    if (!rawName) continue;

    const token = match[0];
    const name = rawName.toLowerCase();
    if (token.startsWith("</")) {
      const opening = stack.pop();
      if (!opening || opening.name !== name) return values;
      if (opening.capture) {
        values.push(decodeXml(xml.slice(opening.contentStart, match.index).trim()));
      }
      if (stack.length === 0) break;
      continue;
    }

    const capture = stack.length === 1 && targetNames.has(name);
    if (/\/\s*>$/.test(token)) {
      if (capture) values.push("");
      continue;
    }
    stack.push({
      name,
      contentStart: match.index + token.length,
      capture,
    });
  }

  return values;
}

function parseFeedMoney(value) {
  const match = String(value ?? "").trim().match(/^(\d+(?:\.\d{1,2})?)\s+([A-Z]{3})$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: match[2] };
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
  const priceMarkers = [];
  const salePriceMarkers = [];
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
    const itemPrices = extractDirectChildTagValues(
      item,
      "item",
      ["price", "g:price"],
    ).filter(Boolean);
    const itemSalePrices = extractDirectChildTagValues(
      item,
      "item",
      ["sale_price", "g:sale_price"],
    ).filter(Boolean);

    links.push(...itemLinks);
    imageLinks.push(...itemImageLinks);
    availabilityMarkers.push(...itemAvailability);
    priceMarkers.push(...itemPrices);
    salePriceMarkers.push(...itemSalePrices);

    if (itemLinks.length === 0) {
      errors.push(`feed item ${itemNumber} must include a product link.`);
    }
    if (itemImageLinks.length === 0) {
      errors.push(`feed item ${itemNumber} must include an image_link.`);
    }
    if (itemAvailability.length === 0) {
      errors.push(`feed item ${itemNumber} must include availability.`);
    }
    if (itemPrices.length !== 1) {
      errors.push(`feed item ${itemNumber} must include exactly one price.`);
    }
    if (itemSalePrices.length > 1) {
      errors.push(`feed item ${itemNumber} must include at most one sale_price.`);
    }

    const parsedPrice = itemPrices.length === 1 ? parseFeedMoney(itemPrices[0]) : null;
    if (itemPrices.length === 1 && !parsedPrice) {
      errors.push(`feed item ${itemNumber} price must be a positive amount plus ISO currency.`);
    }
    const parsedSalePrice = itemSalePrices.length === 1
      ? parseFeedMoney(itemSalePrices[0])
      : null;
    if (itemSalePrices.length === 1 && !parsedSalePrice) {
      errors.push(`feed item ${itemNumber} sale_price must be a positive amount plus ISO currency.`);
    }
    if (parsedPrice && parsedSalePrice) {
      if (parsedPrice.currency !== parsedSalePrice.currency) {
        errors.push(`feed item ${itemNumber} sale_price currency must match price currency.`);
      } else if (parsedSalePrice.amount >= parsedPrice.amount) {
        errors.push(`feed item ${itemNumber} sale_price must be lower than price.`);
      }
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
    priceCount: priceMarkers.length,
    salePriceCount: salePriceMarkers.length,
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

  const productFeedUrl = buildUrlWithSearch(
    options.storefrontUrl,
    "/api/product-feed.xml?limit=5",
  );
  let productFeedResponse;
  let productFeed;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    productFeedResponse = await fetchText(productFeedUrl, {
      fetchImpl,
      timeoutMs: options.timeoutMs,
      accept: "application/xml, text/xml, */*;q=0.8",
      // This assertion measures the normal generated-cache contract. Sending
      // no-cache deliberately produces BYPASS_GENERATION on a cold edge.
      bypassCache: false,
    });
    requireStatus(productFeedResponse, "Storefront /api/product-feed.xml cache headers", (status) =>
      status >= 200 && status < 300);
    productFeed = evaluateFeedGenerationCacheHeaders(productFeedResponse.headers);
    if (!shouldRetryFeedGeneration(productFeed)) {
      break;
    }
  }
  if (!productFeed.ok) {
    throw new Error(
      `Storefront /api/product-feed.xml cache headers failed: ${productFeed.errors.join("; ")} ` +
      `(X-Cache-Status=${JSON.stringify(productFeed.cacheStatus)}, ` +
      `generation=${JSON.stringify(productFeed.generationHeader)})`,
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
  fileExistsImpl = existsSync,
  opsMonitorConfig,
} = {}) {
  const result = {
    status: "running",
    apiBaseUrl: redactUrl(options.apiBaseUrl),
    storefrontUrl: redactUrl(options.storefrontUrl),
    dashboardUrl: redactUrl(options.dashboardUrl),
    checks: {},
    warnings: [],
    requiredActions: [],
  };

  logger?.log("Release readiness check");
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
  await runStep(result, "dashboard", () =>
    checkDashboard(options, { fetchImpl, logger }));
  await runStep(result, "storefront", () =>
    checkStorefrontPages(options, { fetchImpl, logger }));
  await runStep(result, "storefrontCacheHeaders", () =>
    checkStorefrontCacheHeaders(options, { fetchImpl, logger }));
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
storefront, dashboard, discovery XML/feed, UCP catalog discovery, and doc gates.

Options:
  --api-base-url <url>     API base URL (default ${DEFAULT_API_BASE_URL})
  --storefront-url <url>   Storefront URL (default ${DEFAULT_STOREFRONT_URL})
  --dashboard-url <url>    Dashboard URL (default ${DEFAULT_DASHBOARD_URL})
  --timeout-ms <ms>        Per-request/per-command timeout (default ${DEFAULT_TIMEOUT_MS})
  --skip-live              Run only the local doc gate
  --skip-wrangler          Skip read-only Wrangler deployment proof
  --allow-strict-seo-policy-fallback
                           Continue with strict discovery defaults if public SEO policy cannot be read
  --json                   Emit JSON
  -h, --help               Show this help

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
  fileExistsImpl = existsSync,
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
    });

    const result = await runReleaseCheck(options, {
      apiConfig,
      fetchImpl,
      execFileImpl,
      sleepImpl,
      pnpmExecutable,
      rootDir,
      fileExistsImpl,
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
