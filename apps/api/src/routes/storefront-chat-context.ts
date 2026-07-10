import type { ModelMessage } from "ai";
import { splitStorefrontAssistantCatalogReferences } from
  "@scalius/shared/storefront-assistant-references";
import {
  STOREFRONT_CHAT_MAX_CONTEXT_CHARS,
  compactStorefrontChatText,
  type StorefrontChatMessage,
  type StorefrontChatPageContext,
  type StorefrontChatSurface,
  type StorefrontMcpContext,
  type StorefrontNavigateAction,
} from "./storefront-chat-contract";

export function formatStorefrontMcpContext(
  contexts: StorefrontMcpContext[],
): string {
  const text = contexts.map((context) => `- ${context.text}`).join("\n");
  return (
    compactStorefrontChatText(
      [
        "Verified public storefront context from read-only catalog/discovery/cart-validation tools:",
        text,
        "These API-backed tool facts are authoritative. If visible page metadata disagrees, use the tool product title, price, options, and availability.",
        "Use this only for public buyer guidance. Do not expose private checkout, account, order, payment, recovery, or customer-session facts.",
      ].join("\n"),
      STOREFRONT_CHAT_MAX_CONTEXT_CHARS,
    ) ?? "Verified public storefront context is unavailable."
  );
}

export function formatNavigationActionContext(
  actions: StorefrontNavigateAction[],
): string | null {
  if (actions.length === 0) return null;
  const lines = actions.map((action) => `- ${action.label}: ${action.path}`);
  return compactStorefrontChatText(
    [
      "Click-confirmed storefront navigation action that will be shown beside this answer:",
      ...lines,
      "Tell the buyer they can use the visible action button. Do not imply the page opened automatically.",
    ].join("\n"),
    500,
  );
}

export function formatStorefrontSurfaceContext(
  surface: StorefrontChatSurface | null | undefined,
): string[] {
  if (!surface) return [];
  if (surface.kind === "product") {
    const options = surface.selectedOptions
      .map((option) => `${option.name}: ${option.label}`)
      .join(", ");
    return [
      `Product ID: ${surface.productId}`,
      surface.slug ? `Product slug: ${surface.slug}` : null,
      surface.selectedVariantId
        ? `Selected variant ID: ${surface.selectedVariantId}`
        : null,
      options ? `Selected options: ${options}` : null,
      `Visible page price snapshot (may be stale): ${surface.displayedPrice}`,
      `Visible selection state: ${surface.availability}`,
    ].filter((line): line is string => Boolean(line));
  }

  if (surface.kind === "cart") {
    return [
      `Cart revision: ${surface.revision}`,
      `Cart fingerprint: ${surface.fingerprint}`,
      surface.exactLineKeys.length
        ? `Exact cart line keys: ${surface.exactLineKeys.join(", ")}`
        : null,
    ].filter((line): line is string => Boolean(line));
  }

  const filters = surface.visibleFilters
    .map((filter) => `${filter.key}=${filter.value}`)
    .join(", ");
  const resource =
    surface.kind === "category"
      ? `Category ID: ${surface.categoryId}\nCategory slug: ${surface.slug}`
      : surface.kind === "collection"
        ? `Collection ID: ${surface.collectionId}`
        : `Search query: ${surface.query || "(empty)"}`;
  return [
    resource,
    `Listing page: ${surface.page}`,
    `Total listing results: ${surface.totalResults}`,
    surface.sortBy ? `Listing sort: ${surface.sortBy}` : null,
    filters ? `Visible filters: ${filters}` : null,
    surface.visibleProductIds.length
      ? `Visible product IDs: ${surface.visibleProductIds.join(", ")}`
      : null,
  ].filter((line): line is string => Boolean(line));
}

export function formatPageContext(
  pageContext: StorefrontChatPageContext,
): string | null {
  const page = pageContext?.page;
  if (!page) return null;
  const title = compactStorefrontChatText(page.title, 160);
  const path = compactStorefrontChatText(page.path, 240);
  const kind = compactStorefrontChatText(page.kind, 40);
  const cart = pageContext?.cart;
  return compactStorefrontChatText(
    [
      "Current public storefront page context:",
      kind ? `Page kind: ${kind}` : null,
      title ? `Title: ${title}` : null,
      path ? `Path: ${path}` : null,
      cart
        ? `Cart summary: ${cart.lineCount ?? 0} lines, ${cart.totalItems ?? 0} items.`
        : null,
      ...formatStorefrontSurfaceContext(pageContext?.surface),
    ]
      .filter(Boolean)
      .join("\n"),
    2_400,
  );
}

export function normalizeMessages(
  messages: StorefrontChatMessage[],
): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.role === "assistant"
      ? splitStorefrontAssistantCatalogReferences(message.content).content
      : message.content,
  }));
}
