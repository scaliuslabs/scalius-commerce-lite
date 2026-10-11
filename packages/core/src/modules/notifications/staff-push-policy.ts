import type { StaffPermissionRequirement } from "@scalius/core/auth/rbac/helpers";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ORDER_NOTIFICATION_TYPES } from "./notification-types";

// Closed payload-to-resource policy, shared by both delivery transports. A new
// event must declare its audience here; a saved device is not an access grant.
const STAFF_PUSH_PERMISSIONS = new Map<string, StaffPermissionRequirement>([
  ...ORDER_NOTIFICATION_TYPES.map((type) => [type, PERMISSIONS.ORDERS_VIEW] as const),
  ["review_pending", PERMISSIONS.ORDERS_VIEW],
  ["digital_keys_exhausted", PERMISSIONS.ORDERS_VIEW],
  ["conversation_message", PERMISSIONS.CONVERSATIONS_VIEW],
  ["webhook_disabled", PERMISSIONS.WEBHOOKS_VIEW],
  ["plugin_stopped", PERMISSIONS.APPS_VIEW],
  // App-authored text/links may describe any resource, not just the Apps page.
  ["plugin_notice", "super_admin"],
]);

export function staffPushPermission(type: string | undefined): StaffPermissionRequirement | undefined {
  return type === undefined ? undefined : STAFF_PUSH_PERMISSIONS.get(type);
}
