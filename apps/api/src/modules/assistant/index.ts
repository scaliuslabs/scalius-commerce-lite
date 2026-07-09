export {
  ADMIN_COMMAND_POLICY_DIGEST,
  ADMIN_COMMAND_REGISTRY,
  adminCommandPolicyDigest,
  auditAdminCommandRegistry,
  describeAdminCapability,
  isSafeAdminPathTemplate,
  resolveAdminApiCapability,
  searchAdminCapabilities,
  type AdminAuthorization,
  type AdminCapabilityImplementation,
  type AdminCommandDescriptor,
  type AdminIdempotencyEvidence,
  type AdminRisk,
} from "./admin-command-registry";

export type { AdminHttpMethod } from "./admin-operation-inventory";

export {
  ADMIN_SETTING_GROUP_REGISTRY,
  ADMIN_SETTINGS_PAGE_REGISTRY,
  ADMIN_UI_AFFORDANCE_EXTENSION_CONTRACT,
  adminUiAffordanceDriftKey,
  auditAdminUiAffordanceRegistrations,
  registerAdminUiAffordances,
  type AdminSettingGroupDescriptor,
  type AdminSettingsPageDescriptor,
  type AdminUiAffordanceExpectation,
  type AdminUiAffordanceRegistration,
  type RegisteredAdminUiAffordance,
} from "./admin-ui-affordance-registry";
