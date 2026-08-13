import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "./seo-discovery";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const MAX_STOREFRONT_ORIGIN_LENGTH = 2_048;

export const UCP_PROFILE_PATH = "/.well-known/ucp";
const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";
const UCP_REQUIRED_CATALOG_CAPABILITIES = [
  "dev.ucp.shopping.catalog.search",
  "dev.ucp.shopping.catalog.lookup",
] as const;
const UCP_FORBIDDEN_CAPABILITY_SEGMENTS = new Set([
  "cart",
  "carts",
  "checkout",
  "order",
  "orders",
  "payment",
  "payments",
  "payment_handlers",
]);

export const SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS = [
  ["robots", "robots.txt", "/robots.txt", "robots"] as const,
  ["sitemap", "Sitemap index", "/sitemap.xml", "sitemap"] as const,
  [
    "productFeed",
    "Product feed",
    "/api/product-feed.xml?limit=5",
    "feed",
  ] as const,
  [
    "facebookFeed",
    "Facebook feed",
    "/api/facebook-feed.xml?limit=5",
    "feed",
  ] as const,
  ["ucpProfile", "UCP catalog profile", UCP_PROFILE_PATH, "ucpProfile"] as const,
];

export const SEO_DISCOVERY_SITEMAP_CHILD_PROBE_ENDPOINTS = [
  [
    "staticPagesSitemap",
    "Home + search sitemap",
    "/sitemap-static.xml",
    "staticPages",
  ] as const,
  [
    "productsSitemap",
    "Products sitemap",
    "/sitemap-products.xml?page=1",
    "products",
  ] as const,
  [
    "categoriesSitemap",
    "Categories sitemap",
    "/sitemap-categories.xml",
    "categories",
  ] as const,
  [
    "collectionsSitemap",
    "Collections sitemap",
    "/sitemap-collections.xml",
    "collections",
  ] as const,
  ["pagesSitemap", "Pages sitemap", "/sitemap-pages.xml", "pages"] as const,
  [
    "articlesSitemap",
    "Articles sitemap",
    "/sitemap-articles.xml",
    "articles",
  ] as const,
];

export type SeoDiscoveryLiveProbeKey =
  | (typeof SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS)[number][0]
  | (typeof SEO_DISCOVERY_SITEMAP_CHILD_PROBE_ENDPOINTS)[number][0];
export type SeoDiscoveryLiveProbeKind =
  | (typeof SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS)[number][3]
  | "sitemapChild";

export interface SeoDiscoveryLiveProbeCounts {
  robotsSitemapLines?: number;
  sitemapLocs?: number;
  feedItems?: number;
  feedLinks?: number;
  absoluteFeedLinks?: number;
  imageLinks?: number;
  absoluteImageLinks?: number;
  availabilityValues?: number;
  ucpValidJson?: number;
  ucpVersion?: string;
  ucpShoppingRestServices?: number;
  ucpCatalogCapabilities?: number;
  ucpForbiddenCapabilities?: number;
  ucpPaymentHandlers?: number;
}

export interface SeoDiscoveryLiveProbeResource {
  key: SeoDiscoveryLiveProbeKey;
  kind: SeoDiscoveryLiveProbeKind;
  label: string;
  path: string;
  href: string | null;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  cacheControl: string | null;
  counts: SeoDiscoveryLiveProbeCounts;
  bodyTruncated?: boolean;
  disabledReason?: string;
  error?: string;
  expectedRobotsSitemapLines?: number;
  minimumSitemapLocs?: number;
}

export interface SeoDiscoveryLiveProbeResult {
  baseUrl: string | null;
  checkedAt: string;
  ok: boolean;
  error?: string;
  resources: SeoDiscoveryLiveProbeResource[];
}

export interface StorefrontUrlPayload {
  storefrontUrl: string;
}

export interface SeoDiscoveryPolicyPayload {
  discovery?: unknown;
}

export interface SeoDiscoveryLiveProbeDeps {
  fetch?: typeof fetch;
  getDiscoveryPolicy?: () => Promise<SeoDiscoveryPolicyPayload>;
  getStorefrontUrl?: () => Promise<StorefrontUrlPayload>;
  maxBodyBytes?: number;
  now?: () => Date;
  timeoutMs?: number;
}

interface ProbeTarget {
  key: SeoDiscoveryLiveProbeKey;
  kind: SeoDiscoveryLiveProbeKind;
  label: string;
  path: string;
  disabledReason?: string;
  expectedRobotsSitemapLines?: number;
  minimumSitemapLocs?: number;
}

interface BoundedTextRead {
  text: string;
  truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseSeoDiscoveryStorefrontUrl(
  value: string | null | undefined,
): URL | null {
  if (!value) return null;

  try {
    const trimmed = value.trim();
    if (trimmed.length > MAX_STOREFRONT_ORIGIN_LENGTH) return null;
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildSeoDiscoveryHref(baseUrl: URL, path: string): string {
  const normalizedBase = baseUrl.href.endsWith("/")
    ? baseUrl.href.slice(0, -1)
    : baseUrl.href;
  return `${normalizedBase}${path}`;
}

function countXmlStartTags(xml: string, tagName: string): number {
  const pattern = new RegExp(
    `<\\s*(?!/)(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b`,
    "gi",
  );
  return Array.from(xml.matchAll(pattern)).length;
}

function extractXmlElementTexts(xml: string, tagName: string): string[] {
  const pattern = new RegExp(
    `<\\s*(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\s*/\\s*(?:[A-Za-z_][\\w.-]*:)?${tagName}\\s*>`,
    "gi",
  );
  return Array.from(xml.matchAll(pattern)).map((match) => match[1] ?? "");
}

function normalizeXmlTextValue(value: string): string {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, "$1")
    .replace(/&(amp|quot|apos|lt|gt);/giu, (_match, entity: string) => {
      const decoded: Record<string, string> = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
      };
      return decoded[entity.toLowerCase()] ?? _match;
    })
    .trim();
}

function firstXmlElementValue(xml: string, tagName: string): string | null {
  const value = extractXmlElementTexts(xml, tagName)
    .map(normalizeXmlTextValue)
    .find((candidate) => candidate.length > 0);
  return value ?? null;
}

function isAbsoluteHttpUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isAbsoluteHttpsUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function countRobotsSitemapLines(robotsTxt: string): number {
  return robotsTxt
    .split(/\r?\n/)
    .filter((line) => /^sitemap\s*:/i.test(line.trim())).length;
}

function isForbiddenUcpCapability(capability: string): boolean {
  return capability
    .toLowerCase()
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => UCP_FORBIDDEN_CAPABILITY_SEGMENTS.has(segment));
}

function summarizeUcpProfileBody(body: string): SeoDiscoveryLiveProbeCounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ucpValidJson: 0 };
  }

  const root = asRecord(parsed);
  const ucp = asRecord(root.ucp);
  const services = asRecord(ucp.services);
  const shoppingRestServices = asArray(services[UCP_SHOPPING_SERVICE]).filter(
    (service) => {
      const serviceRecord = asRecord(service);
      return (
        serviceRecord.transport === "rest" &&
        isAbsoluteHttpsUrl(
          typeof serviceRecord.endpoint === "string"
            ? serviceRecord.endpoint
            : null,
        )
      );
    },
  );
  const capabilities = asRecord(ucp.capabilities);
  const capabilityNames = Object.keys(capabilities);
  const catalogCapabilities = UCP_REQUIRED_CATALOG_CAPABILITIES.filter(
    (capability) => asArray(capabilities[capability]).length > 0,
  );
  const forbiddenCapabilities = capabilityNames.filter(
    isForbiddenUcpCapability,
  );
  const paymentHandlers = Object.keys(asRecord(ucp.payment_handlers));
  const version = typeof ucp.version === "string" ? ucp.version.trim() : "";

  return {
    ucpValidJson: 1,
    ucpVersion: version || undefined,
    ucpShoppingRestServices: shoppingRestServices.length,
    ucpCatalogCapabilities: catalogCapabilities.length,
    ucpForbiddenCapabilities:
      forbiddenCapabilities.length + paymentHandlers.length,
    ucpPaymentHandlers: paymentHandlers.length,
  };
}

export function summarizeSeoDiscoveryProbeBody(
  key: SeoDiscoveryLiveProbeKey,
  body: string,
): SeoDiscoveryLiveProbeCounts {
  if (key === "robots") {
    return { robotsSitemapLines: countRobotsSitemapLines(body) };
  }
  if (key === "sitemap" || key.endsWith("Sitemap")) {
    return { sitemapLocs: countXmlStartTags(body, "loc") };
  }
  if (key === "ucpProfile") {
    return summarizeUcpProfileBody(body);
  }

  const itemBodies = extractXmlElementTexts(body, "item");
  const linkValues = itemBodies
    .map((item) => firstXmlElementValue(item, "link"))
    .filter((value): value is string => Boolean(value));
  const imageLinkValues = itemBodies
    .map((item) => firstXmlElementValue(item, "image_link"))
    .filter((value): value is string => Boolean(value));
  const availabilityValues = itemBodies
    .map((item) => firstXmlElementValue(item, "availability"))
    .filter((value): value is string => Boolean(value));

  return {
    feedItems: itemBodies.length,
    feedLinks: linkValues.length,
    absoluteFeedLinks: linkValues.filter(isAbsoluteHttpUrl).length,
    imageLinks: imageLinkValues.length,
    absoluteImageLinks: imageLinkValues.filter(isAbsoluteHttpUrl).length,
    availabilityValues: availabilityValues.length,
  };
}

function formatMissingFeedField(
  count: number,
  itemCount: number,
  label: string,
): string | null {
  return count < itemCount ? `${count}/${itemCount} ${label}` : null;
}

export function getSeoDiscoveryLiveProbeCountIssue(
  resource: Pick<SeoDiscoveryLiveProbeResource, "counts" | "kind"> & {
    bodyTruncated?: boolean;
  },
): string | undefined {
  if (resource.bodyTruncated) return undefined;

  if (resource.kind === "ucpProfile") {
    const issues: string[] = [];
    if (resource.counts.ucpValidJson !== 1) {
      return "UCP profile must be valid JSON.";
    }
    if (!resource.counts.ucpVersion) {
      issues.push("UCP profile is missing ucp.version.");
    }
    if ((resource.counts.ucpShoppingRestServices ?? 0) < 1) {
      issues.push(
        "UCP profile must expose a dev.ucp.shopping REST service with an HTTPS endpoint.",
      );
    }
    if (
      (resource.counts.ucpCatalogCapabilities ?? 0) <
      UCP_REQUIRED_CATALOG_CAPABILITIES.length
    ) {
      issues.push(
        "UCP profile must advertise catalog search and catalog lookup.",
      );
    }
    if ((resource.counts.ucpForbiddenCapabilities ?? 0) > 0) {
      issues.push(
        "UCP profile must stay catalog-only; remove cart, checkout, order, payment, or payment handler capabilities.",
      );
    }
    return issues.length > 0 ? issues.join(" ") : undefined;
  }

  if (resource.kind !== "feed") return undefined;

  const itemCount = resource.counts.feedItems ?? 0;
  if (itemCount <= 0) return undefined;

  const missingFields = [
    resource.counts.feedLinks === undefined
      ? null
      : formatMissingFeedField(resource.counts.feedLinks, itemCount, "link"),
    formatMissingFeedField(
      resource.counts.imageLinks ?? 0,
      itemCount,
      "image_link",
    ),
    formatMissingFeedField(
      resource.counts.availabilityValues ?? 0,
      itemCount,
      "availability",
    ),
  ].filter((value): value is string => Boolean(value));
  const issues: string[] = [];

  if (missingFields.length > 0) {
    issues.push(`Missing feed fields: ${missingFields.join(", ")}.`);
  }
  if (
    resource.counts.feedLinks !== undefined &&
    resource.counts.absoluteFeedLinks !== undefined &&
    resource.counts.absoluteFeedLinks < resource.counts.feedLinks
  ) {
    issues.push(
      `Feed links must be absolute http(s): ${resource.counts.absoluteFeedLinks}/${resource.counts.feedLinks}.`,
    );
  }
  if (
    resource.counts.imageLinks !== undefined &&
    resource.counts.absoluteImageLinks !== undefined &&
    resource.counts.absoluteImageLinks < resource.counts.imageLinks
  ) {
    issues.push(
      `Feed images must be absolute http(s): ${resource.counts.absoluteImageLinks}/${resource.counts.imageLinks}.`,
    );
  }
  return issues.length > 0 ? issues.join(" ") : undefined;
}

function probeAcceptHeader(kind: SeoDiscoveryLiveProbeKind): string {
  return kind === "ucpProfile"
    ? "application/json,application/ucp+json;q=0.9,*/*;q=0.1"
    : "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1";
}

function safeHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : null;
}

async function readBoundedResponseText(
  response: Response,
  maxBodyBytes: number,
): Promise<BoundedTextRead> {
  if (!response.body) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBodyBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(decoder.decode(value.slice(0, remaining), { stream: true }));
        bytesRead += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
      bytesRead += value.byteLength;
    }
  } finally {
    chunks.push(decoder.decode());
  }

  return { text: chunks.join(""), truncated };
}

function disabledProbeResource(
  target: ProbeTarget,
  baseUrl: URL,
): SeoDiscoveryLiveProbeResource {
  return {
    key: target.key,
    kind: target.kind,
    label: target.label,
    path: target.path,
    href: buildSeoDiscoveryHref(baseUrl, target.path),
    ok: true,
    status: null,
    contentType: null,
    cacheControl: null,
    counts: {},
    disabledReason: target.disabledReason,
    expectedRobotsSitemapLines: target.expectedRobotsSitemapLines,
    minimumSitemapLocs: target.minimumSitemapLocs,
  };
}

async function probeEndpoint({
  baseUrl,
  fetchImpl,
  maxBodyBytes,
  target,
  timeoutMs,
}: {
  baseUrl: URL;
  fetchImpl: typeof fetch;
  maxBodyBytes: number;
  target: ProbeTarget;
  timeoutMs: number;
}): Promise<SeoDiscoveryLiveProbeResource> {
  if (target.disabledReason) return disabledProbeResource(target, baseUrl);

  const href = buildSeoDiscoveryHref(baseUrl, target.path);
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: probeAcceptHeader(target.kind) },
    });
    const body = await readBoundedResponseText(response, maxBodyBytes);
    const counts = summarizeSeoDiscoveryProbeBody(target.key, body.text);
    const countIssue = body.truncated
      ? undefined
      : getSeoDiscoveryLiveProbeCountIssue({
          bodyTruncated: body.truncated,
          counts,
          kind: target.kind,
        });
    const error = response.status >= 300 && response.status < 400
      ? "Redirect blocked."
      : response.status < 200 || response.status >= 300
        ? `HTTP ${response.status}`
        : countIssue;

    return {
      key: target.key,
      kind: target.kind,
      label: target.label,
      path: target.path,
      href,
      ok: response.ok && !countIssue,
      status: response.status,
      contentType: safeHeaderValue(response.headers.get("content-type")),
      cacheControl: safeHeaderValue(response.headers.get("cache-control")),
      counts,
      bodyTruncated: body.truncated || undefined,
      error,
      expectedRobotsSitemapLines: target.expectedRobotsSitemapLines,
      minimumSitemapLocs: target.minimumSitemapLocs,
    };
  } catch {
    return {
      key: target.key,
      kind: target.kind,
      label: target.label,
      path: target.path,
      href,
      ok: false,
      status: null,
      contentType: null,
      cacheControl: null,
      counts: {},
      error: didTimeout
        ? `Timed out after ${Math.ceil(timeoutMs / 1000)}s.`
        : "Fetch failed.",
      expectedRobotsSitemapLines: target.expectedRobotsSitemapLines,
      minimumSitemapLocs: target.minimumSitemapLocs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function countEnabledSitemapSections(
  sitemap: SeoDiscoverySettings["sitemap"],
): number {
  return SEO_DISCOVERY_SITEMAP_CHILD_PROBE_ENDPOINTS.filter(
    ([, , , sectionKey]) => sitemap[sectionKey],
  ).length;
}

function buildProbeTargets(discoveryValue: unknown, baseUrl: URL): ProbeTarget[] {
  const discovery = normalizeSeoDiscoverySettings(discoveryValue);
  const targets: ProbeTarget[] = SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS.map(
    ([key, label, path, kind]) => {
      if (kind === "ucpProfile") {
        return {
          key,
          kind,
          label,
          path,
          disabledReason:
            baseUrl.protocol === "https:"
              ? undefined
              : "UCP public discovery requires an HTTPS Store URL, so this catalog profile check is skipped.",
        };
      }
      if (kind === "robots") {
        return {
          key,
          kind,
          label,
          path,
          expectedRobotsSitemapLines:
            discovery.sitemap.enabled && discovery.robots.advertiseSitemap ? 1 : 0,
        };
      }
      if (kind === "sitemap") {
        return {
          key,
          kind,
          label,
          path,
          minimumSitemapLocs: discovery.sitemap.enabled
            ? countEnabledSitemapSections(discovery.sitemap)
            : 0,
        };
      }
      return {
        key,
        kind,
        label,
        path,
        disabledReason: discovery.feeds.productCatalogEnabled
          ? undefined
          : "Catalog feeds are disabled by the current SEO discovery policy.",
      };
    },
  );

  for (const [key, label, path, sectionKey] of SEO_DISCOVERY_SITEMAP_CHILD_PROBE_ENDPOINTS) {
    const enabled = discovery.sitemap.enabled && discovery.sitemap[sectionKey];
    targets.push({
      key,
      kind: "sitemapChild",
      label,
      path,
      disabledReason: enabled
        ? undefined
        : "This sitemap section is disabled by the current SEO discovery policy.",
      minimumSitemapLocs: sectionKey === "staticPages" && enabled ? 1 : 0,
    });
  }
  return targets;
}

export async function runSeoDiscoveryLiveProbe(
  deps: SeoDiscoveryLiveProbeDeps = {},
): Promise<SeoDiscoveryLiveProbeResult> {
  const timeoutMs = Math.min(
    Math.max(Math.trunc(deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS), 1_000),
    12_000,
  );
  const maxBodyBytes = Math.max(
    1,
    Math.trunc(deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
  );
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  if (!deps.getStorefrontUrl) {
    return {
      baseUrl: null,
      checkedAt,
      ok: false,
      error: "Store URL lookup is not configured.",
      resources: [],
    };
  }

  const { storefrontUrl } = await deps.getStorefrontUrl();
  const baseUrl = parseSeoDiscoveryStorefrontUrl(storefrontUrl);
  if (!baseUrl) {
    return {
      baseUrl: null,
      checkedAt,
      ok: false,
      error: "Store URL must be an absolute http(s) URL.",
      resources: [],
    };
  }

  const policyPayload = deps.getDiscoveryPolicy
    ? await deps.getDiscoveryPolicy()
    : { discovery: undefined };
  const resources = await Promise.all(
    buildProbeTargets(policyPayload.discovery, baseUrl).map((target) =>
      probeEndpoint({
        baseUrl,
        fetchImpl: deps.fetch ?? fetch,
        maxBodyBytes,
        target,
        timeoutMs,
      }),
    ),
  );

  return {
    baseUrl: baseUrl.href,
    checkedAt,
    ok: resources.every((resource) => resource.ok),
    resources,
  };
}
