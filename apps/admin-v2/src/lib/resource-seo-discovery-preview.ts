import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import {
  isValidResourceCanonicalPath,
  normalizeCanonicalPathInput,
} from "@scalius/shared/seo-canonical";

export type ResourceDiscoveryKind = "category" | "collection" | "page";
export type ResourceDiscoveryTone =
  | "ok"
  | "warning"
  | "disabled"
  | "draft"
  | "info";
export type ResourceDiscoveryPolicySource = "current" | "default";

export interface ResourceDiscoveryRow {
  tone: ResourceDiscoveryTone;
  title: string;
  summary: string;
  value?: string;
}

export interface ResourceDiscoveryPreviewInput {
  kind: ResourceDiscoveryKind;
  slug?: string | null;
  id?: string | null;
  canonicalPath?: string | null;
  noIndex?: boolean | null;
  excludeFromSitemap?: boolean | null;
  isPublished?: boolean | null;
  isActive?: boolean | null;
  discovery?: unknown;
  storefrontUrl?: string | null;
  policySource?: ResourceDiscoveryPolicySource;
}

export interface ResourceDiscoveryPreview {
  policy: {
    source: ResourceDiscoveryPolicySource;
    label: string;
    summary: string;
  };
  copy: {
    subject: string;
    schemaLabel: string;
  };
  canonical: ResourceDiscoveryRow & {
    path: string | null;
    url: string | null;
  };
  sitemap: ResourceDiscoveryRow;
  structuredData: ResourceDiscoveryRow;
}

const RESOURCE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESOURCE_COPY: Record<
  ResourceDiscoveryKind,
  {
    subject: string;
    urlName: string;
    slugMissing: string;
    sitemapKey: keyof SeoDiscoverySettings["sitemap"];
    sitemapPath: string;
    sitemapOffTitle: string;
    sitemapOffSummary: string;
    sitemapReadyTitle: string;
    sitemapReadySummary: string;
    sitemapExcludedTitle: string;
    sitemapExcludedSummary: string;
    noIndexSitemapSummary: string;
    schemaLabel: string;
  }
> = {
  category: {
    subject: "category",
    urlName: "category",
    slugMissing: "Set a category slug to preview the public category URL.",
    sitemapKey: "categories",
    sitemapPath: "/sitemap-categories.xml",
    sitemapOffTitle: "Category sitemap off",
    sitemapOffSummary: "The category sitemap section is disabled globally.",
    sitemapReadyTitle: "Expected in category sitemap",
    sitemapReadySummary:
      "Category should appear in category sitemap XML after save.",
    sitemapExcludedTitle: "Excluded from category sitemap",
    sitemapExcludedSummary:
      "The category page stays public, but this category is removed from category sitemap XML.",
    noIndexSitemapSummary:
      "The category page stays public, but it is removed from category sitemap XML while search indexing is prevented.",
    schemaLabel: "Category JSON-LD",
  },
  collection: {
    subject: "collection",
    urlName: "collection",
    slugMissing: "Save the collection once to preview the public collection URL.",
    sitemapKey: "collections",
    sitemapPath: "/sitemap-collections.xml",
    sitemapOffTitle: "Collections sitemap off",
    sitemapOffSummary: "The collections sitemap section is disabled globally.",
    sitemapReadyTitle: "Expected in collections sitemap",
    sitemapReadySummary:
      "Collection should appear in collections sitemap XML after save.",
    sitemapExcludedTitle: "Excluded from collection sitemap",
    sitemapExcludedSummary:
      "The collection page stays public while active, but this collection is removed from collections sitemap XML.",
    noIndexSitemapSummary:
      "The collection page stays public while active, but it is removed from collections sitemap XML while search indexing is prevented.",
    schemaLabel: "Collection JSON-LD",
  },
  page: {
    subject: "CMS page",
    urlName: "page",
    slugMissing: "Set a page slug to preview the public page URL.",
    sitemapKey: "pages",
    sitemapPath: "/sitemap-pages.xml",
    sitemapOffTitle: "Pages sitemap off",
    sitemapOffSummary: "The CMS pages sitemap section is disabled globally.",
    sitemapReadyTitle: "Expected in pages sitemap",
    sitemapReadySummary:
      "CMS page should appear in pages sitemap XML after save.",
    sitemapExcludedTitle: "Excluded from pages sitemap",
    sitemapExcludedSummary:
      "The page stays public when published, but this page is removed from pages sitemap XML.",
    noIndexSitemapSummary:
      "The page stays public when published, but it is removed from pages sitemap XML while search indexing is prevented.",
    schemaLabel: "Page JSON-LD",
  },
};

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

function getDefaultPath(input: ResourceDiscoveryPreviewInput): string | null {
  if (input.kind === "collection") {
    const id = input.id?.trim();
    return id ? `/collections/${encodeURIComponent(id)}` : null;
  }

  const slug = normalizeSlug(input.slug);
  if (!slug) return null;
  return input.kind === "category" ? `/categories/${slug}` : `/${slug}`;
}

function hasValidSlug(input: ResourceDiscoveryPreviewInput): boolean {
  if (input.kind === "collection") return Boolean(input.id?.trim());
  const slug = normalizeSlug(input.slug);
  return Boolean(slug && RESOURCE_SLUG_PATTERN.test(slug));
}

function isPublicAfterSave(input: ResourceDiscoveryPreviewInput): boolean {
  if (input.kind === "collection") return input.isActive === true;
  if (input.kind === "page") return input.isPublished === true;
  return true;
}

function publicDraftSummary(kind: ResourceDiscoveryKind): string {
  if (kind === "collection") {
    return "Inactive collections stay out of public discovery surfaces.";
  }
  if (kind === "page") {
    return "Unpublished CMS pages are not public discovery targets.";
  }
  return "";
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function buildCanonicalStatus(
  input: ResourceDiscoveryPreviewInput,
  absoluteStorefrontUrl: URL | null,
): ResourceDiscoveryPreview["canonical"] {
  const copy = RESOURCE_COPY[input.kind];
  const defaultPath = getDefaultPath(input);

  if (!defaultPath) {
    return {
      tone: "draft",
      title: "Canonical path pending",
      summary: copy.slugMissing,
      path: null,
      url: null,
    };
  }

  if (!hasValidSlug(input)) {
    return {
      tone: "warning",
      title: "Canonical slug needs cleanup",
      summary: "The saved URL expects lowercase words separated by hyphens.",
      value: normalizeSlug(input.slug),
      path: null,
      url: null,
    };
  }

  const normalizedCanonicalPath = normalizeCanonicalPathInput(
    input.canonicalPath,
  );
  if (
    normalizedCanonicalPath &&
    !isValidResourceCanonicalPath(input.kind, normalizedCanonicalPath)
  ) {
    return {
      tone: "warning",
      title: "Canonical path needs cleanup",
      summary:
        "Use a reachable same-store route for this resource without query strings, " +
        "fragments, spaces, or another domain.",
      value: normalizedCanonicalPath,
      path: null,
      url: null,
    };
  }

  const path = normalizedCanonicalPath ?? defaultPath;
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
      ? `${capitalize(copy.urlName)} page should point search engines to this same-store canonical path after save.`
      : url
        ? `${capitalize(copy.urlName)} page should use this absolute canonical URL after save.`
        : "Full canonical URLs need an absolute Store URL setting.",
    value: url ?? path,
    path,
    url,
  };
}

function buildSitemapStatus({
  input,
  discovery,
  canonical,
  absoluteStorefrontUrl,
}: {
  input: ResourceDiscoveryPreviewInput;
  discovery: SeoDiscoverySettings;
  canonical: ResourceDiscoveryPreview["canonical"];
  absoluteStorefrontUrl: URL | null;
}): ResourceDiscoveryRow {
  const copy = RESOURCE_COPY[input.kind];
  if (!canonical.path) {
    return {
      tone: "draft",
      title: "Sitemap pending",
      summary: `${capitalize(copy.urlName)} sitemap inclusion can be estimated after a valid URL.`,
    };
  }

  if (!discovery.sitemap.enabled) {
    return {
      tone: "disabled",
      title: "Sitemap off",
      summary: "The global sitemap index is disabled in SEO discovery.",
    };
  }

  if (!discovery.sitemap[copy.sitemapKey]) {
    return {
      tone: "disabled",
      title: copy.sitemapOffTitle,
      summary: copy.sitemapOffSummary,
    };
  }

  if (input.noIndex === true) {
    return {
      tone: "disabled",
      title: "Noindexed",
      summary: copy.noIndexSitemapSummary,
    };
  }

  if (input.excludeFromSitemap === true) {
    return {
      tone: "disabled",
      title: copy.sitemapExcludedTitle,
      summary: copy.sitemapExcludedSummary,
    };
  }

  if (!isPublicAfterSave(input)) {
    return {
      tone: "draft",
      title:
        input.kind === "collection"
          ? "Not in sitemap while inactive"
          : "Not in sitemap while draft",
      summary: publicDraftSummary(input.kind),
    };
  }

  if (!absoluteStorefrontUrl) {
    return {
      tone: "warning",
      title: "Sitemap needs Store URL",
      summary: "Generated sitemap XML requires an absolute Store URL.",
    };
  }

  return {
    tone: "ok",
    title: copy.sitemapReadyTitle,
    summary: copy.sitemapReadySummary,
    value: copy.sitemapPath,
  };
}

function buildStructuredDataStatus({
  input,
  discovery,
  canonical,
  absoluteStorefrontUrl,
}: {
  input: ResourceDiscoveryPreviewInput;
  discovery: SeoDiscoverySettings;
  canonical: ResourceDiscoveryPreview["canonical"];
  absoluteStorefrontUrl: URL | null;
}): ResourceDiscoveryRow {
  if (input.kind === "page") {
    if (input.noIndex === true) {
      return {
        tone: "disabled",
        title: "Schema suppressed while noindexed",
        summary:
          "Resource/page-specific JSON-LD is suppressed because search indexing is prevented.",
      };
    }

    if (!canonical.path) {
      return {
        tone: "draft",
        title: "Schema status pending",
        summary: "Schema status can be estimated after a valid page URL.",
      };
    }

    if (!isPublicAfterSave(input)) {
      return {
        tone: "draft",
        title: "No schema while draft",
        summary: publicDraftSummary(input.kind),
      };
    }

    return {
      tone: "info",
      title: "No page JSON-LD emitted",
      summary:
        "CMS pages rely on canonical, meta, and Open Graph tags; no page-specific JSON-LD is emitted today.",
    };
  }

  const collectionSchemaEnabled = discovery.structuredData.collections;
  const breadcrumbsEnabled = discovery.structuredData.breadcrumbs;

  if (!collectionSchemaEnabled && !breadcrumbsEnabled) {
    return {
      tone: "disabled",
      title: "CollectionPage JSON-LD off",
      summary: "CollectionPage and Breadcrumb JSON-LD are disabled globally.",
    };
  }

  if (input.noIndex === true) {
    return {
      tone: "disabled",
      title: "JSON-LD off while noindexed",
      summary:
        "CollectionPage and Breadcrumb JSON-LD are suppressed because search indexing is prevented.",
    };
  }

  if (!canonical.path) {
    return {
      tone: "draft",
      title: "JSON-LD pending",
      summary: "Structured data preview needs a public URL.",
    };
  }

  if (!isPublicAfterSave(input)) {
    return {
      tone: "draft",
      title: "JSON-LD waits for public page",
      summary: publicDraftSummary(input.kind),
    };
  }

  if (!absoluteStorefrontUrl) {
    return {
      tone: "warning",
      title: "JSON-LD needs Store URL",
      summary:
        "CollectionPage and Breadcrumb URL fields require an absolute Store URL.",
    };
  }

  return {
    tone: collectionSchemaEnabled && breadcrumbsEnabled ? "ok" : "info",
    title:
      collectionSchemaEnabled && breadcrumbsEnabled
        ? "CollectionPage + Breadcrumb JSON-LD on"
        : "Partial JSON-LD on",
    summary: [
      collectionSchemaEnabled ? "CollectionPage schema on" : "CollectionPage schema off",
      breadcrumbsEnabled ? "Breadcrumbs on" : "Breadcrumbs off",
    ].join("; "),
  };
}

export function buildResourceDiscoveryPreview(
  input: ResourceDiscoveryPreviewInput,
): ResourceDiscoveryPreview {
  const discovery = normalizeSeoDiscoverySettings(input.discovery);
  const absoluteStorefrontUrl = parseAbsoluteHttpUrl(input.storefrontUrl);
  const canonical = buildCanonicalStatus(input, absoluteStorefrontUrl);
  const policySource = input.policySource ?? "current";

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
    copy: RESOURCE_COPY[input.kind],
    canonical,
    sitemap: buildSitemapStatus({
      input,
      discovery,
      canonical,
      absoluteStorefrontUrl,
    }),
    structuredData: buildStructuredDataStatus({
      input,
      discovery,
      canonical,
      absoluteStorefrontUrl,
    }),
  };
}
