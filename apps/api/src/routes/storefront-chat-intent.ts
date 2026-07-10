import { splitStorefrontAssistantCatalogReferences } from
  "@scalius/shared/storefront-assistant-references";

import {
  latestUserChatText,
  type StorefrontChatPayload,
} from "./storefront-chat-contract";
import { searchQueryFromMessages } from "./storefront-chat-navigation";

export type StorefrontChatIntentKind =
  | "current_product"
  | "ordinal_product"
  | "factual_comparison"
  | "recommendation_comparison"
  | "recommendation"
  | "catalog_search"
  | "general";

export interface StorefrontChatIntent {
  kind: StorefrontChatIntentKind;
  latestText: string;
  searchQuery: string | null;
  ordinals?: number[];
  referencedProductIds?: string[];
  unresolvedOrdinalReference?: boolean;
  requestedOptionAxes?: string[];
}

const ORDINALS = new Map<string, number>([
  ["first", 1],
  ["1st", 1],
  ["second", 2],
  ["2nd", 2],
  ["third", 3],
  ["3rd", 3],
  ["fourth", 4],
  ["4th", 4],
  ["fifth", 5],
  ["5th", 5],
  ["sixth", 6],
  ["6th", 6],
]);

function requestedOrdinals(text: string, referenceCount: number): number[] {
  if (
    !/\b(?:compare|comparison|difference|between|which|tell\s+me\s+about|show|open|view|one|item|option|product|last)\b/i.test(
      text,
    )
  ) {
    return [];
  }
  const ordinals: number[] = [];
  for (const match of text.matchAll(
    /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|last)\b/gi,
  )) {
    const token = match[1]?.toLowerCase();
    const ordinal = token === "last" ? referenceCount : ORDINALS.get(token ?? "");
    if (ordinal && !ordinals.includes(ordinal)) ordinals.push(ordinal);
  }
  return ordinals.slice(0, 5);
}

function immediatelyPrecedingAssistantProductIds(
  payload: StorefrontChatPayload,
): string[] {
  let latestUserIndex = -1;
  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    if (payload.messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 1) return [];
  const preceding = payload.messages[latestUserIndex - 1];
  if (preceding?.role !== "assistant") return [];
  return splitStorefrontAssistantCatalogReferences(preceding.content)
    .productIds;
}

export function hasStorefrontRecommendationIntent(text: string): boolean {
  return /\b(?:recommend|recommendation|best|better|help\s+me\s+choose|suitable\s+for|good\s+for|fit\s+for|need\s+for)\b/i.test(
    text,
  );
}

export function hasStorefrontComparisonIntent(text: string): boolean {
  return /\b(?:compare|comparison|difference|differences|versus|vs\.?|which\s+(?:(?:one|product)\s+)?is\s+(?:better|cheaper|available|in\s+stock)|which\s+(?:one|product)\s+(?:costs|has))\b/i.test(
    text,
  );
}

function hasNamedProductOptionTarget(text: string): boolean {
  const mentionsOptionAxis =
    /\b(?:sizes?|colou?rs?|options?|variants?|materials?|patterns?)\b/i.test(
      text,
    );
  if (
    !mentionsOptionAxis ||
    /\b(?:this|it|current\s+product)\b/i.test(text)
  ) {
    return false;
  }
  return /\bdoes\s+.+\s+have\b/i.test(text) ||
    /\b(?:available\s+)?(?:for|on|of)\s+(?!you\b)[A-Za-z0-9]/i.test(text) ||
    /\bavailable\s+in\s+(?!stock\b|this\b|it\b)[A-Za-z0-9]/i.test(text);
}

function requestedProductOptionAxes(text: string): string[] {
  const axes: string[] = [];
  const mappings: Array<[RegExp, string]> = [
    [/\bsizes?\b/i, "size"],
    [/\bcolou?rs?\b/i, "color"],
    [/\bmaterials?\b/i, "material"],
    [/\bpatterns?\b/i, "pattern"],
  ];
  for (const [pattern, axis] of mappings) {
    if (pattern.test(text)) axes.push(axis);
  }
  return axes;
}

function namedProductOptionSearchQuery(
  text: string,
  extractedQuery: string | null,
): string | null {
  if (!hasNamedProductOptionTarget(text) || !extractedQuery) return null;
  const target = extractedQuery
    .split(/\s+/)
    .filter((term) =>
      !/^(?:sizes?|colou?rs?|options?|variants?|materials?|patterns?)$/i.test(
        term,
      )
    )
    .join(" ")
    .trim();
  return target || null;
}

function hasCurrentProductFactIntent(
  text: string,
  payload: StorefrontChatPayload,
): boolean {
  if (payload.pageContext?.page?.kind !== "product") return false;
  if (hasNamedProductOptionTarget(text)) return false;
  return /\b(?:what\s+(?:am\s+i\s+looking\s+at|is\s+this)|what(?:'s|\s+is)\s+this|looking\s+at|tell\s+me\s+about\s+this(?:\s+product)?|this\s+product|key\s+details|is\s+this\s+(?:available|in\s+stock|out\s+of\s+stock)|how\s+much\s+(?:is|does)\s+this|(?:price|availability|stock)\s+(?:of|for)\s+this|(?:what|which|available)\s+(?:sizes?|colou?rs?|options?|variants?|materials?|patterns?)|(?:sizes?|colou?rs?|options?|variants?)\s+do\s+you\s+have)\b/i.test(
    text,
  );
}

function hasCatalogSearchIntent(text: string): boolean {
  if (hasNamedProductOptionTarget(text)) return true;
  return /\b(?:do\s+you|sell|stock|available|availability|have\s+any|what\s+do\s+you\s+have|(?:what|which|available)\s+(?:sizes?|colou?rs?|options?|variants?|materials?|patterns?)\s+does|tell\s+me\s+about|show\s+me|find|search|browse|open|visit|take\s+me|send\s+me|go\s+to|jump\s+to)\b/i.test(
    text,
  );
}

export function classifyStorefrontChatIntent(
  payload: StorefrontChatPayload,
  searchQueryOverride?: string | null,
): StorefrontChatIntent {
  const latestText = latestUserChatText(payload.messages);
  const searchQuery = searchQueryOverride === undefined
    ? searchQueryFromMessages(payload.messages)
    : searchQueryOverride;
  const productIds = immediatelyPrecedingAssistantProductIds(payload);
  const ordinals = requestedOrdinals(latestText, productIds.length);
  const unresolvedLast = productIds.length === 0 &&
    /\b(?:the\s+)?last\s+(?:one|item|option|product)\b/i.test(latestText);
  if (ordinals.length > 0 || unresolvedLast) {
    const referencedProductIds = ordinals.flatMap((ordinal) =>
      productIds[ordinal - 1] ? [productIds[ordinal - 1]!] : []
    );
    const comparison = referencedProductIds.length > 1;
    const recommendation = hasStorefrontRecommendationIntent(latestText);
    return {
      kind: comparison
        ? recommendation
          ? "recommendation_comparison"
          : "factual_comparison"
        : "ordinal_product",
      latestText,
      searchQuery: null,
      ordinals,
      referencedProductIds,
      ...(unresolvedLast || referencedProductIds.length !== ordinals.length
        ? { unresolvedOrdinalReference: true }
        : {}),
    };
  }

  const comparison = hasStorefrontComparisonIntent(latestText);
  const recommendation = hasStorefrontRecommendationIntent(latestText);
  if (comparison) {
    return {
      kind: recommendation
        ? "recommendation_comparison"
        : "factual_comparison",
      latestText,
      searchQuery,
    };
  }
  if (recommendation) {
    const refersToCurrentProduct =
      payload.pageContext?.page?.kind === "product" &&
      /\b(?:this|it|current\s+product)\b/i.test(latestText);
    return {
      kind: "recommendation",
      latestText,
      searchQuery: refersToCurrentProduct ? null : searchQuery,
    };
  }
  if (hasCurrentProductFactIntent(latestText, payload)) {
    const requestedOptionAxes = requestedProductOptionAxes(latestText);
    return {
      kind: "current_product",
      latestText,
      searchQuery: null,
      ...(requestedOptionAxes.length > 0 ? { requestedOptionAxes } : {}),
    };
  }
  if (hasCatalogSearchIntent(latestText)) {
    const requestedOptionAxes = requestedProductOptionAxes(latestText);
    return {
      kind: "catalog_search",
      latestText,
      searchQuery: namedProductOptionSearchQuery(latestText, searchQuery) ??
        searchQuery,
      ...(requestedOptionAxes.length > 0 ? { requestedOptionAxes } : {}),
    };
  }
  return { kind: "general", latestText, searchQuery: null };
}

export function storefrontIntentPrefersCurrentProduct(
  intent: StorefrontChatIntent,
  payload: StorefrontChatPayload,
): boolean {
  return intent.kind === "current_product" ||
    (intent.kind === "recommendation" &&
      payload.pageContext?.page?.kind === "product" &&
      /\b(?:this|it|current\s+product)\b/i.test(intent.latestText));
}
