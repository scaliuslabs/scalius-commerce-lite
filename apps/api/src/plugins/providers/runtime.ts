// What every app provider adapter needs from the request: one plugin host
// (created on first use, so a request that only reads readiness loads no
// plugin code), whether this deployment can run an installation at all
// (compiled in, or the Workers Paid sandbox), and the strict read of the
// app's settings that readiness and every call rely on. Nothing here
// outlives the request that created it.

import type { Database } from "@scalius/database/client";
import {
  readPluginRuntimeSettings,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { looksLikePlaceholderCredential } from "@scalius/shared/plugins/placeholder-credentials";
import { validatePluginSettingValues } from "@scalius/shared/plugins/settings-schema";
import type { PluginProviderDeclaration } from "@scalius/shared/plugins/providers";
import { BUNDLED_PLUGINS } from "../bundled.gen";
import type { PluginHost } from "../host";
import { isPluginSandboxAvailable } from "../loaders/sandbox-availability";

export interface AppProviderRuntime {
  env: Env;
  db: Database;
  /** The request's plugin host, created on first use. */
  host(): Promise<PluginHost>;
  /** Whether this deployment can run the installation's code. */
  canRun(installation: PluginInstallation): boolean;
}

/** A context for plugin work outside a Worker invocation (queues, scheduled jobs, tests). */
export function detachedExecutionContext(): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
    passThroughOnException: () => undefined,
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}

export function createAppProviderRuntime(options: { env: Env; db: Database; ctx?: ExecutionContext }): AppProviderRuntime {
  const ctx = options.ctx ?? detachedExecutionContext();
  let host: Promise<PluginHost> | null = null;
  return {
    env: options.env,
    db: options.db,
    host() {
      host ??= import("../host").then(({ PluginHost }) => new PluginHost({ env: options.env, ctx, db: options.db }));
      return host;
    },
    canRun(installation) {
      return installation.source === "bundled"
        ? Object.hasOwn(BUNDLED_PLUGINS, installation.pluginId)
        : isPluginSandboxAvailable(options.env, ctx);
    },
  };
}

/** The parts of a Hono request context provider work needs. */
export interface RequestLike {
  env: Env;
  req: { raw: Request };
  get(key: "db"): Database;
  executionCtx?: unknown;
}

function executionContextOf(c: RequestLike): ExecutionContext | undefined {
  try {
    return c.executionCtx as ExecutionContext | undefined;
  } catch {
    return undefined;
  }
}

/** The runtime app providers of one Hono request use (one plugin host per request). */
export function requestProviderRuntime(c: RequestLike): AppProviderRuntime {
  return createAppProviderRuntime({ env: c.env, db: c.get("db"), ctx: executionContextOf(c) });
}

/** What an app provider's saved settings allow, as every settings page and readiness check reads it. */
export interface AppProviderSettings {
  /** The app is active, approved for the port and runnable here. */
  enabled: boolean;
  /** Required settings the merchant has not filled. */
  missingFields: string[];
  /** Secrets that could not be opened (key rotated or missing). Never call the provider then. */
  credentialErrors: string[];
  /** From the app's `environment` setting (`sandbox` or `live`), when it has one. */
  environment: "test" | "live" | "unknown";
  /** Why the provider cannot be used, in the merchant's words. */
  blockedReason?: string;
}

/**
 * One provider's readiness. The app's required settings always count; a
 * provider that names its own settings (`providers.<kind>[].settings`, a
 * regional pack with several providers) also needs each of those set,
 * readable and not an obvious placeholder, and only its own unreadable
 * secrets block it: a broken key of one gateway never stops another.
 */
export async function readAppProviderSettings(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  provider: Pick<PluginProviderDeclaration, "kind" | "settings">,
  encryptionKey: string | undefined,
): Promise<AppProviderSettings> {
  const name = installation.manifest.name;
  const settings = await readPluginRuntimeSettings(installation, encryptionKey);
  const checked = validatePluginSettingValues(installation.manifest.settings, settings.values);
  const own = provider.settings;
  const labels = new Map(installation.manifest.settings.map((field) => [field.key, field.label]));
  const unreadable = own ? settings.unreadableSecrets.filter((key) => own.includes(key)) : settings.unreadableSecrets;
  // The app's required settings: activation itself needs them.
  const required = [...new Set(checked.ok ? [] : checked.errors.map((error) => error.key))];
  // The provider's own: the pack activates without them; this provider waits for them.
  const ownMissing: string[] = [];
  const placeholders: string[] = [];
  for (const key of own ?? []) {
    const value = settings.values[key];
    if (unreadable.includes(key) || required.includes(key)) continue;
    if (value === null || value === undefined || value === "") ownMissing.push(key);
    else if (typeof value === "string" && looksLikePlaceholderCredential(value)) placeholders.push(key);
  }
  const missingFields = [...required, ...ownMissing];
  const credentialErrors = [
    ...(unreadable.length > 0 ? [`${name} credentials could not be opened. Save them again in the app's settings.`] : []),
    ...placeholders.map((key) => `${labels.get(key) ?? key} looks like a placeholder. Save a real provider value in ${name}'s settings.`),
  ];
  const approved = installation.status === "active" && installation.grant?.providers.includes(provider.kind) === true;
  const runnable = runtime.canRun(installation);
  const environment = settings.values.environment === "live"
    ? "live"
    : settings.values.environment === "sandbox" ? "test" : "unknown";
  const complete = (keys: string[]) => `Complete ${name}'s settings: ${keys.map((key) => (own ? labels.get(key) ?? key : key)).join(", ")}.`;
  const blockedReason = credentialErrors[0]
    ?? (required.length > 0 ? complete(required) : undefined)
    ?? (!approved ? `Activate ${name} in Apps to use it.` : undefined)
    ?? (ownMissing.length > 0 ? complete(ownMissing) : undefined)
    ?? (!runnable ? `${name} needs the plugin sandbox (Workers Paid) or to be compiled into this deployment.` : undefined);
  return { enabled: approved && runnable, missingFields, credentialErrors, environment, ...(blockedReason ? { blockedReason } : {}) };
}

/** Rejects when the signal aborts first: the kernel's deadline applies to app calls too. */
export function withSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
