import type { AssistantMessagePart } from
  "@scalius/shared/assistant-contracts";

import { resolveStorefrontAssistantNavigationTarget } from
  "@/lib/assistant-page-context.client";

type NavigationPart = Extract<
  AssistantMessagePart,
  { type: "navigation" }
>;

export function getDirectlyConfirmedStorefrontNavigation(
  userMessage: string,
  parts: AssistantMessagePart[],
  origin: string,
): NavigationPart | null {
  const requestedDestination = directNavigationDestination(userMessage);
  if (!requestedDestination) return null;

  const destinations = parts.filter(
    (part): part is NavigationPart =>
      part.type === "navigation" &&
      resolveStorefrontAssistantNavigationTarget(part.path, origin) !== null,
  );
  if (destinations.length !== 1) return null;
  return navigationMatchesDestination(
    requestedDestination,
    destinations[0],
    origin,
  )
    ? destinations[0]
    : null;
}

function directNavigationDestination(value: string): string | null {
  const message = value.trim();
  if (
    !message ||
    /[,;]/.test(message) ||
    /\b(?:and|or|then|also|either|whichever|maybe|plus|with)\b/i.test(message)
  ) {
    return null;
  }

  const command =
    "(?:open|browse|find|search(?:\\s+for)?|navigate(?:\\s+me)?\\s+to|go\\s+to|visit|show\\s+me|take\\s+me\\s+to|send\\s+me\\s+to|jump\\s+to)";
  const patterns = [
    new RegExp(
      `^(?:please\\s+)?${command}\\s+(?:the\\s+)?(.+?)(?:\\s+(?:page|screen|section|results?))?[?!.]*$`,
      "i",
    ),
    new RegExp(
      `^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${command}\\s+(?:the\\s+)?(.+?)(?:\\s+(?:page|screen|section|results?))?[?!.]*$`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const destination = pattern.exec(message)?.[1]?.trim();
    if (destination) return destination;
  }
  return null;
}

function destinationTokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 1 &&
        token !== "page" &&
        token !== "screen" &&
        token !== "section" &&
        token !== "result" &&
        token !== "results" &&
        token !== "catalog" &&
        token !== "category" &&
        token !== "categories" &&
        token !== "collection" &&
        token !== "collections" &&
        token !== "product" &&
        token !== "products" &&
        token !== "shop" &&
        token !== "store" &&
        token !== "storefront",
    );
}

function canonicalTokens(value: string): string[] {
  return destinationTokens(value)
    .map((token) =>
      token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token
    )
    .sort();
}

function pathDestinationTokens(path: string): string[] {
  const parsed = new URL(path, "https://storefront.invalid");
  if (parsed.pathname === "/search") {
    return canonicalTokens(parsed.searchParams.get("q") ?? "");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const value = segments.length > 1
    ? segments.slice(1).join(" ")
    : segments.join(" ");
  return canonicalTokens(value);
}

function navigationMatchesDestination(
  requestedDestination: string,
  action: NavigationPart,
  origin: string,
): boolean {
  const requested = canonicalTokens(requestedDestination);
  if (requested.length === 0) return false;
  const path = resolveStorefrontAssistantNavigationTarget(action.path, origin);
  if (!path) return false;
  const label = canonicalTokens(
    action.label.replace(/^(?:Open|View|Browse|Search)\s+/i, ""),
  );
  const pathTokens = pathDestinationTokens(path);
  return [label, pathTokens].some(
    (candidate) =>
      candidate.length > 0 && candidate.join("|") === requested.join("|"),
  );
}
