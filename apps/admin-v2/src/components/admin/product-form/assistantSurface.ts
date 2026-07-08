import { sanitizeAdminAssistantText } from "../assistant/page-state";

const PRODUCT_ROUTE_PATTERN = /^\/products\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_EXCERPT_LENGTH = 72;

export interface ProductAssistantSurfaceDraft {
  mode: "create" | "edit";
  name?: unknown;
  description?: unknown;
  isActive?: unknown;
  slug?: unknown;
  canonicalPath?: unknown;
  noIndex?: unknown;
  excludeFromSitemap?: unknown;
  excludeFromProductFeed?: unknown;
}

export function buildProductAssistantSurfaceLabel(
  draft: ProductAssistantSurfaceDraft,
): string {
  const modeLabel = draft.mode === "edit" ? "Edit product" : "Create product";
  const title = sanitizeAdminAssistantText(draft.name, 64) ?? "Untitled product";
  const status = draft.isActive === false ? "Draft" : "Active";
  const route = resolveProductRouteFact(draft.slug, draft.canonicalPath);
  const discovery = resolveDiscoveryFacts(draft);
  const description = extractPlainTextExcerpt(
    draft.description,
    DESCRIPTION_EXCERPT_LENGTH,
  );

  const parts = [
    modeLabel,
    `title: ${title}`,
    `status: ${status}`,
    `route: ${route}`,
    description ? `description: ${description}` : null,
    discovery ? `discovery: ${discovery}` : null,
  ];

  return (
    sanitizeAdminAssistantText(parts.filter(Boolean).join(" | ")) ?? modeLabel
  );
}

export function countProductAssistantValidationErrors(value: unknown): number {
  if (!value || typeof value !== "object") return 0;

  let count = 0;
  for (const entry of Object.values(value)) {
    if (!entry) continue;
    if (Array.isArray(entry)) {
      count += entry.reduce(
        (total, item) => total + countProductAssistantValidationErrors(item),
        0,
      );
      continue;
    }
    if (typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;
    if (typeof record.message === "string" || typeof record.type === "string") {
      count += 1;
      continue;
    }
    count += countProductAssistantValidationErrors(record);
  }

  return count;
}

function resolveProductRouteFact(
  slugValue: unknown,
  canonicalPathValue: unknown,
): string {
  const canonicalPath =
    typeof canonicalPathValue === "string" ? canonicalPathValue.trim() : "";
  if (PRODUCT_ROUTE_PATTERN.test(canonicalPath)) return canonicalPath;

  const slug = typeof slugValue === "string" ? slugValue.trim() : "";
  if (PRODUCT_SLUG_PATTERN.test(slug)) return `/products/${slug}`;

  return "pending";
}

function resolveDiscoveryFacts(
  draft: ProductAssistantSurfaceDraft,
): string | null {
  const facts = [
    draft.noIndex === true ? "noindex" : null,
    draft.excludeFromSitemap === true ? "not in sitemap" : null,
    draft.excludeFromProductFeed === true ? "not in product feed" : null,
  ].filter(Boolean);

  return facts.length > 0 ? facts.join(", ") : null;
}

function extractPlainTextExcerpt(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;

  const withoutScripts = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]*>/g, " ");
  const decoded = decodeCommonHtmlEntities(withoutTags).replace(
    /\s+([.,!?;:])/g,
    "$1",
  );

  return sanitizeAdminAssistantText(decoded, maxLength);
}

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}
