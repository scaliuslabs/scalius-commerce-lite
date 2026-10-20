import { AppError } from "../../errors";

/**
 * Stable, dotted error codes a plugin can branch on (`error.code` inside the
 * plugin). Part of the versioned plugin API: codes are only ever added.
 */
export type PluginErrorCode =
  | "manifest.invalid"
  | "manifest.reserved_vendor"
  | "installation.exists"
  | "installation.not_found"
  | "installation.revision_conflict"
  | "installation.inactive"
  | "installation.settings_incomplete"
  | "installation.objects_invalid"
  | "installation.grant_changed"
  /** An update waits for a Super Admin: nothing may change its grant until then. */
  | "installation.needs_approval"
  /** The app declares no feature with that id (`manifest.features`). */
  | "feature.not_found"
  | "delivery.not_found"
  | "delivery.not_retryable"
  | "settings.invalid"
  | "settings.key_unavailable"
  | "object.undeclared_type"
  | "object.invalid_id"
  | "object.invalid_record"
  | "object.record_too_large"
  | "object.invalid_index_value"
  | "object.unindexed_query"
  | "object.invalid_cursor"
  | "object.unique_violation"
  /** A conditional write found the record changed (or present when it must not be). */
  | "object.conflict"
  | "object.invalid_batch"
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
  /** `to` is not a customer, a staff member or a declared recipient (`messaging.recipients`), and the app lacks `send_messages_any`. */
  | "messaging.recipient_not_allowed"
  | "messaging.invalid"
  | "messaging.unavailable"
  /** Order timeline entries (`ctx.timeline.add`). */
  | "timeline.not_allowed"
  | "timeline.undeclared"
  | "timeline.invalid"
  | "timeline.not_found"
  /** Order actions from event handlers (`ctx.orders`). */
  | "orders.not_allowed"
  | "orders.invalid"
  | "orders.not_found"
  /** Rendering storefront output: only the app's settings and the section's declared collections are readable. */
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
  /** An update signed by another key than the one the app was installed with. */
  | "signature.signer_changed"
  | "installation.incompatible"
  | "installation.sandbox_required"
  | "installation.source_conflict"
  | "internal";

const STATUS: Partial<Record<PluginErrorCode, number>> = {
  "installation.exists": 409,
  "installation.objects_invalid": 409,
  "installation.not_found": 404,
  "installation.revision_conflict": 409,
  "installation.inactive": 409,
  "installation.grant_changed": 409,
  "installation.needs_approval": 409,
  "feature.not_found": 404,
  "delivery.not_found": 404,
  "delivery.not_retryable": 409,
  "settings.key_unavailable": 503,
  "object.unique_violation": 409,
  "object.conflict": 409,
  "object.record_too_large": 413,
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
  "orders.not_allowed": 403,
  "orders.invalid": 422,
  "orders.not_found": 404,
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
  "signature.signer_changed": 409,
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
