/**
 * Local admin reset, children before principals. Approved OAuth/device rows
 * require their user/grant/credential even where the FK says SET NULL; browser
 * handoffs and artifacts retain their principals with NO ACTION. Clear those
 * capabilities before deleting accounts, without changing the store's data.
 */
export const LOCAL_AUTH_RESET_TABLES = Object.freeze([
  "agent_device_authorizations",
  "agent_authorization_requests",
  "agent_browser_handoffs",
  "agent_artifact_handles",
  "agent_storefront_continuations",
  "agent_storefront_order_grants",
  "agent_storefront_contexts",
  "agent_audit_events",
  "agent_credentials",
  "agent_grants",
  "admin_fcm_tokens",
  "admin_identity_handoff_events",
  "admin_invitations",
  "admin_setup_claims",
  "admin_setup_rate_limits",
  "scanner_token_claims",
  "rate_limit",
  "staff_auth_attempts",
  "session",
  "account",
  "verification",
  "two_factor",
  "user_roles",
  "user_permissions",
  "user",
]);

export function localAuthResetSql() {
  return [
    // OAuth protocol artifacts share this table with unrelated store state.
    "DELETE FROM system_kv WHERE substr(key, 1, 6) = 'oauth:'",
    ...LOCAL_AUTH_RESET_TABLES.map((table) => `DELETE FROM "${table}"`),
  ].join("; ");
}
