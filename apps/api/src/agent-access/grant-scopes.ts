// Opt-in grant scopes (`x-scalius-agent.grantScope`): the inbox
// (`customer_conversations`) and review moderation (`review_moderation`). No
// preset grant (Read only, Operator, Full automation) reaches their
// operations, even when its permission snapshot (taken before the scopes
// existed) lists their permissions; a Custom grant that selected them does.
// Both agent lanes check it: MCP through backend.authorizeOperation, direct
// REST at the admin boundary.
import type { AgentOperationRbac } from "../openapi/agent-operation-manifest";

export const OPT_IN_GRANT_SCOPE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  customer_conversations: ["conversations.view", "conversations.reply"],
  review_moderation: ["reviews.view", "reviews.moderate"],
};

const OPT_IN_PERMISSIONS = new Set(Object.values(OPT_IN_GRANT_SCOPE_PERMISSIONS).flat());

/** True when the route cannot be reached without an opt-in scope permission. */
export function requiresOptInGrantScope(rbac: AgentOperationRbac): boolean {
  switch (rbac.type) {
    case "permission":
      return OPT_IN_PERMISSIONS.has(rbac.permission);
    case "allOf":
      return rbac.permissions.some((permission) => OPT_IN_PERMISSIONS.has(permission));
    case "anyOf":
      return rbac.permissions.every((permission) => OPT_IN_PERMISSIONS.has(permission));
    default:
      return false;
  }
}
