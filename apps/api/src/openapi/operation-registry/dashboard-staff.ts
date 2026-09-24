// Agent operation registry rows for the dashboard account, team, agent access and security routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_STAFF_OPERATIONS = {
  "dashboard.account.password_change": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
  },
  "dashboard.account.permissions.get": { limits: { response: 16_384 } },
  "dashboard.account.profile_update": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.account.security_get": { limits: { response: 16_384 } },
  "dashboard.account.sessions.list": {},
  "dashboard.account.sessions.revoke": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.account.sessions.revoke_others": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.account.two_factor.get": { limits: { response: 16_384 } },
  "dashboard.account.two_factor.method_challenge": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "dashboard.account.two_factor.method_update": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "dashboard.account.two_factor.verify": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
  },
  "dashboard.agent_access_authorization_requests_approve.approve": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 65_536, response: 16_384 },
    sensitive: true,
    reason:
      "Human OAuth approval and protocol continuation require a live 2FA-verified Super Admin browser session.",
  },
  "dashboard.agent_access_authorization_requests_deny.deny": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    sensitive: true,
    reason:
      "Human OAuth denial and protocol continuation require a live 2FA-verified Super Admin browser session.",
  },
  "dashboard.agent_access_authorization_requests.get": {
    exposure: "excluded",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Human OAuth consent display; unconsumed third-party client metadata is available only in the interactive dashboard consent flow.",
  },
  "dashboard.agent_access_device_authorizations_approve.approve": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 65_536, response: 16_384 },
    reason:
      "Human device-pairing approval mints a CLI credential for encrypted one-time delivery and requires live 2FA-verified Super Admin consent.",
  },
  "dashboard.agent_access_device_authorizations_deny.deny": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason: "Human device-pairing denial requires live 2FA-verified Super Admin consent.",
  },
  "dashboard.agent_access_device_authorizations_lookup.lookup": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 4_096, response: 16_384 },
    reason:
      "Human device-pairing verification accepts the short-lived user code only in the interactive dashboard pairing flow.",
  },
  "dashboard.agent_access_revoke_all.revoke_all": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Emergency tenant-wide credential kill switch; only a live 2FA-verified Super Admin browser session may invoke it.",
  },
  "dashboard.agent_access.browser_handoff.claim": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 8_192 },
    sensitive: true,
    reason:
      "Browser-only one-use claim returns sensitive continuation fields solely inside the authenticated browser session.",
  },
  "dashboard.agent_access.browser_handoff.open": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Browser-only handoff page bound to the same 2FA-verified administrator; agents receive only its non-secret resource link.",
  },
  "dashboard.agent_access.connections.events_list": { batch: "forbidden" },
  "dashboard.agent_access.connections.get": { batch: "forbidden" },
  "dashboard.agent_access.connections.list": { batch: "forbidden" },
  "dashboard.agent_access.connections.purge_revoked": {
    exposure: "excluded",
    risk: "security",
    limits: { request: 16_384, response: 16_384 },
    reason:
      "Irreversible purge of revoked and expired grants plus their audit history; only a live 2FA-verified Super Admin browser session may invoke it.",
  },
  "dashboard.agent_access.grants.revoke": {
    risk: "security",
    batch: "forbidden",
  },
  "dashboard.agent_access.grants.update": {
    risk: "security",
    batch: "forbidden",
  },
  "dashboard.agent_access.tokens.create": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
    sensitive: true,
    oneTimeSecret: true,
  },
  "dashboard.agent_access.tokens.rotate": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
    sensitive: true,
    oneTimeSecret: true,
  },
  "dashboard.scanner_device.create_link": {
    exposure: "device",
    risk: "security",
    limits: { response: 16_384 },
    sensitive: true,
  },
  "dashboard.security.policy_get": { limits: { request: 16_384 } },
  "dashboard.security.policy_update": {
    revision: "required",
    risk: "security",
    limits: { request: 131_072, response: 8_192 },
  },
  "dashboard.security.runtime_sources": { limits: { request: 16_384, response: 16_384 } },
  "dashboard.team.permission_overrides.remove": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.permission_overrides.set": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.permissions.list": {},
  "dashboard.team.roles.create": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.roles.delete": {
    risk: "destructive",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.roles.get": { limits: { response: 16_384 } },
  "dashboard.team.roles.list": {},
  "dashboard.team.roles.update": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.user_roles.assign": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.user_roles.remove": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.invite": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.list": {},
  "dashboard.team.users.remove": {
    risk: "destructive",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.resend_invitation": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.revoke_invitation": {
    risk: "destructive",
    limits: { response: 16_384 },
  },
  "dashboard.team.users.set_suspension": {
    risk: "security",
    batch: "forbidden",
    limits: { response: 16_384 },
  },
} satisfies Record<string, OperationRegistryEntry>;
