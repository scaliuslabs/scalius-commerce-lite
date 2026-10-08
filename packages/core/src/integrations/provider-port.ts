// The SMS, email, fraud, tax, translation, AI, messaging, push, search,
// address, FX and identity ports as core calls them (docs/platform/PLUGINS.md,
// "Providers"). Every provider a merchant can choose, built in (an adapter in
// this package bound to its saved settings) or an app's
// (`<plugin id>:<provider id>`), is one `BoundProvider` of its port: callers
// send and check through it and never ask which kind they got.
//
// Only the API can run an app (it owns the plugin host), so it hands core an
// `AppProviders` lookup for the request or queue message. Core asks it only
// when the saved choice names an app, so a store that uses built-in providers
// reads no plugin table. Without a lookup an app choice fails closed: not
// ready, nothing sent.

import {
  PROVIDER_OPERATIONS,
  isQualifiedProviderId,
  type ProviderCountries,
  type ProviderKind,
  type ProviderPort,
} from "@scalius/shared/plugins/providers";

/** What every provider call gets besides its input. */
export interface ProviderCall {
  /** Aborts the provider call. */
  signal?: AbortSignal;
}

/** One provider of a port, ready to call. */
export type BoundProvider<K extends ProviderKind> = ProviderPort<K, ProviderCall> & {
  /** A built-in id (`gennet`, `resend`, `fraudbd`) or `<plugin id>:<provider id>`. */
  readonly id: string;
  /** Merchant-facing name. */
  readonly label: string;
  /** The countries it serves (a fraud checker's buyers); absent means any. */
  readonly countries?: ProviderCountries;
  /** The chat channels a messaging provider carries (`whatsapp`, ...); absent for other ports. */
  readonly channels?: readonly string[];
};

/** A built-in call: the adapter's saved settings travel with the call. */
export interface SettingsCall<S> extends ProviderCall {
  settings: S;
}

/** A built-in adapter: one provider's API behind the port, configured per call. */
export type BuiltInAdapter<K extends ProviderKind, S> = ProviderPort<K, SettingsCall<S>> & {
  readonly id: string;
  readonly label: string;
  /** The countries it serves; absent means any. */
  readonly countries?: ProviderCountries;
};

/** The adapter with its settings bound: the port the rest of core calls. */
export function bindProvider<K extends ProviderKind, S>(kind: K, adapter: BuiltInAdapter<K, S>, settings: S): BoundProvider<K> {
  const bound: Record<string, unknown> = { id: adapter.id, label: adapter.label };
  if (adapter.countries !== undefined) bound.countries = adapter.countries;
  const source = adapter as unknown as Record<string, unknown>;
  for (const operation of [...PROVIDER_OPERATIONS[kind].required, ...PROVIDER_OPERATIONS[kind].optional]) {
    const method = source[operation];
    if (typeof method === "function") {
      bound[operation] = (input: unknown, call: ProviderCall = {}) => method.call(adapter, input, { ...call, settings });
    }
  }
  return bound as BoundProvider<K>;
}

/** The ports core reaches through `AppProviders` (payments and couriers have their own registries). */
export type AppProviderKind = Exclude<ProviderKind, "payment" | "courier">;

/**
 * Whether a saved choice names an app provider (`<plugin id>:<provider id>`)
 * rather than a built-in one. Not a type guard: both are strings, so the
 * built-in branch keeps its type.
 */
export function isAppProviderId(id: string): boolean {
  return isQualifiedProviderId(id);
}

/** An app provider a merchant chose: callable, or why it cannot be used now (merchant-facing). */
export type AppProviderChoice<K extends AppProviderKind> =
  | { provider: BoundProvider<K>; issue: null }
  | { provider: null; issue: string };

/** The app providers one request (or queue message) can reach. */
export interface AppProviders {
  /**
   * The app provider `id` names, when the app is installed, active, approved
   * for the port, runnable here and its settings complete and readable.
   */
  resolve<K extends AppProviderKind>(kind: K, id: string): Promise<AppProviderChoice<K>>;
}

/** An app choice through the request's lookup; without one it fails closed. */
export function resolveAppProvider<K extends AppProviderKind>(
  apps: AppProviders | undefined,
  kind: K,
  id: string,
): Promise<AppProviderChoice<K>> {
  if (!apps) return Promise.resolve({ provider: null, issue: "The selected app provider cannot run here." });
  return apps.resolve(kind, id);
}
