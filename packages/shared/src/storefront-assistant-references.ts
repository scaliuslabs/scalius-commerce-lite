export const STOREFRONT_ASSISTANT_CATALOG_REFERENCE_PREFIX =
  "[[scalius.catalog_refs.v1|";
export const STOREFRONT_ASSISTANT_MAX_CATALOG_REFERENCES = 5;

const CATALOG_REFERENCE_SUFFIX = "]]";
const PUBLIC_PRODUCT_GID_PATTERN =
  /^gid:\/\/scalius\/product\/[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$/;

export interface StorefrontAssistantCatalogReferenceSplit {
  content: string;
  productIds: string[];
}

export function isStorefrontAssistantPublicProductGid(
  value: unknown,
): value is string {
  return typeof value === "string" && PUBLIC_PRODUCT_GID_PATTERN.test(value);
}

export function normalizeStorefrontAssistantCatalogProductIds(
  values: readonly unknown[],
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isStorefrontAssistantPublicProductGid(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
    if (output.length >= STOREFRONT_ASSISTANT_MAX_CATALOG_REFERENCES) break;
  }
  return output;
}

export function storefrontAssistantCatalogReferenceFooter(
  productIds: readonly unknown[],
): string | null {
  const normalized = normalizeStorefrontAssistantCatalogProductIds(productIds);
  return normalized.length > 0
    ? `${STOREFRONT_ASSISTANT_CATALOG_REFERENCE_PREFIX}${normalized.join("|")}${CATALOG_REFERENCE_SUFFIX}`
    : null;
}

export function appendStorefrontAssistantCatalogReferences(
  content: string,
  productIds: readonly unknown[],
  maxChars: number,
): string {
  const footer = storefrontAssistantCatalogReferenceFooter(productIds);
  const normalizedContent = content.trim();
  if (!footer || footer.length + 1 >= maxChars) {
    return normalizedContent.slice(0, maxChars).trimEnd();
  }
  const visibleLimit = maxChars - footer.length - 1;
  const visible = normalizedContent.slice(0, visibleLimit).trimEnd();
  return visible ? `${visible}\n${footer}` : footer;
}

export function splitStorefrontAssistantCatalogReferences(
  value: string,
): StorefrontAssistantCatalogReferenceSplit {
  const firstMarker = value.indexOf(STOREFRONT_ASSISTANT_CATALOG_REFERENCE_PREFIX);
  if (firstMarker < 0) {
    return { content: value, productIds: [] };
  }

  const visibleContent = value.slice(0, firstMarker).trimEnd();
  const marker = value.slice(firstMarker);
  if (
    marker.indexOf(STOREFRONT_ASSISTANT_CATALOG_REFERENCE_PREFIX, 1) >= 0 ||
    !marker.endsWith(CATALOG_REFERENCE_SUFFIX) ||
    (firstMarker > 0 && value[firstMarker - 1] !== "\n")
  ) {
    return { content: visibleContent, productIds: [] };
  }

  const body = marker.slice(
    STOREFRONT_ASSISTANT_CATALOG_REFERENCE_PREFIX.length,
    -CATALOG_REFERENCE_SUFFIX.length,
  );
  const candidates = body.split("|");
  if (
    candidates.length < 1 ||
    candidates.length > STOREFRONT_ASSISTANT_MAX_CATALOG_REFERENCES ||
    candidates.some((candidate) =>
      !isStorefrontAssistantPublicProductGid(candidate)
    ) ||
    new Set(candidates).size !== candidates.length
  ) {
    return { content: visibleContent, productIds: [] };
  }
  return { content: visibleContent, productIds: candidates };
}
