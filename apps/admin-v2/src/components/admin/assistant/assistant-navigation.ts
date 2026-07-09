import type { AdminAssistantChatAction } from "../../../lib/api-functions/ai";

type AdminAssistantNavigateAction = Extract<
  AdminAssistantChatAction,
  { type: "navigate" }
>;

const ADMIN_RESOURCE_ROOTS = new Set([
  "attributes",
  "categories",
  "collections",
  "customers",
  "discounts",
  "inventory",
  "media",
  "orders",
  "pages",
  "products",
  "widgets",
]);

export function safeAdminAssistantNavigationPath(value: string): string | null {
  const path = value.trim();
  if (!/^\/admin(?:\/[a-z0-9-]+)*$/.test(path)) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.slice(1).some((segment) => /^\d+$/.test(segment))) return null;
  if (segments.length > 2 && ADMIN_RESOURCE_ROOTS.has(segments[1] ?? "")) {
    return null;
  }
  return path;
}

export function safeAdminAssistantPanelActions(
  actions: AdminAssistantChatAction[] | undefined,
): AdminAssistantChatAction[] | undefined {
  if (!actions?.length) return undefined;
  const safeActions = actions.filter((action) => {
    if (action.type === "navigate") {
      return Boolean(safeAdminAssistantNavigationPath(action.path));
    }
    return isSafePageAction(action);
  });
  return safeActions.length > 0 ? safeActions : undefined;
}

export function getDirectlyConfirmedAdminNavigationAction(
  userMessage: string,
  actions: AdminAssistantChatAction[] | undefined,
): AdminAssistantNavigateAction | null {
  const requestedDestination = directAdminNavigationDestination(userMessage);
  if (!requestedDestination) return null;

  const destinations = (actions ?? []).filter(
    (action): action is AdminAssistantNavigateAction =>
      action.type === "navigate" &&
      safeAdminAssistantNavigationPath(action.path) !== null,
  );
  if (destinations.length !== 1) return null;
  return navigationActionMatchesRequestedTarget(
    requestedDestination,
    destinations[0],
  ) ? destinations[0] : null;
}

function navigationActionMatchesRequestedTarget(
  requestedDestination: string,
  action: AdminAssistantNavigateAction,
): boolean {
  const requestedTokens = canonicalDestinationTokens(requestedDestination);
  if (requestedTokens.length === 0) return false;
  const labelTokens = destinationTokens(action.label.replace(/^Open\s+/i, ""));
  const path = safeAdminAssistantNavigationPath(action.path);
  const pathTokens = path
    ? destinationTokens(path.split("/").filter(Boolean).slice(1).join(" "))
    : [];

  return [labelTokens, pathTokens].some(
    (candidateTokens) =>
      candidateTokens.length > 0 &&
      canonicalDestinationTokens(candidateTokens.join(" ")).join("|") ===
        requestedTokens.join("|"),
  );
}

function directAdminNavigationDestination(value: string): string | null {
  const message = value.trim();
  if (
    !message ||
    /[,;]/.test(message) ||
    /\b(?:and|or|then|also|either|whichever|maybe|plus|with)\b/i.test(message)
  ) {
    return null;
  }

  const command =
    "(?:open|navigate(?:\\s+me)?\\s+to|go\\s+to|visit|show\\s+me|take\\s+me\\s+to|send\\s+me\\s+to|jump\\s+to)";
  const patterns = [
    new RegExp(
      `^(?:please\\s+)?${command}\\s+(?:the\\s+)?(.+?)(?:\\s+(?:page|screen|section))?[?!.]*$`,
      "i",
    ),
    new RegExp(
      `^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${command}\\s+(?:the\\s+)?(.+?)(?:\\s+(?:page|screen|section))?[?!.]*$`,
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
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 1 &&
        token !== "admin" &&
        token !== "page" &&
        token !== "screen" &&
        token !== "section",
    );
}

function tokenVariants(token: string): string[] {
  return token.length > 3 && token.endsWith("s")
    ? [token, token.slice(0, -1)]
    : [token];
}

function canonicalDestinationTokens(value: string): string[] {
  return destinationTokens(value)
    .map((token) => tokenVariants(token).at(-1) ?? token)
    .sort();
}

export function getAdminAssistantActionExecutionKey(
  messageId: string,
  action: AdminAssistantChatAction,
): string {
  const actionKey = action.type === "navigate" ? action.path : action.id;
  return `${messageId}:${action.type}:${actionKey}`;
}

function isSafePageAction(action: AdminAssistantChatAction): boolean {
  if (action.type === "navigate") return true;
  if (!action.id || !action.targetId || !action.label) return false;
  return (
    action.type === "focus_surface" ||
    action.type === "apply_field_draft" ||
    action.type === "save_registered_form" ||
    action.type === "select_visible_rows" ||
    action.type === "clear_selection"
  );
}
