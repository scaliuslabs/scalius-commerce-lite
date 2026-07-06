#!/usr/bin/env node

import { execFile as execFileCallback } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";
import {
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
const SITEMAP_ENDPOINTS = [
  "/sitemap.xml",
  "/sitemap-static.xml",
  "/sitemap-products.xml?page=1",
  "/sitemap-categories.xml",
  "/sitemap-collections.xml",
  "/sitemap-pages.xml",
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

export function evaluateRobotsTxt(body, { storefrontOrigin }) {
  const sitemapUrls = [];
  const errors = [];

  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i);
    if (!match) continue;
    const value = decodeXml(match[1]);
    sitemapUrls.push(value);
    if (!isHttpUrl(value)) {
      errors.push(`robots sitemap URL is not absolute http(s): ${value}`);
    } else if (!isSameOrigin(value, storefrontOrigin)) {
      errors.push(`robots sitemap URL is not on storefront origin: ${value}`);
    }
  }

  if (sitemapUrls.length === 0) {
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
} = {}) {
  const locs = extractTagValues(body, "loc");
  const errors = [];

  if (locs.length === 0) {
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
  const links = itemBlocks.flatMap((item) => [
    ...extractTagValues(item, "link"),
    ...extractTagValues(item, "g:link"),
  ]).filter(Boolean);
  const imageLinks = itemBlocks.flatMap((item) => [
    ...extractTagValues(item, "image_link"),
    ...extractTagValues(item, "g:image_link"),
  ]).filter(Boolean);
  const availabilityMarkers = itemBlocks.flatMap((item) => [
    ...extractTagValues(item, "availability"),
    ...extractTagValues(item, "g:availability"),
  ]).filter(Boolean);
  const errors = [];

  if (!/<rss\b/i.test(body) || !/<channel\b/i.test(body)) {
    errors.push("Product feed must be RSS/XML with <rss> and <channel>.");
  }
  if (itemCount === 0) {
    errors.push("Product feed must include at least one <item>.");
  }
  if (availabilityMarkers.length === 0) {
    errors.push("Product feed must include availability markers.");
  }
  if (availabilityValues?.length) {
    const allowed = new Set(availabilityValues);
    for (const value of availabilityMarkers) {
      if (!allowed.has(value)) {
        errors.push(`feed availability value is not allowed: ${value}`);
      }
    }
  }
  for (const link of links) {
    if (!isHttpUrl(link)) {
      errors.push(`feed product link is not absolute http(s): ${link}`);
    } else if (storefrontOrigin && !isSameOrigin(link, storefrontOrigin)) {
      errors.push(`feed product link is not on storefront origin: ${link}`);
    }
  }
  for (const imageLink of imageLinks) {
    if (!isHttpUrl(imageLink)) {
      errors.push(`feed image link is not absolute http(s): ${imageLink}`);
    }
  }

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

  const robots = await fetchText(buildUrl(options.storefrontUrl, "/robots.txt"), {
    fetchImpl,
    timeoutMs: options.timeoutMs,
    accept: "text/plain, */*;q=0.8",
  });
  requireStatus(robots, "Storefront /robots.txt", (status) => status >= 200 && status < 300);
  const robotsCache = evaluateDiscoveryCacheHeaders(robots.headers, { label: "robots.txt" });
  if (!robotsCache.ok) throw new Error(`robots.txt cache headers failed: ${robotsCache.errors.join("; ")}`);
  checks.robots = evaluateRobotsTxt(robots.body, { storefrontOrigin });
  if (!checks.robots.ok) throw new Error(`robots.txt failed: ${checks.robots.errors.join("; ")}`);
  responses.robots = {
    statusCode: robots.statusCode,
    durationMs: robots.durationMs,
    cacheControl: robotsCache.cacheControl,
  };

  responses.sitemaps = {};
  for (const endpoint of SITEMAP_ENDPOINTS) {
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
    });
    if (!evaluation.ok) {
      throw new Error(`${endpoint} failed: ${evaluation.errors.join("; ")}`);
    }
    responses.sitemaps[endpoint] = {
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      cacheControl: cacheEvaluation.cacheControl,
      locCount: evaluation.locCount,
    };
  }

  responses.feeds = {};
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

  logger?.log(
    `PASS discovery: robots, ${SITEMAP_ENDPOINTS.length} sitemaps, ` +
    `canonical feed (${checks.feed.itemCount} items), ` +
    `compatibility feed (${checks.compatibilityFeed.itemCount} items).`,
  );

  return {
    ...responses,
    firstStorefrontItemUrl: checks.feed.firstStorefrontItemUrl,
  };
}

async function checkDiscoveredProductRoute(options, { fetchImpl, productUrl, logger }) {
  if (!productUrl) {
    logger?.warn("WARN product route: skipped because the feed did not expose a storefront item URL.");
    return {
      status: "skipped",
      reason: "No storefront item URL discovered from the feed.",
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
