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
  imageLinks?: number;
  availabilityValues?: number;
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
    breadcrumbsEnabled: boolean;
    collectionsEnabled: boolean;
    organizationNote: string;
    identityWarning?: string;
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

function hasBusinessSchemaName(
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined,
): boolean {
  return Boolean(
    businessIdentity?.companyName?.trim() || businessIdentity?.legalName?.trim(),
  );
}

function buildStructuredDataWarning({
  businessIdentity,
  hasStoreLogo,
  organizationEnabled,
  productsEnabled,
  websiteSearchEnabled,
}: {
  businessIdentity: SeoDiscoveryBusinessIdentity | null | undefined;
  hasStoreLogo: boolean | null | undefined;
  organizationEnabled: boolean;
  productsEnabled: boolean;
  websiteSearchEnabled: boolean;
}): string | undefined {
  const warnings: string[] = [];
  const needsBusinessName =
    organizationEnabled || websiteSearchEnabled || productsEnabled;

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

function isPlaceholderSitemapValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "your-sitemap-url" ||
    normalized === "[your-sitemap-url]" ||
    (normalized.startsWith("[") && normalized.endsWith("]"))
  );
}

function findCustomSitemapLines(robotsTxt: string | null | undefined): string[] {
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

function countRobotsSitemapLines(robotsTxt: string): number {
  return robotsTxt
    .split(/\r?\n/)
    .filter((line) => /^sitemap\s*:/i.test(line.trim())).length;
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

  return {
    feedItems: countXmlStartTags(body, "item"),
    imageLinks: countXmlStartTags(body, "image_link"),
    availabilityValues: countXmlStartTags(body, "availability"),
  };
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
    hasStoreLogo,
    organizationEnabled: normalized.structuredData.organization,
    productsEnabled: normalized.structuredData.products,
    websiteSearchEnabled: normalized.structuredData.websiteSearch,
  });
  const feedVariantStrategyLabel = getFeedVariantStrategyLabel(
    normalized.feeds.variantStrategy,
  );

  return {
    sitemap: {
      tone: normalized.sitemap.enabled ? "ok" : "disabled",
      title: normalized.sitemap.enabled
        ? "Sitemap index on"
        : "Sitemap index off",
      summary: normalized.sitemap.enabled
        ? enabledSectionLabels.length > 0
          ? `Includes ${enabledSectionLabels.join(", ")}.`
          : "Index is enabled, but every section is turned off."
        : "Search engines will not receive the generated sitemap index.",
      enabled: normalized.sitemap.enabled,
      includedSections,
    },
    productFeed: {
      tone: normalized.feeds.productCatalogEnabled ? "ok" : "disabled",
      title: normalized.feeds.productCatalogEnabled
        ? "Product feed on"
        : "Product feed off",
      summary: normalized.feeds.productCatalogEnabled
        ? `${feedVariantStrategyLabel}; ${
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
        "Catalog items without an absolute http(s) primary image are skipped; rich-text descriptions are flattened to plain catalog text.",
    },
    robots: {
      tone: customSitemapLines.length > 0 ? "warning" : "info",
      title: normalized.robots.advertiseSitemap
        ? "robots.txt advertises canonical sitemap"
        : "robots.txt sitemap ad off",
      summary: normalized.robots.advertiseSitemap
        ? "Runtime strips saved Sitemap directives and advertises only the canonical current sitemap when the Store URL is absolute; otherwise it emits none."
        : "Runtime strips all Sitemap directives and advertises no sitemap.",
      advertiseSitemap: normalized.robots.advertiseSitemap,
      customSitemapLines,
      warning:
        customSitemapLines.length > 0
          ? "Saved custom Sitemap lines are ignored; runtime strips or replaces them with the canonical current sitemap."
          : undefined,
    },
    structuredData: {
      tone:
        identityWarning
          ? "warning"
          : normalized.structuredData.organization ||
              normalized.structuredData.websiteSearch ||
              normalized.structuredData.products ||
              normalized.structuredData.productGroups ||
              normalized.structuredData.offerShippingDetails ||
              normalized.returnPolicy.enabled ||
              normalized.structuredData.breadcrumbs ||
              normalized.structuredData.collections
          ? "ok"
          : "disabled",
      title:
        normalized.structuredData.organization ||
        normalized.structuredData.websiteSearch ||
        normalized.structuredData.products ||
        normalized.structuredData.productGroups ||
        normalized.structuredData.offerShippingDetails ||
        normalized.returnPolicy.enabled ||
        normalized.structuredData.breadcrumbs ||
        normalized.structuredData.collections
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
        normalized.returnPolicy.enabled
          ? "return policy"
          : "return policy off",
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
      breadcrumbsEnabled: normalized.structuredData.breadcrumbs,
      collectionsEnabled: normalized.structuredData.collections,
      organizationNote:
        "OnlineStore schema needs an absolute Store URL, a business name, and a header logo; Product seller identity uses Business settings only; ProductGroup schema describes optioned products; shipping schema uses active shipping methods; return-policy schema uses only saved public policy fields. BreadcrumbList and CollectionPage are separate controls.",
      identityWarning,
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
