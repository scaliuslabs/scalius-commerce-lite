import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import {
  isValidResourceCanonicalPath,
  normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";
import { resolveCatalogDiscoveryImageUrl } from "@scalius/shared/catalog-discovery-media";

export type ProductSeoDiagnosticTone =
  | "ok"
  | "warning"
  | "disabled"
  | "draft"
  | "info";

export type ProductSeoPolicySource = "current" | "default";
export type ProductSeoVariantState = "loaded" | "loading" | "unavailable";

export interface ProductSeoDiagnosticMedia {
  kind: "image" | "video";
  url?: string | null;
  posterUrl?: string | null;
  isPrimary?: boolean | null;
  sortOrder?: number | null;
}

export interface ProductSeoDiagnosticVariant {
  id?: string | null;
  optionCombinationKey?: string | null;
  sku?: string | null;
  stock?: number | null;
  reservedStock?: number | null;
  isDefault?: boolean | null;
  trackInventory?: boolean | null;
  deletedAt?: unknown;
}

export interface ProductSeoDiagnosticsInput {
  product: {
    id?: string | null;
    slug?: string | null;
    canonicalPath?: string | null;
    isActive?: boolean | null;
    media?: ProductSeoDiagnosticMedia[] | null;
    noIndex?: boolean | null;
    excludeFromSitemap?: boolean | null;
    excludeFromProductFeed?: boolean | null;
  };
  variants?: ProductSeoDiagnosticVariant[] | null;
  variantState?: ProductSeoVariantState;
  discovery?: unknown;
  storefrontUrl?: string | null;
  policySource?: ProductSeoPolicySource;
}

export interface ProductSeoDiagnosticRow {
  tone: ProductSeoDiagnosticTone;
  title: string;
  summary: string;
  value?: string;
}

export interface ProductSeoAvailabilityStatus {
  state: "available" | "sold_out" | "not_resolvable" | "unknown";
  summary: string;
  canResolveBuyerSku: boolean | null;
  availableForSale: boolean | null;
}

export interface ProductSeoDiagnostics {
  policy: {
    source: ProductSeoPolicySource;
    label: string;
    summary: string;
  };
  canonical: ProductSeoDiagnosticRow & {
    path: string | null;
    url: string | null;
  };
  sitemap: ProductSeoDiagnosticRow;
  feedImage: ProductSeoDiagnosticRow & {
    imageUrl: string | null;
  };
  feed: ProductSeoDiagnosticRow & {
    inclusion: "included" | "skipped" | "conditional" | "disabled" | "draft";
    skippedReason: string | null;
  };
  structuredData: ProductSeoDiagnosticRow & {
    productsEnabled: boolean;
    breadcrumbsEnabled: boolean;
  };
  availability: ProductSeoAvailabilityStatus;
  discovery: SeoDiscoverySettings;
}

const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseAbsoluteHttpUrl(value: string | null | undefined): URL | null {
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

function buildAbsoluteUrl(baseUrl: URL, path: string): string {
  const normalizedBase = baseUrl.href.endsWith("/")
    ? baseUrl.href.slice(0, -1)
    : baseUrl.href;
  return `${normalizedBase}${path}`;
}

function normalizeSlug(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function hasCustomerOption(variant: ProductSeoDiagnosticVariant): boolean {
  return Boolean(variant.optionCombinationKey?.trim());
}

function isActivePersistedSku(variant: ProductSeoDiagnosticVariant): boolean {
  return !variant.deletedAt && variant.id !== "default";
}

function isSkuAvailable(variant: ProductSeoDiagnosticVariant): boolean | null {
  if (variant.trackInventory === false) {
    return true;
  }

  if (
    typeof variant.stock !== "number" ||
    typeof variant.reservedStock !== "number"
  ) {
    return null;
  }

  return variant.stock - variant.reservedStock > 0;
}

function getBuyerResolvableSkus(
  variants: ProductSeoDiagnosticVariant[],
): ProductSeoDiagnosticVariant[] {
  const activeSkus = variants.filter(isActivePersistedSku);
  const optionSkus = activeSkus.filter(
    (variant) => variant.isDefault !== true && hasCustomerOption(variant),
  );

  if (optionSkus.length > 0) {
    return optionSkus;
  }

  if (activeSkus.length === 1 && activeSkus[0]?.isDefault === true) {
    return activeSkus;
  }

  return [];
}

function buildAvailabilityStatus(
  variants: ProductSeoDiagnosticVariant[] | null | undefined,
  variantState: ProductSeoVariantState,
): ProductSeoAvailabilityStatus {
  if (variantState === "loading") {
    return {
      state: "unknown",
      summary: "Checking saved SKUs before estimating catalog availability.",
      canResolveBuyerSku: null,
      availableForSale: null,
    };
  }

  if (variantState !== "loaded" || !variants) {
    return {
      state: "unknown",
      summary: "Availability is estimated after the product has saved SKUs.",
      canResolveBuyerSku: null,
      availableForSale: null,
    };
  }

  const buyerSkus = getBuyerResolvableSkus(variants);
  if (buyerSkus.length === 0) {
    return {
      state: "not_resolvable",
      summary: "No buyer-resolvable SKU is saved yet.",
      canResolveBuyerSku: false,
      availableForSale: false,
    };
  }

  let sawUnknownStock = false;
  const hasAvailableSku = buyerSkus.some((variant) => {
    const available = isSkuAvailable(variant);
    if (available === null) {
      sawUnknownStock = true;
      return false;
    }
    return available;
  });

  if (hasAvailableSku) {
    return {
      state: "available",
      summary: "At least one buyer-resolvable SKU appears available.",
      canResolveBuyerSku: true,
      availableForSale: true,
    };
  }

  if (sawUnknownStock) {
    return {
      state: "unknown",
      summary: "Saved SKUs exist, but stock data is incomplete in this view.",
      canResolveBuyerSku: true,
      availableForSale: null,
    };
  }

  return {
    state: "sold_out",
    summary: "Saved buyer-resolvable SKUs appear sold out.",
    canResolveBuyerSku: true,
    availableForSale: false,
  };
}

function pickProductImageRepresentation(
  media: ProductSeoDiagnosticMedia[] | null | undefined,
): string | null {
  if (!media || media.length === 0) return null;
  const ordered = [...media].sort((left, right) =>
    (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const featured = ordered.find((item) => item.isPrimary === true) ?? ordered[0];
  if (featured?.kind === "image" && featured.url?.trim()) return featured.url.trim();
  if (featured?.kind === "video" && featured.posterUrl?.trim()) return featured.posterUrl.trim();
  const image = ordered.find((item) => item.kind === "image" && item.url?.trim());
  if (image?.url?.trim()) return image.url.trim();
  return ordered.find((item) => item.kind === "video" && item.posterUrl?.trim())?.posterUrl?.trim() ?? null;
}

function buildFeedImageStatus({
  imageUrl,
  hasCanonicalDraft,
  absoluteStorefrontUrl,
  isActive,
}: {
  imageUrl: string | null;
  hasCanonicalDraft: boolean;
  absoluteStorefrontUrl: URL | null;
  isActive: boolean;
}): ProductSeoDiagnostics["feedImage"] {
  if (!imageUrl) {
    return {
      tone: hasCanonicalDraft || !isActive ? "draft" : "warning",
      title: "Feed image needed",
      summary: isActive
        ? "Feed XML skips products without a primary image."
        : "Add a primary image before publishing to the product feed.",
      imageUrl: null,
    };
  }

  const resolvedImageUrl = resolveCatalogDiscoveryImageUrl(
    imageUrl,
    absoluteStorefrontUrl?.origin ?? null,
  );
  if (resolvedImageUrl) {
    return {
      tone: "ok",
      title: "Feed image ready",
      summary: "Primary image can resolve to an http(s) feed image link.",
      value: imageUrl,
      imageUrl: resolvedImageUrl,
    };
  }

  if (!absoluteStorefrontUrl && parseAbsoluteHttpUrl(imageUrl)) {
    return {
      tone: "ok",
      title: "Feed image ready",
      summary: "Primary image is already an absolute http(s) URL.",
      value: imageUrl,
      imageUrl,
    };
  }

  if (!absoluteStorefrontUrl) {
    return {
      tone: "info",
      title: "Feed image needs Store URL",
      summary: "Relative images need an absolute Store URL before XML output.",
      value: imageUrl,
      imageUrl,
    };
  }

  return {
    tone: "warning",
    title: "Feed image skipped",
    summary: "Primary image must resolve to an http(s) URL for catalog XML.",
    value: imageUrl,
    imageUrl,
  };
}

function buildCanonicalStatus({
  slug,
  canonicalPath,
  absoluteStorefrontUrl,
}: {
  slug: string;
  canonicalPath: string | null | undefined;
  absoluteStorefrontUrl: URL | null;
}): ProductSeoDiagnostics["canonical"] {
  if (!slug) {
    return {
      tone: "draft",
      title: "Canonical path pending",
      summary: "Set a product slug to preview the public product URL.",
      path: null,
      url: null,
    };
  }

  if (!PRODUCT_SLUG_PATTERN.test(slug)) {
    return {
      tone: "warning",
      title: "Canonical slug needs cleanup",
      summary: "The saved URL expects lowercase words separated by hyphens.",
      value: slug,
      path: null,
      url: null,
    };
  }

  const normalizedCanonicalPath = normalizeCanonicalPathInput(canonicalPath);
  if (
    normalizedCanonicalPath &&
    !isValidResourceCanonicalPath("product", normalizedCanonicalPath)
  ) {
    return {
      tone: "warning",
      title: "Canonical path needs cleanup",
      summary: "Use a product route without query strings, fragments, spaces, or another domain.",
      value: normalizedCanonicalPath,
      path: null,
      url: null,
    };
  }

  const fallbackPath = `/products/${slug}`;
  const path = normalizedCanonicalPath ?? fallbackPath;
  const url = absoluteStorefrontUrl
    ? buildAbsoluteUrl(absoluteStorefrontUrl, path)
    : null;

  return {
    tone: url ? "ok" : "info",
    title: normalizedCanonicalPath
      ? url
        ? "Canonical override ready"
        : "Canonical override path ready"
      : url
        ? "Canonical URL ready"
        : "Canonical path ready",
    summary: normalizedCanonicalPath
      ? "Product page should point search engines to this same-store canonical path after save."
      : url
        ? "Product page should use this absolute canonical URL after save."
        : "Full canonical URLs need an absolute Store URL setting.",
    value: url ?? path,
    path,
    url,
  };
}

function buildSitemapStatus({
  discovery,
  isActive,
  canonical,
  availability,
  absoluteStorefrontUrl,
  excludeFromSitemap,
  noIndex,
}: {
  discovery: SeoDiscoverySettings;
  isActive: boolean;
  canonical: ProductSeoDiagnostics["canonical"];
  availability: ProductSeoAvailabilityStatus;
  absoluteStorefrontUrl: URL | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
}): ProductSeoDiagnosticRow {
  if (!canonical.path) {
    return {
      tone: "draft",
      title: "Sitemap pending",
      summary: "Product sitemap inclusion can be estimated after a valid slug.",
    };
  }

  if (!discovery.sitemap.enabled) {
    return {
      tone: "disabled",
      title: "Sitemap off",
      summary: "The global sitemap index is disabled in SEO discovery.",
    };
  }

  if (!discovery.sitemap.products) {
    return {
      tone: "disabled",
      title: "Product sitemap off",
      summary: "The product sitemap section is disabled globally.",
    };
  }

  if (noIndex) {
    return {
      tone: "disabled",
      title: "Noindexed",
      summary:
        "The product page stays public, but it is removed from product sitemap XML while search indexing is prevented.",
    };
  }

  if (excludeFromSitemap) {
    return {
      tone: "disabled",
      title: "Excluded from product sitemap",
      summary:
        "The product page stays public, but this product is removed from product sitemap XML.",
    };
  }

  if (!isActive) {
    return {
      tone: "draft",
      title: "Not in sitemap while draft",
      summary: "Inactive products stay out of public product sitemaps.",
    };
  }

  if (availability.canResolveBuyerSku === false) {
    return {
      tone: "warning",
      title: "Sitemap waits for SKU",
      summary: "Public product discovery needs one buyer-resolvable SKU.",
    };
  }

  if (!absoluteStorefrontUrl) {
    return {
      tone: "warning",
      title: "Sitemap needs Store URL",
      summary: "Generated sitemap XML requires an absolute Store URL.",
    };
  }

  if (availability.canResolveBuyerSku === null) {
    return {
      tone: "info",
      title: "Sitemap depends on saved SKU",
      summary: "Expected once the saved product has a buyer-resolvable SKU.",
    };
  }

  return {
    tone: "ok",
    title: "Expected in product sitemap",
    summary: "Product should appear in product sitemap XML after save.",
    value: "/sitemap-products.xml",
  };
}

function buildFeedStatus({
  discovery,
  isActive,
  canonical,
  availability,
  feedImage,
  absoluteStorefrontUrl,
  excludeFromProductFeed,
}: {
  discovery: SeoDiscoverySettings;
  isActive: boolean;
  canonical: ProductSeoDiagnostics["canonical"];
  availability: ProductSeoAvailabilityStatus;
  feedImage: ProductSeoDiagnostics["feedImage"];
  absoluteStorefrontUrl: URL | null;
  excludeFromProductFeed: boolean;
}): ProductSeoDiagnostics["feed"] {
  const feeds = discovery.feeds;

  if (!feeds.productCatalogEnabled) {
    return {
      tone: "disabled",
      title: "Product feed off",
      summary: "The catalog feed XML is disabled globally.",
      inclusion: "disabled",
      skippedReason: "Global product feed is off.",
    };
  }

  if (!canonical.path) {
    return {
      tone: "draft",
      title: "Feed pending",
      summary: "Feed inclusion can be estimated after a valid product slug.",
      inclusion: "draft",
      skippedReason: null,
    };
  }

  if (excludeFromProductFeed) {
    return {
      tone: "disabled",
      title: "Excluded from product feed",
      summary:
        "The product page stays public, but this product is removed from catalog feed XML.",
      inclusion: "skipped",
      skippedReason: "Product feed exclusion is on.",
    };
  }

  if (!isActive) {
    return {
      tone: "draft",
      title: "Skipped while draft",
      summary: "Inactive products do not enter catalog feed XML.",
      inclusion: "skipped",
      skippedReason: "Product is inactive.",
    };
  }

  if (!absoluteStorefrontUrl) {
    return {
      tone: "warning",
      title: "Feed needs Store URL",
      summary: "Catalog XML requires an absolute Store URL for product links.",
      inclusion: "conditional",
      skippedReason: "Store URL is not absolute.",
    };
  }

  if (availability.canResolveBuyerSku === false) {
    return {
      tone: "warning",
      title: "Skipped until SKU exists",
      summary: "Catalog feed uses buyer-resolvable SKU availability.",
      inclusion: "skipped",
      skippedReason: "No buyer-resolvable SKU.",
    };
  }

  if (feedImage.tone === "warning" || feedImage.imageUrl === null) {
    return {
      tone: feedImage.tone === "draft" ? "draft" : "warning",
      title: "Skipped until image is ready",
      summary: "Feed XML skips products without an http(s) primary image.",
      inclusion: "skipped",
      skippedReason: "Missing or invalid primary image.",
    };
  }

  if (
    availability.availableForSale === false &&
    !feeds.includeUnavailableProducts
  ) {
    return {
      tone: "warning",
      title: "Skipped while sold out",
      summary: "Global feed policy excludes unavailable products.",
      inclusion: "skipped",
      skippedReason: "Sold-out products are excluded.",
    };
  }

  if (availability.availableForSale === false) {
    return {
      tone: "info",
      title: "Included as out of stock",
      summary: "Sold-out inclusion is on, so the feed can mark it out of stock.",
      inclusion: "included",
      skippedReason: null,
    };
  }

  if (availability.availableForSale === null) {
    return {
      tone: "info",
      title: "Feed depends on saved SKU",
      summary: feeds.includeUnavailableProducts
        ? "Expected once the product has a buyer-resolvable SKU and image."
        : "Expected only when the saved SKU is available for sale.",
      inclusion: "conditional",
      skippedReason: null,
    };
  }

  return {
    tone: "ok",
    title: "Expected in product feed",
    summary: "Catalog XML should include this product as in stock.",
    value: "/api/product-feed.xml",
    inclusion: "included",
    skippedReason: null,
  };
}

function buildStructuredDataStatus({
  discovery,
  isActive,
  canonical,
  absoluteStorefrontUrl,
  noIndex,
}: {
  discovery: SeoDiscoverySettings;
  isActive: boolean;
  canonical: ProductSeoDiagnostics["canonical"];
  absoluteStorefrontUrl: URL | null;
  noIndex: boolean;
}): ProductSeoDiagnostics["structuredData"] {
  const productsEnabled = discovery.structuredData.products;
  const breadcrumbsEnabled = discovery.structuredData.breadcrumbs;

  if (!productsEnabled && !breadcrumbsEnabled) {
    return {
      tone: "disabled",
      title: "Product JSON-LD off",
      summary: "Product and Breadcrumb JSON-LD are disabled globally.",
      productsEnabled,
      breadcrumbsEnabled,
    };
  }

  if (noIndex) {
    return {
      tone: "disabled",
      title: "JSON-LD off while noindexed",
      summary: "Public product schema is suppressed because search indexing is prevented.",
      productsEnabled: false,
      breadcrumbsEnabled: false,
    };
  }

  if (!canonical.path) {
    return {
      tone: "draft",
      title: "JSON-LD pending",
      summary: "Structured data preview needs a valid product slug.",
      productsEnabled,
      breadcrumbsEnabled,
    };
  }

  if (!isActive) {
    return {
      tone: "draft",
      title: "JSON-LD waits for public page",
      summary: "Product page schema emits only when the product page is public.",
      productsEnabled,
      breadcrumbsEnabled,
    };
  }

  if (!absoluteStorefrontUrl) {
    return {
      tone: "warning",
      title: "JSON-LD needs Store URL",
      summary: "Product and Breadcrumb URL fields require an absolute Store URL.",
      productsEnabled,
      breadcrumbsEnabled,
    };
  }

  return {
    tone: productsEnabled && breadcrumbsEnabled ? "ok" : "info",
    title:
      productsEnabled && breadcrumbsEnabled
        ? "Product + Breadcrumb JSON-LD on"
        : "Partial product JSON-LD on",
    summary: [
      productsEnabled ? "Product schema on" : "Product schema off",
      breadcrumbsEnabled ? "Breadcrumbs on" : "Breadcrumbs off",
    ].join("; "),
    productsEnabled,
    breadcrumbsEnabled,
  };
}

export function buildProductSeoDiagnostics({
  product,
  variants,
  variantState = "unavailable",
  discovery,
  storefrontUrl,
  policySource = "current",
}: ProductSeoDiagnosticsInput): ProductSeoDiagnostics {
  const normalizedDiscovery = normalizeSeoDiscoverySettings(discovery);
  const absoluteStorefrontUrl = parseAbsoluteHttpUrl(storefrontUrl);
  const slug = normalizeSlug(product.slug);
  const isActive = product.isActive === true;
  const noIndex = product.noIndex === true;
  const excludeFromSitemap = product.excludeFromSitemap === true;
  const excludeFromProductFeed = product.excludeFromProductFeed === true;
  const availability = buildAvailabilityStatus(variants, variantState);
  const canonical = buildCanonicalStatus({
    slug,
    canonicalPath: product.canonicalPath,
    absoluteStorefrontUrl,
  });
  const feedImage = buildFeedImageStatus({
    imageUrl: pickProductImageRepresentation(product.media),
    hasCanonicalDraft: !canonical.path,
    absoluteStorefrontUrl,
    isActive,
  });

  return {
    policy: {
      source: policySource,
      label:
        policySource === "current"
          ? "Current SEO policy"
          : "Default SEO policy",
      summary:
        policySource === "current"
          ? "Using the cached dashboard discovery settings."
          : "Using default discovery settings until SEO settings are loaded.",
    },
    canonical,
    sitemap: buildSitemapStatus({
      discovery: normalizedDiscovery,
      isActive,
      canonical,
      availability,
      absoluteStorefrontUrl,
      noIndex,
      excludeFromSitemap,
    }),
    feedImage,
    feed: buildFeedStatus({
      discovery: normalizedDiscovery,
      isActive,
      canonical,
      availability,
      feedImage,
      absoluteStorefrontUrl,
      excludeFromProductFeed,
    }),
    structuredData: buildStructuredDataStatus({
      discovery: normalizedDiscovery,
      isActive,
      canonical,
      absoluteStorefrontUrl,
      noIndex,
    }),
    availability,
    discovery: normalizedDiscovery,
  };
}
