import { AppError } from "../../errors";

/**
 * Stable, dotted error codes a plugin can branch on (`error.code` inside the
 * plugin). Part of the versioned plugin API: codes are only ever added.
 */
export type PluginErrorCode =
  | "manifest.invalid"
  | "manifest.permission_unknown"
  | "manifest.permission_reserved"
  | "manifest.custom_field_type"
  | "manifest.reserved_vendor"
  | "installation.exists"
  | "installation.not_found"
  | "installation.revision_conflict"
  | "installation.inactive"
  | "installation.settings_incomplete"
  | "installation.grant_changed"
  | "delivery.not_found"
  | "delivery.not_retryable"
  | "settings.invalid"
  | "settings.key_unavailable"
  | "storage.undeclared_collection"
  | "storage.invalid_id"
  | "storage.invalid_record"
  | "storage.record_too_large"
  | "storage.invalid_index_value"
  | "storage.unindexed_query"
  | "storage.invalid_cursor"
  | "storage.unique_violation"
  /** A conditional write found the record changed (or present when it must not be). */
  | "storage.conflict"
  | "storage.invalid_batch"
  | "kv.invalid_key"
  | "kv.value_too_large"
  | "kv.invalid_ttl"
  /** compareAndSet found another revision: the entry changed since it was read. */
  | "kv.conflict"
  | "kv.invalid_revision"
  | "api.unknown_operation"
  | "api.operation_forbidden"
  | "api.invalid_input"
  | "http.not_allowed"
  | "http.invalid_request"
  | "http.too_many_redirects"
  | "http.timeout"
  | "http.failed"
  | "custom_fields.undeclared"
  | "custom_fields.invalid"
  | "messaging.not_allowed"
  | "messaging.invalid"
  | "messaging.unavailable"
  /** Order timeline entries (`ctx.timeline.add`). */
  | "timeline.not_allowed"
  | "timeline.undeclared"
  | "timeline.invalid"
  | "timeline.not_found"
  /** Rendering storefront output: only the app's settings and the section's declared collections are readable. */
  | "render.not_allowed"
  | "rate_limited"
  /** Quotas (docs/platform/PLUGINS.md, "Quotas"): over the plan's storage size or calls per run. */
  | "quota.storage"
  | "quota.subrequests"
  /** Registry and upload installs. */
  | "registry.not_configured"
  | "registry.unavailable"
  | "registry.not_found"
  | "package.invalid"
  | "package.hash_mismatch"
  | "signature.missing"
  | "signature.untrusted"
  | "signature.invalid"
  | "installation.incompatible"
  | "installation.sandbox_required"
  | "installation.source_conflict"
  | "internal";

const STATUS: Partial<Record<PluginErrorCode, number>> = {
  "installation.exists": 409,
  "installation.not_found": 404,
  "installation.revision_conflict": 409,
  "installation.inactive": 409,
  "installation.grant_changed": 409,
  "delivery.not_found": 404,
  "delivery.not_retryable": 409,
  "settings.key_unavailable": 503,
  "storage.unique_violation": 409,
  "storage.conflict": 409,
  "storage.record_too_large": 413,
  "kv.value_too_large": 413,
  "kv.conflict": 409,
  "api.unknown_operation": 404,
  "api.operation_forbidden": 403,
  "http.not_allowed": 403,
  "http.timeout": 504,
  "http.failed": 502,
  "messaging.not_allowed": 403,
  "messaging.unavailable": 503,
  "timeline.not_allowed": 403,
  "timeline.undeclared": 403,
  "timeline.invalid": 422,
  "timeline.not_found": 404,
  "render.not_allowed": 403,
  rate_limited: 429,
  "quota.storage": 507,
  "quota.subrequests": 429,
  "registry.not_configured": 409,
  "registry.unavailable": 502,
  "registry.not_found": 404,
  "package.invalid": 422,
  "package.hash_mismatch": 422,
  "signature.missing": 409,
  "signature.untrusted": 409,
  "signature.invalid": 422,
  "installation.incompatible": 409,
  "installation.sandbox_required": 409,
  "installation.source_conflict": 409,
  internal: 500,
};

/** A plugin platform refusal. `pluginCode` crosses the bridge as `[code] message`. */
export class PluginError extends AppError {
  readonly pluginCode: PluginErrorCode;

  constructor(code: PluginErrorCode, message: string, details?: unknown) {
    super(STATUS[code] ?? 400, "PLUGIN_ERROR", message, details === undefined ? { code } : { code, ...asObject(details) });
    this.name = "PluginError";
    this.pluginCode = code;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { detail: value };
}
