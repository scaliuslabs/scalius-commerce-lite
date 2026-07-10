import { redactAssistantSensitiveText } from "@scalius/shared/assistant-redaction";
import {
  BLOCKED_BUYER_PATH_SEGMENTS,
  ENCODED_UNSAFE_PATH_PATTERN,
  NAVIGATION_TARGET_PATTERN,
  RAW_PATH_TRAVERSAL_PATTERN,
  RESERVED_CMS_PAGE_SLUGS,
  SAFE_PATH_SEGMENT_PATTERN,
  SAFE_QUERY_KEY_PATTERN,
  SENSITIVE_QUERY_NAME_PATTERN,
  STOREFRONT_CHAT_MAX_NAVIGATION_ACTIONS,
  TOKEN_LIKE_VALUE_PATTERN,
  compactStorefrontChatText,
  isJsonRecord,
  latestUserChatText,
  type JsonRecord,
  type StorefrontChatAssistantText,
  type StorefrontChatMessage,
  type StorefrontChatPayload,
  type StorefrontChatPublicTool,
  type StorefrontMcpContext,
  type StorefrontNavigateAction,
} from "./storefront-chat-contract";
import type { StorefrontChatIntent } from "./storefront-chat-intent";

const BUYER_QUERY_STOP_WORDS = new Set([
  "a",
  "about",
  "am",
  "an",
  "and",
  "any",
  "are",
  "at",
  "available",
  "availability",
  "browse",
  "can",
  "catalog",
  "cart",
  "categories",
  "category",
  "check",
  "choose",
  "compare",
  "collection",
  "collections",
  "could",
  "do",
  "does",
  "find",
  "for",
  "go",
  "got",
  "have",
  "help",
  "here",
  "how",
  "i",
  "in",
  "is",
  "it",
  "jump",
  "look",
  "looking",
  "me",
  "my",
  "navigate",
  "need",
  "of",
  "open",
  "page",
  "please",
  "product",
  "products",
  "recommend",
  "search",
  "send",
  "sell",
  "sells",
  "show",
  "shop",
  "shopping",
  "some",
  "store",
  "storefront",
  "stock",
  "take",
  "tell",
  "the",
  "there",
  "this",
  "to",
  "want",
  "visit",
  "view",
  "what",
  "where",
  "which",
  "would",
  "you",
  "your",
]);

export function searchQueryFromMessages(
  messages: StorefrontChatMessage[],
): string | null {
  const latest = compactStorefrontChatText(latestUserChatText(messages), 160);
  if (!latest || latest.length < 2) return null;
  if (
    /\b(?:checkout|account|order|payment|recovery|receipt|admin|api|otp|password|login)\b/i.test(
      latest,
    )
  ) {
    return null;
  }
  const terms = Array.from(latest, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/[?!.;,()[\]{}:]+/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .filter((term) => !BUYER_QUERY_STOP_WORDS.has(term.toLowerCase()))
    .slice(0, 8);
  return compactStorefrontChatText(terms.join(" "), 120);
}

export function hasCategoryIntent(
  text: string,
  pageContext: StorefrontChatPayload["pageContext"],
): boolean {
  return (
    pageContext?.surface?.kind === "category" ||
    pageContext?.page?.kind === "category" ||
    /\b(?:categor(?:y|ies)|departments?|browse)\b/i.test(text)
  );
}

export function getStorefrontOrigin(env: Env): string | null {
  const configured = env.STOREFRONT_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function cleanNavigationTargetText(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  if (!value || value.length > maxLength || value !== value.trim()) return null;
  return value;
}

export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function isSafePathSegment(segment: string): boolean {
  if (
    !segment ||
    segment.length > 160 ||
    !SAFE_PATH_SEGMENT_PATTERN.test(segment)
  ) {
    return false;
  }
  const decoded = decodePathSegment(segment);
  return Boolean(
    decoded &&
    decoded === segment &&
    decoded !== "." &&
    decoded !== ".." &&
    !hasControlCharacter(decoded) &&
    !TOKEN_LIKE_VALUE_PATTERN.test(decoded),
  );
}

export function getPathSegments(pathname: string): string[] | null {
  if (
    !pathname.startsWith("/") ||
    pathname.includes("\\") ||
    ENCODED_UNSAFE_PATH_PATTERN.test(pathname)
  ) {
    return null;
  }
  const segments = pathname.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => !segment))
    return null;
  return segments.every(isSafePathSegment) ? segments : null;
}

export function hasBlockedBuyerPathSegment(segments: string[]): boolean {
  return segments.some((segment) =>
    BLOCKED_BUYER_PATH_SEGMENTS.has(segment.toLowerCase()),
  );
}

export function isSafeCatalogPath(pathname: string, prefix: string): boolean {
  const prefixPath = `/${prefix}/`;
  if (!pathname.startsWith(prefixPath)) return false;
  const segments = getPathSegments(pathname);
  if (!segments || segments[0] !== prefix) return false;
  const rest = segments.slice(1);
  return rest.length > 0 && !hasBlockedBuyerPathSegment(rest);
}

export function isSafeCmsPagePath(pathname: string): boolean {
  const segments = getPathSegments(pathname);
  if (!segments || segments.length !== 1) return false;
  return !RESERVED_CMS_PAGE_SLUGS.has(segments[0]!.toLowerCase());
}

export function hasSensitiveQueryValue(value: string): boolean {
  return (
    TOKEN_LIKE_VALUE_PATTERN.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) ||
    /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/.test(value) ||
    /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/.test(value)
  );
}

export function isSafeSearchQuery(
  search: string,
  params: URLSearchParams,
): boolean {
  if (search.length > 512) return false;
  const entries = Array.from(params.entries());
  if (entries.length > 20) return false;
  return entries.every(([key, value]) => {
    return Boolean(
      key &&
      key.length <= 64 &&
      value.length <= 180 &&
      !hasControlCharacter(key) &&
      !hasControlCharacter(value) &&
      SAFE_QUERY_KEY_PATTERN.test(key) &&
      !SENSITIVE_QUERY_NAME_PATTERN.test(key) &&
      !hasSensitiveQueryValue(value),
    );
  });
}

export function isAllowedBuyerNavigationUrl(url: URL): boolean {
  if (url.hash || url.username || url.password) return false;
  if (url.pathname === "/cart") return url.search === "";
  if (url.pathname === "/search")
    return isSafeSearchQuery(url.search, url.searchParams);
  if (url.search) return false;
  return (
    isSafeCatalogPath(url.pathname, "products") ||
    isSafeCatalogPath(url.pathname, "categories") ||
    isSafeCatalogPath(url.pathname, "collections") ||
    isSafeCmsPagePath(url.pathname)
  );
}

export function resolveStorefrontNavigationTarget(
  target: unknown,
  origin: string | null,
): string | null {
  const text = cleanNavigationTargetText(target, 2048);
  if (!text) return null;
  if (
    text !== text.trim() ||
    hasControlCharacter(text) ||
    text.startsWith("//") ||
    text.includes("\\") ||
    RAW_PATH_TRAVERSAL_PATTERN.test(text) ||
    ENCODED_UNSAFE_PATH_PATTERN.test(text)
  ) {
    return null;
  }

  const absolute = /^https?:\/\//i.test(text);
  if (!text.startsWith("/") && !absolute) return null;
  if (absolute && !origin) return null;

  let url: URL;
  try {
    url = new URL(text, origin ?? "https://storefront.invalid");
  } catch {
    return null;
  }

  if (absolute && url.origin !== origin) return null;
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isAllowedBuyerNavigationUrl(url)
  ) {
    return null;
  }
  return `${url.pathname}${url.search}`;
}

export function sanitizeNavigationTargetsInText(
  text: string,
  origin: string | null,
): string {
  return text.replace(NAVIGATION_TARGET_PATTERN, (rawTarget) => {
    const trailing = rawTarget.match(/[),.;:!?]+$/)?.[0] ?? "";
    const target = trailing ? rawTarget.slice(0, -trailing.length) : rawTarget;
    if (resolveStorefrontNavigationTarget(target, origin)) return rawTarget;
    return `[unsupported navigation target]${trailing}`;
  });
}

export function stripProviderToolCallSections(value: string): string {
  return value
    .replace(
      /<\|tool_calls_section_begin\|>[\s\S]*?(?:<\|tool_calls_section_end\|>|$)/gi,
      " ",
    )
    .replace(/<\|tool_call_begin\|>[\s\S]*?(?:<\|tool_call_end\|>|$)/gi, " ")
    .replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, " ")
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, " ")
    .replace(/<\|[^|>]*(?:tool|function)[^|>]*\|>/gi, " ");
}

export function containsProviderToolCallArtifact(value: string): boolean {
  return (
    /<\|[^|>]*(?:tool|function)[^|>]*\|>/i.test(value) ||
    /<\/?(?:tool_calls?|function_call)\b/i.test(value) ||
    /"(?:tool_calls|function_call)"\s*:/i.test(value) ||
    /\bfunctions\.[A-Za-z0-9_.:-]+\b/i.test(value)
  );
}

export function normalizeAssistantWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeStorefrontAssistantText(
  rawText: string,
  origin: string | null,
): StorefrontChatAssistantText {
  const normalized = normalizeAssistantWhitespace(
    redactAssistantSensitiveText(rawText),
  );
  const withoutToolSections = normalizeAssistantWhitespace(
    stripProviderToolCallSections(normalized),
  );
  if (
    !withoutToolSections ||
    containsProviderToolCallArtifact(normalized) ||
    containsProviderToolCallArtifact(withoutToolSections)
  ) {
    return {
      text: "I can help with public catalog browsing, product questions, and safe cart availability checks, but I cannot perform that private or unsafe action.",
      usedFallback: true,
    };
  }

  const sanitized = sanitizeNavigationTargetsInText(
    withoutToolSections,
    origin,
  );
  return {
    text:
      sanitized ||
      "I can help with public catalog browsing and product questions.",
    usedFallback: false,
  };
}

export function extractStringFields(
  value: unknown,
  keys: string[],
  results: string[] = [],
): string[] {
  if (results.length >= 20) return results;
  if (Array.isArray(value)) {
    for (const item of value) extractStringFields(item, keys, results);
    return results;
  }
  if (!isJsonRecord(value)) return results;

  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string") results.push(field);
    if (results.length >= 20) return results;
  }
  for (const item of Object.values(value))
    extractStringFields(item, keys, results);
  return results;
}

export function firstSafeNavigationFromContexts(
  contexts: StorefrontMcpContext[],
  origin: string | null,
  preferredPrefix?: string,
  tools?: StorefrontChatPublicTool[],
): string | null {
  const allowedTools = tools ? new Set<StorefrontChatPublicTool>(tools) : null;
  const candidates = contexts
    .filter((context) => !allowedTools || allowedTools.has(context.tool))
    .flatMap((context) =>
      extractStringFields(context.structuredContent, [
        "path",
        "url",
        "canonicalUrl",
        "link",
        "handle",
        "slug",
      ]),
    );
  for (const candidate of candidates) {
    const rawTarget =
      candidate.startsWith("/") || /^https?:\/\//i.test(candidate)
        ? candidate
        : preferredPrefix
          ? `${preferredPrefix}/${candidate}`
          : `/${candidate}`;
    const safeTarget = resolveStorefrontNavigationTarget(rawTarget, origin);
    if (
      safeTarget &&
      (!preferredPrefix || safeTarget.startsWith(`${preferredPrefix}/`))
    ) {
      return safeTarget;
    }
  }
  return null;
}

function catalogProductsFromContext(context: StorefrontMcpContext): JsonRecord[] {
  if (context.tool === "catalog_product") {
    return isJsonRecord(context.structuredContent.product)
      ? [context.structuredContent.product]
      : [];
  }
  return Array.isArray(context.structuredContent.products)
    ? context.structuredContent.products.filter(
        (product): product is JsonRecord => isJsonRecord(product),
      )
    : [];
}

function firstCatalogProductNavigation(
  contexts: StorefrontMcpContext[],
  origin: string | null,
  tools: StorefrontChatPublicTool[],
): StorefrontNavigateAction | null {
  const allowedTools = new Set(tools);
  for (const context of contexts) {
    if (!allowedTools.has(context.tool)) continue;
    for (const product of catalogProductsFromContext(context)) {
      const title = compactStorefrontChatText(product.title, 100);
      const handle = cleanNavigationTargetText(product.handle, 160);
      const candidates = [
        product.url,
        product.path,
        ...(handle ? [`/products/${handle}`] : []),
      ];
      for (const candidate of candidates) {
        const path = resolveStorefrontNavigationTarget(candidate, origin);
        if (!path?.startsWith("/products/")) continue;
        return {
          type: "navigate",
          path,
          label: title ? `View ${title}` : "View product",
        };
      }
    }
  }
  return null;
}

function categoryNavigationFromContexts(
  contexts: StorefrontMcpContext[],
  origin: string | null,
  query: string | null,
): StorefrontNavigateAction | null {
  const queryTokens = (query ?? "")
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  const candidates = contexts.flatMap((context) => {
    if (context.tool !== "catalog_categories") return [];
    const catalog = isJsonRecord(context.structuredContent.catalogCategories)
      ? context.structuredContent.catalogCategories
      : null;
    return Array.isArray(catalog?.categories)
      ? catalog.categories.filter(
          (category): category is JsonRecord => isJsonRecord(category),
        )
      : [];
  });
  const matching = queryTokens.length === 0
    ? candidates
    : candidates.filter((category) => {
        const value = [category.name, category.slug]
          .filter((part): part is string => typeof part === "string")
          .join(" ")
          .toLocaleLowerCase();
        return queryTokens.every((token) => value.includes(token));
      });
  for (const category of matching) {
    const name = compactStorefrontChatText(category.name, 100);
    const slug = cleanNavigationTargetText(category.slug, 160);
    const targets = [
      category.path,
      category.url,
      ...(slug ? [`/categories/${slug}`] : []),
    ];
    for (const target of targets) {
      const path = resolveStorefrontNavigationTarget(target, origin);
      if (!path?.startsWith("/categories/")) continue;
      return {
        type: "navigate",
        path,
        label: name ? `Browse ${name}` : "Browse category",
      };
    }
  }
  return null;
}

export function createSearchNavigationAction(
  messages: StorefrontChatMessage[],
): StorefrontNavigateAction | null {
  const query = searchQueryFromMessages(messages);
  if (!query) return null;
  const params = new URLSearchParams({ q: query.slice(0, 120) });
  const path = `/search?${params.toString()}`;
  return resolveStorefrontNavigationTarget(path, "https://storefront.invalid")
    ? { type: "navigate", path, label: "Search catalog" }
    : null;
}

export function createStorefrontNavigationActions(
  payload: StorefrontChatPayload,
  contexts: StorefrontMcpContext[],
  origin: string | null,
  intent?: StorefrontChatIntent,
): StorefrontNavigateAction[] {
  const latest = latestUserChatText(payload.messages);
  if (
    /\b(?:checkout|account|order|payment|recovery|receipt|admin|api|otp|password|login)\b/i.test(
      latest,
    )
  ) {
    return [];
  }

  const actions: StorefrontNavigateAction[] = [];
  const referencedProductIntent = Boolean(
    intent?.referencedProductIds?.length,
  );
  const searchAction = createSearchNavigationAction(payload.messages);
  const searchQuery = searchQueryFromMessages(payload.messages);
  const categoryIntent = hasCategoryIntent(latest, payload.pageContext);
  const categoryAction = categoryIntent
    ? categoryNavigationFromContexts(contexts, origin, searchQuery)
    : null;
  const explicitCategoryDestination = /\bcategor(?:y|ies)\b/i.test(latest);
  const explicitSearchDestination = Boolean(
    searchAction &&
    !explicitCategoryDestination &&
    /\b(?:browse|find|search|show)\b/i.test(latest),
  );
  if (categoryAction && explicitCategoryDestination && !referencedProductIntent) {
    actions.push(categoryAction);
  }
  if (
    searchAction &&
    explicitSearchDestination &&
    !referencedProductIntent
  ) {
    actions.push(searchAction);
  }

  const searchHasProducts = contexts.some(
    (context) =>
      context.tool === "catalog_search" &&
      catalogProductsFromContext(context).length > 0,
  );
  const productAction = firstCatalogProductNavigation(
    contexts,
    origin,
    searchHasProducts
      ? ["catalog_search"]
      : ["catalog_lookup", "catalog_product"],
  );
  if (
    productAction &&
    !explicitCategoryDestination &&
    (!explicitSearchDestination || referencedProductIntent)
  ) {
    actions.push(productAction);
  }

  if (
    categoryAction &&
    !explicitCategoryDestination &&
    !explicitSearchDestination &&
    !referencedProductIntent
  ) {
    actions.push(categoryAction);
  }

  if (
    searchAction &&
    !referencedProductIntent &&
    !actions.some((action) => action.path === searchAction.path) &&
    /\b(?:search|find|look|show|browse)\b/i.test(latest)
  ) {
    actions.push(searchAction);
  }

  if (
    /\bcart\b/i.test(latest) &&
    resolveStorefrontNavigationTarget("/cart", origin)
  ) {
    actions.push({ type: "navigate", path: "/cart", label: "Open cart" });
  }

  const seen = new Set<string>();
  return actions
    .filter((action) => {
      if (seen.has(action.path)) return false;
      seen.add(action.path);
      return true;
    })
    .slice(0, STOREFRONT_CHAT_MAX_NAVIGATION_ACTIONS);
}
