// Provider ports: the kinds, their operations, provider identities and the
// typed error every port raises (packages/plugin-sdk/docs/apps.md, "Providers").
//
// A port is one interface per kind (payment, courier, sms, email,
// courier_history, tax, translation, ai, messaging, push, search, address,
// fx, identity). The platform's own adapters (COD, Stripe, the email
// providers, Web Push) and app providers (the Bangladesh pack's SSLCommerz,
// couriers, SMS gateways and courier-history checkers; bKash; Nagad)
// implement the same port; core code resolves a provider by id and
// never asks which kind of implementation it got. Ports are part of the
// versioned plugin API (`PLUGIN_API_VERSION`): within a version they change
// only additively.
//
// Kept free of zod: the sandbox wrapper and the SDK root bundle this file.

export const PROVIDER_KINDS = [
  "payment", "courier", "sms", "email", "courier_history", "tax", "translation", "ai",
  "messaging", "push", "search", "address", "fx", "identity",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Kinds a stored manifest or grant may still name, read as their current
 * kind: `shipping` became `courier`, and `fraud` became `courier_history`
 * (it reports courier history for a phone; a general order-risk port is a
 * planned beta `risk` kind, not this one).
 */
export const RENAMED_PROVIDER_KINDS = { shipping: "courier", fraud: "courier_history" } as const satisfies Record<string, ProviderKind>;

/** The current kind a stored name means (`fraud` → `courier_history`); anything else unchanged. */
export function currentProviderKind(name: string): string {
  return Object.hasOwn(RENAMED_PROVIDER_KINDS, name) ? RENAMED_PROVIDER_KINDS[name as keyof typeof RENAMED_PROVIDER_KINDS] : name;
}

/**
 * Every operation of every port: `required` ones an implementation must
 * have, `optional` ones it may add. The host refuses to call an operation an
 * implementation does not have; nothing else is ever invoked.
 */
export const PROVIDER_OPERATIONS = {
  payment: {
    required: ["createSession", "verifyWebhook"],
    optional: [
      "verifyReturn", "queryPayment", "refund", "refundStatus", "listRefunds", "testConnection",
      // Saved methods and authorizations (the descriptor's `vault` and `manualCapture`).
      "chargeSavedMethod", "capture", "void", "deleteSavedMethod",
    ],
  },
  courier: {
    required: ["createShipment", "trackShipment"],
    optional: ["rates", "quote", "cancelShipment", "findShipment", "verifyWebhook", "reconcileCod", "testConnection"],
  },
  sms: { required: ["send"], optional: ["deliveryStatus", "testConnection"] },
  email: { required: ["send"], optional: ["deliveryStatus", "testConnection"] },
  // What courier networks know about a buyer's phone (the order page's lookup).
  courier_history: { required: ["check"], optional: ["testConnection"] },
  tax: { required: ["calculate"], optional: ["commit", "void", "refund", "testConnection"] },
  // Machine translation (MARKETS-DESIGN D9): no built-in provider, apps only.
  translation: { required: ["translate"], optional: ["testConnection"] },
  // AI drafting (the theme editor's "Draft with AI"): no built-in provider or key, apps only.
  ai: { required: ["generate"], optional: ["testConnection"] },
  // Chat channels (WhatsApp, Messenger, …): the built-in WhatsApp sender or an app's.
  messaging: { required: ["send"], optional: ["deliveryStatus", "testConnection"] },
  // A push service with its own subscribers; Web Push (VAPID) is built in.
  push: { required: ["send"], optional: ["testConnection"] },
  // Product ids for a buyer's words; built-in full-text search is the fallback.
  search: { required: ["search"], optional: ["testConnection"] },
  // Address suggestions as the buyer types.
  address: { required: ["suggest", "resolve"], optional: ["testConnection"] },
  // Exchange rates for markets in their own currency; manual rates are the default.
  fx: { required: ["rates"], optional: ["testConnection"] },
  // Buyer sign-in with another account (OAuth 2.0 code with PKCE).
  identity: { required: ["authorize", "exchange"], optional: ["testConnection"] },
} as const satisfies Record<ProviderKind, { required: readonly string[]; optional: readonly string[] }>;

/**
 * How far each port is sealed. `stable`: a real provider implements it and
 * its schemas change only additively within `PLUGIN_API_VERSION` (the ABI
 * snapshot seals them). `beta`: no app implementation proves it yet, so its
 * schemas may still change; any app may implement it, and the consent screen
 * labels it Beta. Promoting a port is changing its entry to `stable`, which
 * only adds to the sealed ABI; a stable port never goes back
 * (abi.snapshot.test.ts refuses it).
 */
export const PROVIDER_PORT_TIERS = {
  payment: "stable",
  courier: "stable",
  sms: "stable",
  courier_history: "stable",
  email: "beta",
  tax: "beta",
  translation: "beta",
  ai: "beta",
  messaging: "beta",
  push: "beta",
  search: "beta",
  address: "beta",
  fx: "beta",
  identity: "beta",
} as const satisfies Record<ProviderKind, "stable" | "beta">;
export type ProviderPortTier = (typeof PROVIDER_PORT_TIERS)[ProviderKind];

export function isStableProviderPort(kind: ProviderKind): boolean {
  return PROVIDER_PORT_TIERS[kind] === "stable";
}

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
 * settings store it: `<plugin id>:<provider id>` (`scalius.bangladesh:bkash`).
 * Built-in ids (`stripe`, `pathao`, `cod`) never contain a colon, so the two
 * can never collide, and a persisted id keeps its meaning after the app is
 * removed. A colon is a valid URL path character, so the id is one path
 * segment in callback and webhook URLs.
 */
export function qualifiedProviderId(pluginId: string, providerId: string): string {
  return `${pluginId}:${providerId}`;
}

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,47}$/;

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
 * `code` is a short stable identifier (`bkash_2023`, `provider_timeout`).
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
    this.code = options.code && ERROR_CODE.test(options.code) ? options.code : `provider_${category}`;
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
