import { AppError } from "../../errors";
import type { AppErrorCode } from "@scalius/shared/plugins/app-errors";

/**
 * A plugin platform refusal's code. What an app's code can see is the sealed
 * `AppErrorCode` table (`@scalius/shared/plugins/app-errors`, part of the
 * versioned plugin ABI: codes are only ever added); the rest are refusals of
 * the store's own app management (install, update, registry, signatures),
 * which only staff see.
 */
export type PluginErrorCode =
  | AppErrorCode
  | "manifest_invalid"
  | "manifest_reserved_vendor"
  | "installation_exists"
  | "installation_not_found"
  | "installation_revision_conflict"
  | "installation_settings_incomplete"
  | "installation_objects_invalid"
  | "installation_grant_changed"
  /** An update waits for a Super Admin: nothing may change its grant until then. */
  | "installation_needs_approval"
  /** The app declares no feature with that id (`manifest.features`). */
  | "feature_not_found"
  | "delivery_not_found"
  | "delivery_not_retryable"
  | "settings_invalid"
  /** Registry and upload installs. */
  | "registry_not_configured"
  | "registry_unavailable"
  | "registry_not_found"
  | "package_invalid"
  | "package_hash_mismatch"
  | "signature_missing"
  | "signature_untrusted"
  | "signature_invalid"
  /** An update signed by another key than the one the app was installed with. */
  | "signature_signer_changed"
  /** An install whose id has data kept from another developer's release (delete it first). */
  | "retained_data_other_developer"
  | "installation_incompatible"
  | "installation_sandbox_required"
  | "installation_source_conflict";

const STATUS: Partial<Record<PluginErrorCode, number>> = {
  "installation_exists": 409,
  "installation_objects_invalid": 409,
  "installation_not_found": 404,
  "installation_revision_conflict": 409,
  "installation_inactive": 409,
  "installation_grant_changed": 409,
  "installation_needs_approval": 409,
  "feature_not_found": 404,
  "delivery_not_found": 404,
  "delivery_not_retryable": 409,
  "settings_key_unavailable": 503,
  "object_unique_violation": 409,
  "object_conflict": 409,
  "object_record_too_large": 413,
  "kv_value_too_large": 413,
  "kv_conflict": 409,
  "api_unknown_operation": 404,
  "api_operation_forbidden": 403,
  "http_not_allowed": 403,
  "http_timeout": 504,
  "http_failed": 502,
  "messaging_not_allowed": 403,
  "messaging_unavailable": 503,
  "timeline_not_allowed": 403,
  "timeline_undeclared": 403,
  "timeline_invalid": 422,
  "timeline_not_found": 404,
  "orders_not_allowed": 403,
  "orders_invalid": 422,
  "orders_not_found": 404,
  "orders_hold_not_found": 404,
  "orders_conflict": 409,
  "customers_not_allowed": 403,
  "customers_invalid": 422,
  "customers_not_found": 404,
  "customer_roles_limit": 409,
  "jobs_undeclared": 404,
  "jobs_invalid": 422,
  "jobs_limit": 429,
  "jobs_not_found": 404,
  "jobs_key_reused": 422,
  rate_limited: 429,
  "quota_storage": 507,
  "quota_subrequests": 429,
  "registry_not_configured": 409,
  "registry_unavailable": 502,
  "registry_not_found": 404,
  "package_invalid": 422,
  "package_hash_mismatch": 422,
  "signature_missing": 409,
  "signature_untrusted": 409,
  "signature_invalid": 422,
  "signature_signer_changed": 409,
  "retained_data_other_developer": 409,
  "installation_incompatible": 409,
  "installation_sandbox_required": 409,
  "installation_source_conflict": 409,
  internal_error: 500,
};

/** A plugin platform refusal. `pluginCode` crosses the bridge as `[code] message`. */
export class PluginError extends AppError {
  readonly pluginCode: PluginErrorCode;

  constructor(code: PluginErrorCode, message: string, details?: unknown) {
    super(STATUS[code] ?? 400, "plugin_error", message, details === undefined ? { code } : { code, ...asObject(details) });
    this.name = "PluginError";
    this.pluginCode = code;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { detail: value };
}
