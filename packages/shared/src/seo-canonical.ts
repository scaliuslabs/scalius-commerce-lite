export const CANONICAL_PATH_MAX_LENGTH = 2048;

export type CanonicalResourceKind =
  "product" | "category" | "collection" | "article" | "page";

const CANONICAL_SLUG_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CANONICAL_COLLECTION_SEGMENT_PATTERN =
  /^(?:col_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{18,32})$/;
const RESERVED_PAGE_CANONICAL_SEGMENTS = new Set([
  "account",
  "admin",
  "api",
  "buy",
  "blog",
  "cart",
  "categories",
  "checkout",
  "collections",
  "health",
  "404",
  "500",
  "order-success",
  "payment-recovery",
  "products",
  "robots.txt",
  "search",
  "sitemap.xml",
]);

export function normalizeCanonicalPathInput(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function isValidCanonicalPath(value: string): boolean {
  if (!value || value.length > CANONICAL_PATH_MAX_LENGTH) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("?") || value.includes("#")) {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return false;
  }

  try {
    const parsed = new URL(value, "https://store.example");
    return (
      parsed.origin === "https://store.example" &&
      parsed.pathname === value &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function normalizeCanonicalPath(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeCanonicalPathInput(value);
  if (!normalized) return null;
  return isValidCanonicalPath(normalized) ? normalized : null;
}

function getResourceCanonicalSegment(
  kind: CanonicalResourceKind,
  value: string,
): string | null {
  if (kind === "page") {
    if (!value.startsWith("/")) return null;
    const segment = value.slice(1);
    return segment && !segment.includes("/") ? segment : null;
  }

  const prefix =
    kind === "article"
      ? "/blog/"
      : `/${kind === "category" ? "categories" : `${kind}s`}/`;
  if (!value.startsWith(prefix)) return null;

  const segment = value.slice(prefix.length);
  return segment && !segment.includes("/") ? segment : null;
}

export function getResourceCanonicalPathSegment(
  kind: CanonicalResourceKind,
  value: string,
): string | null {
  if (!isValidResourceCanonicalPath(kind, value)) return null;
  return getResourceCanonicalSegment(kind, value);
}

export function isValidResourceCanonicalPath(
  kind: CanonicalResourceKind,
  value: string,
): boolean {
  if (!isValidCanonicalPath(value)) return false;

  const segment = getResourceCanonicalSegment(kind, value);
  if (!segment) return false;
  if (kind === "collection") {
    return CANONICAL_COLLECTION_SEGMENT_PATTERN.test(segment);
  }
  if (!CANONICAL_SLUG_SEGMENT_PATTERN.test(segment)) return false;

  return kind !== "page" || !RESERVED_PAGE_CANONICAL_SEGMENTS.has(segment);
}

export function normalizeResourceCanonicalPath(
  kind: CanonicalResourceKind,
  value: string | null | undefined,
): string | null {
  const normalized = normalizeCanonicalPathInput(value);
  if (!normalized) return null;
  return isValidResourceCanonicalPath(kind, normalized) ? normalized : null;
}
