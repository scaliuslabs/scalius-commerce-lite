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
const DEFAULT_DASHBOARD_URL = "https://dashboard.scalius.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const RELEASE_READYZ_SAMPLES = 4;
const MAX_BODY_PREVIEW_LENGTH = 180;
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
    products: true,
  }),
});

const closedTrackerStatuses = new Set(["verified", "won't fix", "won’t fix", "wont fix"]);
const booleanOptions = new Set(["help", "json", "skip-live", "skip-wrangler"]);
const stringOptions = new Set(["timeout-ms", "api-base-url", "storefront-url", "dashboard-url"]);
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
} = {}) {
  const rawOptions = parseRawOptions(rawArgs);
  if (rawOptions.help) return { help: true };

  return {
    help: false,
    json: rawOptions.json === true,
    skipLive: rawOptions["skip-live"] === true,
    skipWrangler: rawOptions["skip-wrangler"] === true,
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

function requestHeaders(accept) {
  return {
    Accept: accept,
    "Cache-Control": "no-cache",
  };
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
      products: readBoolean(structuredData, "products"),
    },
  };

  const complete =
    Object.values(parsed.sitemap).every((value) => typeof value === "boolean") &&
    typeof parsed.feeds.productCatalogEnabled === "boolean" &&
    typeof parsed.robots.advertiseSitemap === "boolean" &&
    typeof parsed.structuredData.products === "boolean";

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
  return `sitemap ${policy.sitemap.enabled ? `${enabledSections} sections enabled` : "disabled"}, ${feedStatus}, ${robotsStatus}, ${productSchemaStatus}`;
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

async function fetchSeoDiscoveryPolicy(options, { fetchImpl, logger }) {
  const url = buildApiV1Url(options.apiBaseUrl, "/seo");

  try {
    const response = await fetchText(url, {
      fetchImpl,
      timeoutMs: options.timeoutMs,
      accept: "application/json, */*;q=0.8",
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const reason = `Public SEO policy returned HTTP ${response.statusCode}; using strict discovery defaults.`;
      logger?.warn(`WARN SEO policy: ${reason}`);
      return {
        policy: STRICT_SEO_DISCOVERY_POLICY,
        result: strictSeoPolicyResult(url, reason, {
          statusCode: response.statusCode,
          durationMs: response.durationMs,
        }),
      };
    }

    let payload;
    try {
      payload = response.body ? JSON.parse(response.body) : null;
    } catch (error) {
      const reason = `Public SEO policy returned invalid JSON (${errorMessage(error)}); using strict discovery defaults.`;
      logger?.warn(`WARN SEO policy: ${reason}`);
      return {
        policy: STRICT_SEO_DISCOVERY_POLICY,
        result: strictSeoPolicyResult(url, reason, {
          statusCode: response.statusCode,
          durationMs: response.durationMs,
        }),
      };
    }

    const policy = parseSeoDiscoveryPolicyPayload(payload);
    if (!policy) {
      const reason = "Public SEO policy shape is unknown; using strict discovery defaults.";
      logger?.warn(`WARN SEO policy: ${reason}`);
      return {
        policy: STRICT_SEO_DISCOVERY_POLICY,
        result: strictSeoPolicyResult(url, reason, {
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
    const reason = `Public SEO policy could not be fetched (${errorMessage(error)}); using strict discovery defaults.`;
    logger?.warn(`WARN SEO policy: ${reason}`);
    return {
      policy: STRICT_SEO_DISCOVERY_POLICY,
      result: strictSeoPolicyResult(url, reason),
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
}) {
  const opsArgs = [
    "--api-base-url", options.apiBaseUrl,
    "--samples", String(RELEASE_READYZ_SAMPLES),
    "--timeout-ms", String(options.timeoutMs),
  ];
  if (options.skipWrangler) opsArgs.push("--skip-wrangler");

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
  });

  const deployment = result.checks.deployment;
  const deploymentSummary = deployment?.status === "skipped"
    ? "deployment skipped"
    : `deployment ${deployment?.versionId ?? "unknown"}`;
  logger?.log(
    `PASS API ops: health ${result.checks.health.statusCode}, ` +
    `readyz ${result.checks.readyz.readyCount}/${result.checks.readyz.sampleCount}, ` +
    `openapi ${result.checks.openapi.pathCount} paths, ${deploymentSummary}.`,
  );

  return {
    apiBaseUrl: redactUrl(options.apiBaseUrl),
    healthStatusCode: result.checks.health.statusCode,
    readyCount: result.checks.readyz.readyCount,
    readySampleCount: result.checks.readyz.sampleCount,
    openApiPathCount: result.checks.openapi.pathCount,
    deploymentStatus: deployment?.status ?? "passed",
    deploymentVersionId: deployment?.versionId ?? null,
    monitoringConfigStatus: result.checks.monitoringConfig.status,
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

async function checkDiscovery(options, { fetchImpl, logger }) {
  const storefrontOrigin = new URL(options.storefrontUrl).origin;
  const responses = {};
  const checks = {};
  const { policy, result: policyResult } = await fetchSeoDiscoveryPolicy(options, {
    fetchImpl,
    logger,
  });
  responses.policy = policyResult;

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
  };

  const enabledSitemapSectionCount = countEnabledSitemapSections(policy);
  if (policy.sitemap.enabled) {
    await verifySitemapEndpoint("/sitemap.xml", {
      requireLoc: enabledSitemapSectionCount > 0,
    });
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
} = {}) {
  const result = {
    status: "running",
    apiBaseUrl: redactUrl(options.apiBaseUrl),
    storefrontUrl: redactUrl(options.storefrontUrl),
    dashboardUrl: redactUrl(options.dashboardUrl),
    checks: {},
    warnings: [],
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

  await runStep(result, "apiOps", () =>
    checkApiOps(options, {
      apiConfig,
      fetchImpl,
      execFileImpl,
      sleepImpl,
      pnpmExecutable,
      rootDir,
      logger,
    }));
  await runStep(result, "dashboard", () =>
    checkDashboard(options, { fetchImpl, logger }));
  await runStep(result, "storefront", () =>
    checkStorefrontPages(options, { fetchImpl, logger }));
  const discovery = await runStep(result, "discovery", () =>
    checkDiscovery(options, { fetchImpl, logger }));
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
storefront, dashboard, discovery XML/feed, tracker, and doc gates.

Options:
  --api-base-url <url>     API base URL (default ${DEFAULT_API_BASE_URL})
  --storefront-url <url>   Storefront URL (default ${DEFAULT_STOREFRONT_URL})
  --dashboard-url <url>    Dashboard URL (default ${DEFAULT_DASHBOARD_URL})
  --timeout-ms <ms>        Per-request/per-command timeout (default ${DEFAULT_TIMEOUT_MS})
  --skip-live              Run only local tracker/doc gates
  --skip-wrangler          Skip read-only Wrangler deployment proof inside API ops
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
  readFileImpl = readFileSync,
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
      readFileImpl,
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
