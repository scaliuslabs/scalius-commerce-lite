import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import {
  DEFAULT_SEO_RETURN_POLICY_SETTINGS,
  normalizeSeoReturnPolicySettings,
  type SeoReturnPolicyCategory,
  type SeoReturnPolicyFees,
  type SeoReturnPolicyMethod,
  type SeoReturnPolicySettings,
} from "@scalius/shared/seo-return-policy";

export type {
  SeoReturnPolicyCategory,
  SeoReturnPolicyFees,
  SeoReturnPolicyMethod,
  SeoReturnPolicySettings,
};

export type SeoDiscoverySettingsWithReturnPolicy = SeoDiscoverySettings & {
  returnPolicy: SeoReturnPolicySettings;
};

export interface SeoDiscoveryBusinessIdentity {
  companyName?: string | null;
  legalName?: string | null;
}

const SITEMAP_SECTIONS = [
  ["staticPages", "Home + search"] as const,
  ["products", "Products"] as const,
  ["categories", "Categories"] as const,
  ["collections", "Collections"] as const,
  ["pages", "Pages"] as const,
];

const PREVIEW_ENDPOINTS = [
  ["robots", "robots.txt", "/robots.txt"] as const,
  ["sitemap", "Sitemap index", "/sitemap.xml"] as const,
  ["feed", "Catalog feed XML", "/api/product-feed.xml"] as const,
];

const UCP_PROFILE_PATH = "/.well-known/ucp";
const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";
const UCP_CATALOG_SEARCH_CAPABILITY = "dev.ucp.shopping.catalog.search";
const UCP_CATALOG_LOOKUP_CAPABILITY = "dev.ucp.shopping.catalog.lookup";
const UCP_REQUIRED_CATALOG_CAPABILITIES = [
  UCP_CATALOG_SEARCH_CAPABILITY,
  UCP_CATALOG_LOOKUP_CAPABILITY,
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

const RETURN_POLICY_CATEGORY_LABELS: Record<SeoReturnPolicyCategory, string> = {
  finite: "finite return window",
  unlimited: "unlimited returns",
  no_returns: "no returns",
};

const RETURN_POLICY_FEES_LABELS: Record<SeoReturnPolicyFees, string> = {
  free: "free returns",
  customer_responsibility: "buyer pays return fees",
};

const RETURN_POLICY_METHOD_LABELS: Record<SeoReturnPolicyMethod, string> = {
  mail: "return by mail",
  in_store: "return in store",
  both: "mail or in-store returns",
};

export type SeoDiscoveryTone = "ok" | "warning" | "disabled" | "info";
export type SeoStructuredDataPreviewKey =
  | "onlineStore"
  | "websiteSearch"
  | "merchantReturnPolicy"
  | "productPages"
  | "categoryCollectionPages";

export interface SeoStructuredDataPreviewRow {
  key: SeoStructuredDataPreviewKey;
  tone: SeoDiscoveryTone;
  title: string;
  summary: string;
}

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
  [
    "ucpProfile",
    "UCP catalog profile",
    UCP_PROFILE_PATH,
    "ucpProfile",
  ] as const,
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
  (typeof SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS)[number][3] | "sitemapChild";

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

export interface SeoDiscoveryStatusInput {
  discovery: unknown;
  robotsTxt?: string | null;
  storefrontUrl?: string | null;
  businessIdentity?: SeoDiscoveryBusinessIdentity | null;
  hasStoreLogo?: boolean | null;
}

export interface SeoDiscoveryStatus {
  sitemap: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    enabled: boolean;
    includedSections: Array<{
      key: keyof SeoDiscoverySettings["sitemap"];
      label: string;
      enabled: boolean;
    }>;
  };
  productFeed: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    enabled: boolean;
    includesUnavailableProducts: boolean;
    variantStrategy: SeoDiscoverySettings["feeds"]["variantStrategy"];
    variantStrategyLabel: string;
    feedTitle: string;
    feedDescription: string;
    imagePolicy: string;
  };
  robots: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    advertiseSitemap: boolean;
    customSitemapLines: string[];
    warning?: string;
  };
  structuredData: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    organizationEnabled: boolean;
    websiteSearchEnabled: boolean;
    productsEnabled: boolean;
    productGroupsEnabled: boolean;
    offerShippingDetailsEnabled: boolean;
    returnPolicyEnabled: boolean;
    returnPolicySummary: string;
    returnPolicyNote?: string;
    returnPolicyWarning?: string;
    breadcrumbsEnabled: boolean;
    collectionsEnabled: boolean;
    organizationNote: string;
    identityWarning?: string;
    schemaPreviewRows: SeoStructuredDataPreviewRow[];
  };
  ucpCatalog: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    profilePath: string;
    profileHref: string | null;
    capabilities: string[];
    note: string;
  };
  storefront: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    mode: "absolute" | "path-only" | "unavailable";
    baseUrl: string | null;
    note: string;
    links: Array<{
      key: string;
      label: string;
      path: string;
      href: string | null;
    }>;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasBusinessSchemaName(
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined,
): boolean {
  return Boolean(
    businessIdentity?.companyName?.trim() ||
    businessIdentity?.legalName?.trim(),
  );
}

function buildStructuredDataWarning({
  businessIdentity,
  hasAbsoluteStorefrontUrl,
  hasStoreLogo,
  organizationEnabled,
  productGroupsEnabled,
  productsEnabled,
  returnPolicyEnabled,
  websiteSearchEnabled,
  breadcrumbsEnabled,
  collectionsEnabled,
}: {
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined;
  hasAbsoluteStorefrontUrl: boolean;
  hasStoreLogo: boolean | null | undefined;
  organizationEnabled: boolean;
  productGroupsEnabled: boolean;
  productsEnabled: boolean;
  returnPolicyEnabled: boolean;
  websiteSearchEnabled: boolean;
  breadcrumbsEnabled: boolean;
  collectionsEnabled: boolean;
}): string | undefined {
  const warnings: string[] = [];
  const needsBusinessName =
    organizationEnabled || websiteSearchEnabled || productsEnabled;
  const needsSchemaUrl =
    organizationEnabled ||
    websiteSearchEnabled ||
    productsEnabled ||
    productGroupsEnabled ||
    returnPolicyEnabled ||
    breadcrumbsEnabled ||
    collectionsEnabled;

  if (needsSchemaUrl && !hasAbsoluteStorefrontUrl) {
    warnings.push(
      "Add a full absolute http(s) Store URL in dashboard settings before relying on URL-bearing structured data; path-only values only help dashboard preview/sidebar navigation.",
    );
  }

  if (needsBusinessName && !hasBusinessSchemaName(businessIdentity)) {
    warnings.push(
      "Add a company name or legal name in Business settings before relying on OnlineStore, site search, or Product seller identity schema.",
    );
  }

  if (organizationEnabled && hasStoreLogo === false) {
    warnings.push(
      "Add a header logo before relying on OnlineStore schema; runtime omits it without a logo.",
    );
  }

  return warnings.length > 0 ? warnings.join(" ") : undefined;
}

export function normalizeSeoDiscoverySettingsWithReturnPolicy(
  value: unknown,
): SeoDiscoverySettingsWithReturnPolicy {
  const root = asRecord(value);

  return {
    ...normalizeSeoDiscoverySettings(value),
    returnPolicy: normalizeSeoReturnPolicySettings(root.returnPolicy),
  };
}

function buildReturnPolicySummary(policy: SeoReturnPolicySettings): string {
  if (!policy.enabled) return "return policy off";

  const categoryLabel = RETURN_POLICY_CATEGORY_LABELS[policy.category];
  if (policy.category === "no_returns") {
    return `${policy.country}; ${categoryLabel}`;
  }

  const windowLabel =
    policy.category === "finite"
      ? `${
          policy.returnWindowDays ??
          DEFAULT_SEO_RETURN_POLICY_SETTINGS.returnWindowDays
        } day return window`
      : categoryLabel;

  return [
    policy.country,
    windowLabel,
    RETURN_POLICY_FEES_LABELS[policy.returnFees],
    RETURN_POLICY_METHOD_LABELS[policy.returnMethod],
    policy.policyUrl ? "policy URL set" : "policy URL missing",
  ].join("; ");
}

function buildReturnPolicyEmissionNote({
  organizationEnabled,
  policyEnabled,
  productsEnabled,
}: {
  organizationEnabled: boolean;
  policyEnabled: boolean;
  productsEnabled: boolean;
}): { note?: string; warning?: string } {
  if (!policyEnabled) return {};

  if (!organizationEnabled && !productsEnabled) {
    return {
      warning:
        "Return policy facts are saved but will not emit until Organization or Product schema is enabled.",
    };
  }

  const targets = [
    organizationEnabled ? "OnlineStore" : null,
    productsEnabled ? "Product offers" : null,
  ].filter((target): target is string => Boolean(target));

  return {
    note: `Return policy can emit through ${targets.join(
      " and ",
    )}; normal schema prerequisites still apply.`,
  };
}

function onlineStorePrerequisiteSummary({
  businessIdentity,
  hasAbsoluteStorefrontUrl,
  hasStoreLogo,
}: {
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined;
  hasAbsoluteStorefrontUrl: boolean;
  hasStoreLogo: boolean | null | undefined;
}): string | undefined {
  if (!hasAbsoluteStorefrontUrl) return "Add an absolute http(s) Store URL.";
  if (!hasBusinessSchemaName(businessIdentity)) {
    return "Add a company name or legal name in Business settings.";
  }
  if (hasStoreLogo === false) return "Add a header logo.";
  return undefined;
}

function buildOnlineStoreSchemaPreviewRow({
  businessIdentity,
  enabled,
  hasAbsoluteStorefrontUrl,
  hasStoreLogo,
}: {
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined;
  enabled: boolean;
  hasAbsoluteStorefrontUrl: boolean;
  hasStoreLogo: boolean | null | undefined;
}): SeoStructuredDataPreviewRow {
  if (!enabled) {
    return {
      key: "onlineStore",
      tone: "disabled",
      title: "OnlineStore off",
      summary:
        "Global store identity JSON-LD is disabled; product pages can still use their own schema controls.",
    };
  }

  const prerequisite = onlineStorePrerequisiteSummary({
    businessIdentity,
    hasAbsoluteStorefrontUrl,
    hasStoreLogo,
  });

  if (prerequisite) {
    return {
      key: "onlineStore",
      tone: "warning",
      title: "OnlineStore needs setup",
      summary: `${prerequisite} Runtime omits OnlineStore until Store URL, business name, and header logo are ready.`,
    };
  }

  return {
    key: "onlineStore",
    tone: "ok",
    title: "OnlineStore ready",
    summary:
      "Home/layout pages can emit store identity from Business settings, Store URL, header logo, and safe public social links.",
  };
}

function buildWebsiteSearchSchemaPreviewRow({
  businessIdentity,
  enabled,
  hasAbsoluteStorefrontUrl,
}: {
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined;
  enabled: boolean;
  hasAbsoluteStorefrontUrl: boolean;
}): SeoStructuredDataPreviewRow {
  if (!enabled) {
    return {
      key: "websiteSearch",
      tone: "disabled",
      title: "WebSite SearchAction off",
      summary: "Search box JSON-LD is disabled for global pages.",
    };
  }

  if (!hasAbsoluteStorefrontUrl) {
    return {
      key: "websiteSearch",
      tone: "warning",
      title: "SearchAction needs Store URL",
      summary:
        "Add an absolute http(s) Store URL so the search target can point to the public /search route.",
    };
  }

  if (!hasBusinessSchemaName(businessIdentity)) {
    return {
      key: "websiteSearch",
      tone: "warning",
      title: "SearchAction needs business name",
      summary:
        "Add a company name or legal name in Business settings before emitting WebSite SearchAction.",
    };
  }

  return {
    key: "websiteSearch",
    tone: "ok",
    title: "WebSite SearchAction ready",
    summary:
      "Global pages can emit a WebSite schema with the public /search?q=... target.",
  };
}

function buildMerchantReturnPolicySchemaPreviewRow({
  businessIdentity,
  discovery,
  hasAbsoluteStorefrontUrl,
  hasStoreLogo,
  policy,
}: {
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined;
  discovery: SeoDiscoverySettings;
  hasAbsoluteStorefrontUrl: boolean;
  hasStoreLogo: boolean | null | undefined;
  policy: SeoReturnPolicySettings;
}): SeoStructuredDataPreviewRow {
  if (!policy.enabled) {
    return {
      key: "merchantReturnPolicy",
      tone: "disabled",
      title: "MerchantReturnPolicy off",
      summary:
        "No return-policy fact is attached. That is valid when a public policy is disabled or still incomplete.",
    };
  }

  const onlineStoreIssue = discovery.structuredData.organization
    ? onlineStorePrerequisiteSummary({
        businessIdentity,
        hasAbsoluteStorefrontUrl,
        hasStoreLogo,
      })
    : undefined;
  const productIssue =
    discovery.structuredData.products && !hasAbsoluteStorefrontUrl
      ? "Product offers need an absolute Store URL."
      : undefined;
  const readyTargets = [
    discovery.structuredData.organization && !onlineStoreIssue
      ? "OnlineStore"
      : null,
    discovery.structuredData.products && !productIssue
      ? "Product offers"
      : null,
  ].filter((target): target is string => Boolean(target));
  const waitingTargets = [
    onlineStoreIssue ? `OnlineStore waits: ${onlineStoreIssue}` : null,
    productIssue ? productIssue : null,
  ].filter((target): target is string => Boolean(target));

  if (
    !discovery.structuredData.organization &&
    !discovery.structuredData.products
  ) {
    return {
      key: "merchantReturnPolicy",
      tone: "warning",
      title: "MerchantReturnPolicy waiting",
      summary:
        "Return-policy facts are saved, but they only emit through OnlineStore or Product offer schema. Turn on one of those targets to publish them.",
    };
  }

  if (readyTargets.length === 0) {
    return {
      key: "merchantReturnPolicy",
      tone: "warning",
      title: "MerchantReturnPolicy needs target",
      summary: waitingTargets.join(" "),
    };
  }

  return {
    key: "merchantReturnPolicy",
    tone: waitingTargets.length > 0 ? "warning" : "ok",
    title:
      waitingTargets.length > 0
        ? "MerchantReturnPolicy partially ready"
        : "MerchantReturnPolicy ready",
    summary: [
      `Can attach through ${readyTargets.join(" and ")} when those pages are public and schema is eligible.`,
      ...waitingTargets,
    ].join(" "),
  };
}

function buildProductSchemaPreviewRow({
  discovery,
  hasAbsoluteStorefrontUrl,
}: {
  discovery: SeoDiscoverySettings;
  hasAbsoluteStorefrontUrl: boolean;
}): SeoStructuredDataPreviewRow {
  const productsEnabled = discovery.structuredData.products;
  const productGroupsEnabled = discovery.structuredData.productGroups;
  const offerShippingDetailsEnabled =
    discovery.structuredData.offerShippingDetails;
  const breadcrumbsEnabled = discovery.structuredData.breadcrumbs;
  const anyProductSchemaEnabled =
    productsEnabled ||
    productGroupsEnabled ||
    offerShippingDetailsEnabled ||
    breadcrumbsEnabled;

  if (!anyProductSchemaEnabled) {
    return {
      key: "productPages",
      tone: "disabled",
      title: "Product page schema off",
      summary:
        "Product, ProductGroup, offer shipping, and product BreadcrumbList JSON-LD are disabled.",
    };
  }

  if (
    !productsEnabled &&
    (productGroupsEnabled || offerShippingDetailsEnabled)
  ) {
    return {
      key: "productPages",
      tone: "warning",
      title: "Product add-ons waiting",
      summary:
        "ProductGroup variants and offer shipping details only attach when Product schema is enabled. Breadcrumbs follow their separate switch.",
    };
  }

  if (!hasAbsoluteStorefrontUrl) {
    return {
      key: "productPages",
      tone: "warning",
      title: "Product pages need Store URL",
      summary:
        "Product and Breadcrumb URL fields need an absolute Store URL; noindexed products still suppress resource JSON-LD.",
    };
  }

  return {
    key: "productPages",
    tone: productsEnabled && breadcrumbsEnabled ? "ok" : "info",
    title:
      productsEnabled && breadcrumbsEnabled
        ? "Product page schema ready"
        : "Product page schema partial",
    summary: [
      productsEnabled
        ? productGroupsEnabled
          ? "Product/ProductGroup on"
          : "Product on"
        : "Product off",
      offerShippingDetailsEnabled
        ? "shipping details on"
        : "shipping details off",
      breadcrumbsEnabled ? "product breadcrumbs on" : "product breadcrumbs off",
      "Only public, indexed product pages emit resource JSON-LD.",
    ].join("; "),
  };
}

function buildCategoryCollectionSchemaPreviewRow({
  discovery,
  hasAbsoluteStorefrontUrl,
}: {
  discovery: SeoDiscoverySettings;
  hasAbsoluteStorefrontUrl: boolean;
}): SeoStructuredDataPreviewRow {
  const collectionsEnabled = discovery.structuredData.collections;
  const breadcrumbsEnabled = discovery.structuredData.breadcrumbs;

  if (!collectionsEnabled && !breadcrumbsEnabled) {
    return {
      key: "categoryCollectionPages",
      tone: "disabled",
      title: "Category/collection schema off",
      summary:
        "CollectionPage and BreadcrumbList JSON-LD are disabled for category and collection pages. CMS pages do not emit page-specific JSON-LD today.",
    };
  }

  if (!hasAbsoluteStorefrontUrl) {
    return {
      key: "categoryCollectionPages",
      tone: "warning",
      title: "Page schema needs Store URL",
      summary:
        "Category and collection schema URLs need an absolute Store URL; noindexed resources still suppress page-specific JSON-LD.",
    };
  }

  return {
    key: "categoryCollectionPages",
    tone: collectionsEnabled && breadcrumbsEnabled ? "ok" : "info",
    title:
      collectionsEnabled && breadcrumbsEnabled
        ? "Category/collection schema ready"
        : "Category/collection schema partial",
    summary: [
      collectionsEnabled ? "CollectionPage on" : "CollectionPage off",
      breadcrumbsEnabled ? "BreadcrumbList on" : "BreadcrumbList off",
      "Applies to public indexed categories and collections; CMS pages do not emit page-specific JSON-LD today.",
    ].join("; "),
  };
}

function buildStructuredDataPreviewRows({
  businessIdentity,
  discovery,
  hasAbsoluteStorefrontUrl,
  hasStoreLogo,
  returnPolicy,
}: {
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined;
  discovery: SeoDiscoverySettings;
  hasAbsoluteStorefrontUrl: boolean;
  hasStoreLogo: boolean | null | undefined;
  returnPolicy: SeoReturnPolicySettings;
}): SeoStructuredDataPreviewRow[] {
  return [
    buildOnlineStoreSchemaPreviewRow({
      businessIdentity,
      enabled: discovery.structuredData.organization,
      hasAbsoluteStorefrontUrl,
      hasStoreLogo,
    }),
    buildWebsiteSearchSchemaPreviewRow({
      businessIdentity,
      enabled: discovery.structuredData.websiteSearch,
      hasAbsoluteStorefrontUrl,
    }),
    buildMerchantReturnPolicySchemaPreviewRow({
      businessIdentity,
      discovery,
      hasAbsoluteStorefrontUrl,
      hasStoreLogo,
      policy: returnPolicy,
    }),
    buildProductSchemaPreviewRow({
      discovery,
      hasAbsoluteStorefrontUrl,
    }),
    buildCategoryCollectionSchemaPreviewRow({
      discovery,
      hasAbsoluteStorefrontUrl,
    }),
  ];
}

function isPlaceholderSitemapValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "your-sitemap-url" ||
    normalized === "[your-sitemap-url]" ||
    (normalized.startsWith("[") && normalized.endsWith("]"))
  );
}

function findCustomSitemapLines(
  robotsTxt: string | null | undefined,
): string[] {
  if (!robotsTxt) return [];

  return robotsTxt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const match = line.match(/^sitemap:\s*(.*)$/i);
      if (!match) return false;
      return !isPlaceholderSitemapValue(match[1] ?? "");
    });
}

export function parseSeoDiscoveryStorefrontUrl(
  value: string | null | undefined,
): URL | null {
  if (!value) return null;

  try {
    const parsed = new URL(value.trim());
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

function getFeedVariantStrategyLabel(
  strategy: SeoDiscoverySettings["feeds"]["variantStrategy"],
): string {
  return strategy === "variants" ? "SKU / variant rows" : "Product rows";
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

function capabilitySegments(capability: string): string[] {
  return capability
    .toLowerCase()
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isForbiddenUcpCapability(capability: string): boolean {
  return capabilitySegments(capability).some((segment) =>
    UCP_FORBIDDEN_CAPABILITY_SEGMENTS.has(segment),
  );
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

export function buildSeoDiscoveryStatus({
  discovery,
  robotsTxt,
  storefrontUrl,
  businessIdentity,
  hasStoreLogo,
}: SeoDiscoveryStatusInput): SeoDiscoveryStatus {
  const normalized = normalizeSeoDiscoverySettingsWithReturnPolicy(discovery);
  const customSitemapLines = findCustomSitemapLines(robotsTxt);
  const absoluteStorefrontUrl = parseSeoDiscoveryStorefrontUrl(storefrontUrl);
  const trimmedStorefrontUrl = storefrontUrl?.trim() ?? "";
  const includedSections = SITEMAP_SECTIONS.map(([key, label]) => ({
    key,
    label,
    enabled: normalized.sitemap[key],
  }));
  const enabledSectionLabels = includedSections
    .filter((section) => section.enabled)
    .map((section) => section.label.toLowerCase());

  const storefrontMode = absoluteStorefrontUrl
    ? "absolute"
    : trimmedStorefrontUrl
      ? "path-only"
      : "unavailable";
  const identityWarning = buildStructuredDataWarning({
    businessIdentity,
    hasAbsoluteStorefrontUrl: Boolean(absoluteStorefrontUrl),
    hasStoreLogo,
    organizationEnabled: normalized.structuredData.organization,
    productGroupsEnabled: normalized.structuredData.productGroups,
    productsEnabled: normalized.structuredData.products,
    returnPolicyEnabled: normalized.returnPolicy.enabled,
    websiteSearchEnabled: normalized.structuredData.websiteSearch,
    breadcrumbsEnabled: normalized.structuredData.breadcrumbs,
    collectionsEnabled: normalized.structuredData.collections,
  });
  const feedVariantStrategyLabel = getFeedVariantStrategyLabel(
    normalized.feeds.variantStrategy,
  );
  const storeUrlRequirement =
    storefrontMode === "path-only"
      ? "Store URL must be an absolute http(s) URL."
      : "Store URL is missing.";
  const sitemapNeedsStoreUrl =
    normalized.sitemap.enabled && !absoluteStorefrontUrl;
  const feedNeedsStoreUrl =
    normalized.feeds.productCatalogEnabled && !absoluteStorefrontUrl;
  const robotsAdvertisesCanonicalSitemap =
    normalized.sitemap.enabled && normalized.robots.advertiseSitemap;
  const robotsNeedsStoreUrl =
    robotsAdvertisesCanonicalSitemap && !absoluteStorefrontUrl;
  const returnPolicyEmission = buildReturnPolicyEmissionNote({
    organizationEnabled: normalized.structuredData.organization,
    policyEnabled: normalized.returnPolicy.enabled,
    productsEnabled: normalized.structuredData.products,
  });
  const schemaPreviewRows = buildStructuredDataPreviewRows({
    businessIdentity,
    discovery: normalized,
    hasAbsoluteStorefrontUrl: Boolean(absoluteStorefrontUrl),
    hasStoreLogo,
    returnPolicy: normalized.returnPolicy,
  });
  const structuredDataNeedsReview = Boolean(
    identityWarning ||
    returnPolicyEmission.warning ||
    schemaPreviewRows.some((row) => row.tone === "warning"),
  );
  const anyStructuredDataEnabled =
    normalized.structuredData.organization ||
    normalized.structuredData.websiteSearch ||
    normalized.structuredData.products ||
    normalized.structuredData.productGroups ||
    normalized.structuredData.offerShippingDetails ||
    normalized.returnPolicy.enabled ||
    normalized.structuredData.breadcrumbs ||
    normalized.structuredData.collections;
  const returnPolicySummaryLabel = normalized.returnPolicy.enabled
    ? returnPolicyEmission.warning
      ? "return policy waiting for Organization/Product schema"
      : "return policy"
    : "return policy off";
  const ucpProfileHref =
    absoluteStorefrontUrl?.protocol === "https:"
      ? buildSeoDiscoveryHref(absoluteStorefrontUrl, UCP_PROFILE_PATH)
      : null;
  const hasHttpsStorefrontUrl = Boolean(ucpProfileHref);
  const ucpStoreUrlIssue = absoluteStorefrontUrl
    ? "UCP public discovery requires an HTTPS Store URL."
    : `${storeUrlRequirement} UCP public discovery requires HTTPS.`;

  return {
    sitemap: {
      tone: normalized.sitemap.enabled
        ? sitemapNeedsStoreUrl
          ? "warning"
          : "ok"
        : "disabled",
      title: normalized.sitemap.enabled
        ? sitemapNeedsStoreUrl
          ? "Sitemap needs Store URL"
          : "Sitemap index on"
        : "Sitemap index off",
      summary: normalized.sitemap.enabled
        ? sitemapNeedsStoreUrl
          ? `${storeUrlRequirement} Runtime sitemap XML is unavailable until this is fixed.`
          : enabledSectionLabels.length > 0
            ? `Includes ${enabledSectionLabels.join(", ")}.`
            : "Index is enabled, but every section is turned off."
        : "Search engines will not receive the generated sitemap index.",
      enabled: normalized.sitemap.enabled,
      includedSections,
    },
    productFeed: {
      tone: normalized.feeds.productCatalogEnabled
        ? feedNeedsStoreUrl
          ? "warning"
          : "ok"
        : "disabled",
      title: normalized.feeds.productCatalogEnabled
        ? feedNeedsStoreUrl
          ? "Product feed needs Store URL"
          : "Product feed on"
        : "Product feed off",
      summary: normalized.feeds.productCatalogEnabled
        ? feedNeedsStoreUrl
          ? `${feedVariantStrategyLabel}; ${storeUrlRequirement} Feed XML is unavailable until this is fixed.`
          : `${feedVariantStrategyLabel}; ${
              normalized.feeds.includeUnavailableProducts
                ? "sold-out catalog items are marked out of stock."
                : "only items currently available for sale are included."
            }`
        : "Catalog XML is not advertised for feed tools.",
      enabled: normalized.feeds.productCatalogEnabled,
      includesUnavailableProducts: normalized.feeds.includeUnavailableProducts,
      variantStrategy: normalized.feeds.variantStrategy,
      variantStrategyLabel: feedVariantStrategyLabel,
      feedTitle: normalized.feeds.title || "Product Catalog",
      feedDescription:
        normalized.feeds.description ||
        "Complete product catalog for feed tools.",
      imagePolicy:
        "Feed rows require absolute http(s) product and image links; rich text is flattened to catalog text.",
    },
    robots: {
      tone:
        robotsNeedsStoreUrl || customSitemapLines.length > 0
          ? "warning"
          : "info",
      title: robotsNeedsStoreUrl
        ? "robots.txt needs Store URL"
        : robotsAdvertisesCanonicalSitemap
          ? "robots.txt advertises canonical sitemap"
          : "robots.txt sitemap not advertised",
      summary: robotsNeedsStoreUrl
        ? `${storeUrlRequirement} Runtime robots output cannot prove canonical sitemap advertising.`
        : robotsAdvertisesCanonicalSitemap
          ? "Runtime strips saved Sitemap directives and advertises only the canonical current sitemap."
          : normalized.sitemap.enabled
            ? "Runtime strips all Sitemap directives and advertises no sitemap."
            : "Sitemap index is off, so runtime advertises no sitemap.",
      advertiseSitemap: normalized.robots.advertiseSitemap,
      customSitemapLines,
      warning:
        customSitemapLines.length > 0
          ? "Saved custom Sitemap lines are ignored; runtime strips or replaces them with the canonical current sitemap."
          : undefined,
    },
    structuredData: {
      tone: structuredDataNeedsReview
        ? "warning"
        : anyStructuredDataEnabled
          ? "ok"
          : "disabled",
      title: structuredDataNeedsReview
        ? "Structured data needs review"
        : anyStructuredDataEnabled
          ? "Structured data on"
          : "Structured data off",
      summary: [
        normalized.structuredData.organization
          ? "Organization"
          : "Organization off",
        normalized.structuredData.websiteSearch
          ? "site search"
          : "site search off",
        normalized.structuredData.products ? "products" : "products off",
        normalized.structuredData.productGroups
          ? "ProductGroup variants"
          : "ProductGroup variants off",
        normalized.structuredData.offerShippingDetails
          ? "shipping offers"
          : "shipping offers off",
        returnPolicySummaryLabel,
        normalized.structuredData.breadcrumbs
          ? "breadcrumbs"
          : "breadcrumbs off",
        normalized.structuredData.collections
          ? "collections"
          : "collections off",
      ].join("; "),
      organizationEnabled: normalized.structuredData.organization,
      websiteSearchEnabled: normalized.structuredData.websiteSearch,
      productsEnabled: normalized.structuredData.products,
      productGroupsEnabled: normalized.structuredData.productGroups,
      offerShippingDetailsEnabled:
        normalized.structuredData.offerShippingDetails,
      returnPolicyEnabled: normalized.returnPolicy.enabled,
      returnPolicySummary: buildReturnPolicySummary(normalized.returnPolicy),
      returnPolicyNote: returnPolicyEmission.note,
      returnPolicyWarning: returnPolicyEmission.warning,
      breadcrumbsEnabled: normalized.structuredData.breadcrumbs,
      collectionsEnabled: normalized.structuredData.collections,
      organizationNote:
        "OnlineStore schema needs an absolute Store URL, a business name, and a header logo; Product seller identity uses Business settings only; ProductGroup schema describes optioned products; shipping schema uses active shipping methods; return-policy schema uses only saved public policy fields. BreadcrumbList and CollectionPage are separate controls.",
      identityWarning,
      schemaPreviewRows,
    },
    ucpCatalog: {
      tone: hasHttpsStorefrontUrl ? "ok" : "warning",
      title: hasHttpsStorefrontUrl
        ? "UCP catalog discovery on"
        : "UCP catalog needs HTTPS Store URL",
      summary: hasHttpsStorefrontUrl
        ? "Shopping agents can discover read-only catalog search and lookup. Checkout, cart, order, and payment capabilities are not advertised."
        : ucpStoreUrlIssue,
      profilePath: UCP_PROFILE_PATH,
      profileHref: ucpProfileHref,
      capabilities: ["Catalog search", "Catalog lookup"],
      note: "This is an agent-commerce catalog surface only, not a checkout or payment integration.",
    },
    storefront: {
      tone: absoluteStorefrontUrl
        ? "ok"
        : storefrontMode === "path-only"
          ? "warning"
          : "info",
      title: absoluteStorefrontUrl
        ? "Dashboard Store URL preview"
        : storefrontMode === "path-only"
          ? "Path-only preview"
          : "Store URL unavailable",
      summary: absoluteStorefrontUrl
        ? "Preview links use the dashboard Store URL setting."
        : storefrontMode === "path-only"
          ? "Store URL is not an absolute http(s) URL, so links stay as paths."
          : "Store URL could not be loaded, so links stay unavailable.",
      mode: storefrontMode,
      baseUrl: absoluteStorefrontUrl?.href ?? null,
      note: "This is a dashboard preview, not a live probe of the storefront Worker env.",
      links: PREVIEW_ENDPOINTS.map(([key, label, path]) => ({
        key,
        label,
        path,
        href: absoluteStorefrontUrl
          ? buildSeoDiscoveryHref(absoluteStorefrontUrl, path)
          : null,
      })),
    },
  };
}
