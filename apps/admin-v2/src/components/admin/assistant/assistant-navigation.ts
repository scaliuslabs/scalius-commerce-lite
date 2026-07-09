import type { AdminAssistantChatAction } from "../../../lib/api-functions/ai";

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
