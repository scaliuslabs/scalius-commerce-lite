// Provider ports: the kinds, their operations, provider identities and the
// typed error every port raises (docs/platform/PLUGINS.md, "Providers").
//
// A port is one interface per kind (payment, courier, sms, email, fraud,
// tax, translation). The platform's own adapters (COD, Stripe, the email providers) and
// app providers (the Bangladesh pack's SSLCommerz, couriers, SMS gateways and
// fraud checkers; bKash; Nagad) implement the same port; core code resolves a provider by id and
// never asks which kind of implementation it got. Ports are part of the
// versioned plugin API (`PLUGIN_API_VERSION`): within a version they change
// only additively.
//
// Kept free of zod: the sandbox wrapper and the SDK root bundle this file.

export const PROVIDER_KINDS = ["payment", "courier", "sms", "email", "fraud", "tax", "translation"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Every operation of every port: `required` ones an implementation must
 * have, `optional` ones it may add. The host refuses to call an operation an
 * implementation does not have; nothing else is ever invoked.
 */
export const PROVIDER_OPERATIONS = {
  payment: {
    required: ["createSession", "verifyWebhook"],
    optional: ["verifyReturn", "queryPayment", "refund", "refundStatus", "listRefunds", "testConnection"],
  },
  courier: {
    required: ["createShipment", "trackShipment"],
    optional: ["quote", "cancelShipment", "findShipment", "verifyWebhook", "reconcileCod", "testConnection"],
  },
  sms: { required: ["send"], optional: ["deliveryStatus", "testConnection"] },
  email: { required: ["send"], optional: ["deliveryStatus", "testConnection"] },
  fraud: { required: ["check"], optional: ["testConnection"] },
  tax: { required: ["calculate"], optional: ["commit", "void", "refund", "testConnection"] },
  // Machine translation (MARKETS-DESIGN D9): no built-in provider, apps only.
  translation: { required: ["translate"], optional: ["testConnection"] },
} as const satisfies Record<ProviderKind, { required: readonly string[]; optional: readonly string[] }>;

export type ProviderOperationName<K extends ProviderKind> =
  | (typeof PROVIDER_OPERATIONS)[K]["required"][number]
  | (typeof PROVIDER_OPERATIONS)[K]["optional"][number];

/**
 * The built-in tax provider: the merchant's rates by tax region
 * (MARKETS-DESIGN D8). App tax providers are `<plugin id>:<provider id>`.
 */
export const SYSTEM_TAX_PROVIDER_ID = "system";

export function isProviderOperation(kind: ProviderKind, operation: string): boolean {
  const operations = PROVIDER_OPERATIONS[kind];
  return (operations.required as readonly string[]).includes(operation)
    || (operations.optional as readonly string[]).includes(operation);
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * An app provider's id as merchants select it and as orders, shipments and
 * settings store it: `<plugin id>:<provider id>` (`scalius.bkash:bkash`).
 * Built-in ids (`stripe`, `pathao`, `cod`) never contain a colon, so the two
 * can never collide, and a persisted id keeps its meaning after the app is
 * removed. A colon is a valid URL path character, so the id is one path
 * segment in callback and webhook URLs.
 */
export function qualifiedProviderId(pluginId: string, providerId: string): string {
  return `${pluginId}:${providerId}`;
}

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,47}$/;

/** The plugin and provider of an app provider id; null for a built-in id or anything malformed. */
export function parseQualifiedProviderId(id: unknown): { pluginId: string; providerId: string } | null {
  if (typeof id !== "string") return null;
  const colon = id.indexOf(":");
  if (colon === -1) return null;
  const pluginId = id.slice(0, colon);
  const providerId = id.slice(colon + 1);
  return PLUGIN_ID.test(pluginId) && PROVIDER_ID.test(providerId) ? { pluginId, providerId } : null;
}

export function isQualifiedProviderId(id: unknown): id is string {
  return parseQualifiedProviderId(id) !== null;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * - `retryable`: a transient fault (network, rate limit, provider outage).
 *   With `uncertain`, the provider may already have acted (a timeout after
 *   the request left): the caller keeps the operation for reconciliation and
 *   never simply submits it again.
 * - `declined`: the provider refused this request (a declined payment, an
 *   undeliverable address). Final for this input.
 * - `misconfigured`: missing, unreadable or rejected credentials or settings,
 *   or an operation this provider cannot do. The merchant must act; callers
 *   fail closed.
 */
export const PROVIDER_ERROR_CATEGORIES = ["retryable", "declined", "misconfigured"] as const;
export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * The one error a port operation raises. Its message must be safe to show a
 * merchant: never a raw provider body, a credential or buyer contact data.
 * `code` is a short stable identifier (`bkash.2023`, `provider.timeout`).
 */
export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly uncertain: boolean;
  readonly code: string;

  constructor(category: ProviderErrorCategory, message: string, options: { uncertain?: boolean; code?: string } = {}) {
    super(message);
    this.name = "ProviderError";
    this.category = category;
    this.uncertain = options.uncertain === true;
    this.code = options.code && ERROR_CODE.test(options.code) ? options.code : `provider.${category}`;
  }
}

/** A `ProviderError`, or an error that crossed a loader boundary carrying the same fields. */
export function providerErrorOf(error: unknown): ProviderError | null {
  if (error instanceof ProviderError) return error;
  if (!(error instanceof Error) && (typeof error !== "object" || error === null)) return null;
  const candidate = error as { category?: unknown; message?: unknown; uncertain?: unknown; code?: unknown };
  if (!(PROVIDER_ERROR_CATEGORIES as readonly unknown[]).includes(candidate.category)) return null;
  return new ProviderError(
    candidate.category as ProviderErrorCategory,
    typeof candidate.message === "string" ? candidate.message : "The provider could not complete the operation.",
    { uncertain: candidate.uncertain === true, ...(typeof candidate.code === "string" ? { code: candidate.code } : {}) },
  );
}
