import { AppError } from "../../errors";

/**
 * Stable, dotted error codes a plugin can branch on (`error.code` inside the
 * plugin). Part of the versioned plugin API: codes are only ever added.
 */
export type PluginErrorCode =
  | "manifest_invalid"
  | "manifest_reserved_vendor"
  | "installation_exists"
  | "installation_not_found"
  | "installation_revision_conflict"
  | "installation_inactive"
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
  | "settings_key_unavailable"
  | "object_undeclared_type"
  | "object_invalid_id"
  | "object_invalid_record"
  | "object_record_too_large"
  | "object_invalid_index_value"
  | "object_unindexed_query"
  | "object_invalid_cursor"
  | "object_unique_violation"
  /** A conditional write found the record changed (or present when it must not be). */
  | "object_conflict"
  | "object_invalid_batch"
  | "kv_invalid_key"
  | "kv_value_too_large"
  | "kv_invalid_ttl"
  /** compareAndSet found another revision: the entry changed since it was read. */
  | "kv_conflict"
  | "kv_invalid_revision"
  | "api_unknown_operation"
  | "api_operation_forbidden"
  | "api_invalid_input"
  | "http_not_allowed"
  | "http_invalid_request"
  | "http_too_many_redirects"
  | "http_timeout"
  | "http_failed"
  | "custom_fields_undeclared"
  | "custom_fields_invalid"
  | "messaging_not_allowed"
  /** `to` is not a customer, a staff member or a declared recipient (`messaging.recipients`), and the app lacks `send_messages_any`. */
  | "messaging_recipient_not_allowed"
  | "messaging_invalid"
  | "messaging_unavailable"
  /** Order timeline entries (`ctx.timeline.add`). */
  | "timeline_not_allowed"
  | "timeline_undeclared"
  | "timeline_invalid"
  | "timeline_not_found"
  /** Order actions from event handlers (`ctx.orders`). */
  | "orders_not_allowed"
  | "orders_invalid"
  | "orders_not_found"
  /** Rendering storefront output: only the app's settings and the section's declared collections are readable. */
  | "rate_limited"
  /** Quotas (docs/platform/PLUGINS.md, "Quotas"): over the plan's storage size or calls per run. */
  | "quota_storage"
  | "quota_subrequests"
  /** Registry and upload installs. */
  | "registry_not_configured"
  | "registry_unavailable"
  | "registry_not_found"
  | "package_invalid"
  | "package_hash_mismatch"
  | "signature_missing"
  | "signature_untrusted"
  | "signature_invalid"
  | "installation_incompatible"
  | "installation_sandbox_required"
  | "installation_source_conflict"
  | "internal";

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
  "installation_incompatible": 409,
  "installation_sandbox_required": 409,
  "installation_source_conflict": 409,
  internal: 500,
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
