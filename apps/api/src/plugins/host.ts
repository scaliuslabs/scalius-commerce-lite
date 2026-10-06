// The plugin host facade (docs/platform/PLUGINS.md): picks the loader for an
// installation (bundled in-process, or a sandboxed Dynamic Worker), seeds the
// invocation (identity, store facts, opened settings), races it against the
// manifest's wall time, validates what comes back and writes the plugin's
// log lines plus any incident. A plugin that throws, times out or returns an
// invalid value fails open: the caller gets no output and the merchant sees
// the incident in the plugin's log. Provider operations are the exception:
// they answer with the port's output or raise the port's `ProviderError`, and
// the caller (checkout, delivery, notifications) applies its own policy.
// Create one host per request.

import type { Database } from "@scalius/database/client";
import { getDb } from "@scalius/database/client";
import {
  effectivePluginPermissions,
  markPluginFailed,
  maskPluginLogText,
  readPluginRuntimeSettings,
  writePluginLogs,
  type PluginInstallation,
  type PluginLogInput,
} from "@scalius/core/modules/plugins";
import { readStoreIdentity } from "@scalius/core/modules/notifications";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { storeTimeZoneOf } from "../utils/store-time-zone";
import {
  PLUGIN_FUNCTION_SCHEMAS,
  pluginHandlerInventory,
  validatePluginSettingValues,
  type PluginFunctionOutput,
  type PluginFunctionPoint,
  type PluginLifecycleHook,
} from "@scalius/shared/plugins";
import {
  ProviderError,
  declaredProviderOperations,
  providerOperationSchemas,
  type ProviderErrorCategory,
  type ProviderKind,
  type ProviderOperation,
  type ProviderOperationInput,
  type ProviderOperationOutput,
} from "@scalius/shared/plugins/providers";
import type { PluginEvent, PluginRouteRequest, PluginRouteResponse, PluginStoreInfo } from "@scalius/plugin-sdk";
import type { PluginBridgeAuthority, PluginBridgeEnvironment, PluginBridgeProps } from "./bridge";
import { BundledLoader } from "./loaders/bundled";
import { SandboxLoader } from "./loaders/sandbox";
import { PluginLoadError, type PluginLoader } from "./loaders/types";
import type { PluginContextSeed, PluginInvocation, PluginInvocationResult } from "@scalius/plugin-sdk/runtime";

/** Functions sit on checkout's path: their wall time is capped below the manifest's. */
export const PLUGIN_FUNCTION_WALL_MS = 1_500;
export const PLUGIN_ROUTE_BODY_MAX_BYTES = 1024 * 1024;
const ROUTE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const ROUTE_FORBIDDEN_HEADERS = /^(?:set-cookie|content-length|transfer-encoding|connection|access-control-.*|strict-transport-security|content-security-policy.*)$/i;

/**
 * Why an invocation did not produce a value: the plugin is not active, the
 * installation was just updated to the deployed build (try again), the
 * platform cannot load it here (no sandbox), its code could not be loaded
 * (the plugin is now failed), it ran out of wall time, it threw, it
 * returned an invalid value, or (provider operations only) its secrets could
 * not be opened.
 */
export type PluginInvocationFailure = "inactive" | "outdated" | "unavailable" | "load_failed" | "timeout" | "error" | "invalid" | "settings_unreadable";

export interface PluginInvocationOutcome<T = null> {
  ok: boolean;
  value: T | null;
  /** Plain-language reason when not ok (also written to the plugin's log). */
  error: string | null;
  /** Set when not ok. */
  failure?: PluginInvocationFailure;
}

export interface PluginHostOptions {
  /** The composed request env (derived secrets, Platform origins). */
  env: Env;
  ctx: ExecutionContext;
  db?: Database;
  /** Test seam: replaces the loader choice. */
  loaderFor?: (installation: PluginInstallation) => PluginLoader;
  /**
   * The store facts handlers see (`ctx.store`), when the caller reads them
   * itself: storefront renders read exactly the rows whose cache keys they
   * declare (storefront-render.ts).
   */
  store?: () => Promise<PluginStoreInfo>;
}

/** The authority the bridge enforces for one installation: its approved grant, within the manifest. */
export function pluginBridgeAuthority(installation: PluginInstallation): PluginBridgeAuthority {
  const grant = installation.grant;
  const manifest = installation.manifest;
  const grantedHosts = new Set(grant?.allowedHosts ?? []);
  const grantedOwners = new Set(grant?.customFieldOwners ?? []);
  return {
    permissions: [...effectivePluginPermissions(grant)].sort(),
    allowedHosts: manifest.allowedHosts.filter((host) => grantedHosts.has(host)),
    collections: Object.fromEntries(Object.entries(manifest.storage).map(([name, collection]) => [
      name,
      { indexes: collection.indexes, unique: collection.unique },
    ])),
    customFields: manifest.customFields
      .filter((field) => grantedOwners.has(field.ownerType))
      .map((field) => ({
        ownerType: field.ownerType,
        key: field.key,
        name: field.name,
        type: field.type,
        ...(field.description ? { description: field.description } : {}),
        storefrontVisible: field.storefrontVisible,
      })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A route handler's response, normalized; null when it is not a valid response. */
export function validatePluginRouteResponse(value: unknown): { status: number; headers: Record<string, string>; body: unknown } | string {
  const response = (value ?? {}) as PluginRouteResponse;
  if (!isRecord(response)) return "A route returns { status?, headers?, body? }.";
  const extra = Object.keys(response).find((key) => key !== "status" && key !== "headers" && key !== "body");
  if (extra) return `Unknown route response property "${extra}".`;
  const status: unknown = response.status ?? 200;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) return "status is an HTTP status from 200 to 599.";
  const headers: Record<string, string> = {};
  if (response.headers !== undefined) {
    if (!isRecord(response.headers)) return "headers is an object of strings.";
    for (const [name, header] of Object.entries(response.headers)) {
      if (typeof header !== "string" || !ROUTE_HEADER_NAME.test(name) || /[\r\n]/.test(header)) return `Invalid header ${name}.`;
      if (ROUTE_FORBIDDEN_HEADERS.test(name)) return `The ${name} header is set by the platform.`;
      headers[name] = header;
    }
  }
  let body: unknown = null;
  if (response.body !== undefined) {
    let json: string | undefined;
    try {
      json = JSON.stringify(response.body);
    } catch {
      return "body must be JSON-serializable.";
    }
    if (json === undefined) return "body must be JSON-serializable.";
    if (new TextEncoder().encode(json).byteLength > PLUGIN_ROUTE_BODY_MAX_BYTES) return "body is at most 1 MiB of JSON.";
    body = JSON.parse(json) as unknown;
  }
  return { status, headers, body };
}

export class PluginHost {
  private readonly env: Env;
  private readonly ctx: ExecutionContext;
  private readonly db: Database;
  private readonly loaderFor: (installation: PluginInstallation) => PluginLoader;
  private storeInfo: Promise<PluginStoreInfo> | null = null;
  private readonly storeSource: (() => Promise<PluginStoreInfo>) | undefined;
  private readonly settings = new Map<string, Promise<Awaited<ReturnType<typeof readPluginRuntimeSettings>>>>();

  constructor(options: PluginHostOptions) {
    this.env = options.env;
    this.ctx = options.ctx;
    this.db = options.db ?? getDb(options.env);
    this.storeSource = options.store;
    const bridgeEnvironment: PluginBridgeEnvironment = {
      env: this.env,
      ctx: this.ctx,
      db: () => this.db,
      composedEnv: async () => this.env,
    };
    const bundled = new BundledLoader(bridgeEnvironment);
    const sandbox = new SandboxLoader(this.env, this.ctx);
    this.loaderFor = options.loaderFor ?? ((installation) =>
      installation.source === "bundled" ? bundled : sandbox);
  }

  async invokeFunction<P extends PluginFunctionPoint>(
    installation: PluginInstallation,
    point: P,
    input: unknown,
  ): Promise<PluginInvocationOutcome<PluginFunctionOutput<P>>> {
    const wallMs = Math.min(installation.manifest.limits.wallMs, PLUGIN_FUNCTION_WALL_MS);
    const outcome = await this.run(installation, { kind: "function", point, input }, `function:${point}`, wallMs);
    if (!outcome.ok) return failed(outcome);
    const parsed = PLUGIN_FUNCTION_SCHEMAS[point].output.safeParse(outcome.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const reason = `Invalid ${point} output${issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""}.`;
      await this.incident(installation, `function:${point}`, reason);
      return { ok: false, value: null, error: reason, failure: "invalid" };
    }
    return { ok: true, value: parsed.data as PluginFunctionOutput<P>, error: null };
  }

  /**
   * One operation of an app provider, as the port defines it: the input is
   * the platform's own (a mismatch is a platform bug and throws), the answer
   * is validated, and every failure becomes the port's `ProviderError`: the
   * provider's own category, `retryable` + `uncertain` for a timeout, a
   * throw or an invalid answer (it may have acted), `misconfigured` when the
   * app cannot run (inactive, not approved, unreadable secrets, no sandbox).
   * Messages are masked against the app's secrets.
   */
  async invokeProvider<K extends ProviderKind, M extends ProviderOperation<K>>(
    installation: PluginInstallation,
    kind: K,
    providerId: string,
    operation: M,
    input: ProviderOperationInput<K, M>,
    options: { wallMs?: number } = {},
  ): Promise<ProviderOperationOutput<K, M>> {
    const source = `provider:${providerId}.${operation}`;
    const declaration = installation.manifest.providers.find((provider) => provider.id === providerId && provider.kind === kind);
    if (!declaration) throw new ProviderError("misconfigured", `${installation.manifest.name} does not provide this ${kind} provider.`);
    if (!installation.grant?.providers.includes(kind)) {
      throw new ProviderError("misconfigured", `${installation.manifest.name} is not approved to provide ${kind}.`);
    }
    if (!declaredProviderOperations(declaration).includes(operation)) {
      throw new ProviderError("misconfigured", `${declaration.name} does not support ${operation}.`, { code: "provider.unsupported" });
    }
    const schemas = providerOperationSchemas(kind, operation)!;
    const checked = schemas.input.safeParse(input);
    if (!checked.success) throw new TypeError(`invokeProvider(${kind}.${operation}) received an input that does not match the port.`);

    const wallMs = Math.min(installation.manifest.limits.wallMs, options.wallMs ?? Number.POSITIVE_INFINITY);
    const outcome = await this.run(
      installation,
      { kind: "provider", provider: providerId, operation, input: checked.data },
      source,
      wallMs,
      { provider: { kind } },
    );
    if (!outcome.ok) throw providerFailure(outcome, declaration.name);
    const parsed = schemas.output.safeParse(outcome.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // The path only: an invalid answer can hold provider payloads or buyer data.
      await this.incident(installation, source, `Invalid ${operation} answer${issue ? ` at ${issue.path.join(".") || "(root)"}` : ""}.`);
      throw new ProviderError("retryable", `${declaration.name} returned an invalid answer.`, { uncertain: true, code: "provider.invalid_response" });
    }
    return parsed.data as ProviderOperationOutput<K, M>;
  }

  async invokeEvent(installation: PluginInstallation, event: PluginEvent): Promise<PluginInvocationOutcome> {
    const outcome = await this.run(installation, { kind: "event", event }, `event:${event.topic}`, installation.manifest.limits.wallMs);
    return outcome.ok ? { ok: true, value: null, error: null } : failed(outcome);
  }

  async invokeRoute(
    installation: PluginInstallation,
    surface: "admin" | "public" | "webhooks",
    name: string,
    request: PluginRouteRequest,
    options: {
      /** Storefront output: read-only bridge over these collections, and a wall time capped like functions. */
      render?: { collections: string[]; wallMs: number };
    } = {},
  ): Promise<PluginInvocationOutcome<{ status: number; headers: Record<string, string>; body: unknown }>> {
    const source = `route:${surface}/${name}`;
    const wallMs = options.render ? Math.min(installation.manifest.limits.wallMs, options.render.wallMs) : installation.manifest.limits.wallMs;
    const outcome = await this.run(
      installation,
      { kind: "route", surface, name, request },
      source,
      wallMs,
      options.render ? { render: { collections: [...options.render.collections] } } : {},
    );
    if (!outcome.ok) return failed(outcome);
    const response = validatePluginRouteResponse(outcome.value);
    if (typeof response === "string") {
      await this.incident(installation, source, `Invalid route response: ${response}`);
      return { ok: false, value: null, error: response, failure: "invalid" };
    }
    return { ok: true, value: response, error: null };
  }

  async invokeCron(installation: PluginInstallation, name: string, scheduledAt: string): Promise<PluginInvocationOutcome> {
    const outcome = await this.run(installation, { kind: "cron", name, scheduledAt }, `cron:${name}`, installation.manifest.limits.wallMs);
    return outcome.ok ? { ok: true, value: null, error: null } : failed(outcome);
  }

  async invokeLifecycle(
    installation: PluginInstallation,
    hook: PluginLifecycleHook,
    options: { keepData?: boolean } = {},
  ): Promise<PluginInvocationOutcome> {
    const outcome = await this.run(installation, { kind: "lifecycle", hook, keepData: options.keepData }, `lifecycle:${hook}`, installation.manifest.limits.wallMs);
    return outcome.ok ? { ok: true, value: null, error: null } : failed(outcome);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private runtimeSettings(installation: PluginInstallation) {
    const key = `${installation.pluginId}@${installation.revision}`;
    let settings = this.settings.get(key);
    if (!settings) {
      settings = readPluginRuntimeSettings(installation, this.env.CREDENTIAL_ENCRYPTION_KEY);
      this.settings.set(key, settings);
    }
    return settings;
  }

  private store(): Promise<PluginStoreInfo> {
    if (this.storeSource) {
      this.storeInfo ??= this.storeSource();
      return this.storeInfo;
    }
    this.storeInfo ??= Promise.all([readStoreIdentity(this.db), readStoreCurrency(this.db)]).then(([identity, currency]) => ({
      name: identity.name ?? "",
      url: this.env.STOREFRONT_URL?.trim() || null,
      currency: currency.code,
      decimalPlaces: currency.decimalPlaces,
      timezone: storeTimeZoneOf(this.env),
      locale: identity.language === "bn" ? "bn-BD" : "en",
    }));
    return this.storeInfo;
  }

  private async seed(installation: PluginInstallation, needsStore: boolean): Promise<{ seed: PluginContextSeed; secrets: string[]; unreadable: string[] }> {
    const [settings, store] = await Promise.all([
      this.runtimeSettings(installation),
      needsStore ? this.store() : Promise.resolve(null),
    ]);
    const secrets = installation.manifest.settings
      .filter((field) => field.type === "secret")
      .map((field) => settings.values[field.key])
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return {
      seed: {
        plugin: { id: installation.pluginId, version: installation.version },
        store: store ?? { name: "", url: null, currency: "", decimalPlaces: 0, timezone: storeTimeZoneOf(this.env), locale: "en" },
        settings: settings.values,
        collections: Object.keys(installation.manifest.storage),
        inventory: pluginHandlerInventory(installation.manifest),
      },
      secrets,
      unreadable: settings.unreadableSecrets,
    };
  }

  private bridgeProps(installation: PluginInstallation, mode: BridgeMode): PluginBridgeProps {
    return {
      pluginId: installation.pluginId,
      version: installation.version,
      authority: pluginBridgeAuthority(installation),
      ...(mode.render ? { render: mode.render } : {}),
      ...(mode.provider ? { provider: mode.provider } : {}),
    };
  }

  /** Incidents found after a run (an invalid answer): written to the plugin's log like the run's own. */
  async reportIncident(installation: PluginInstallation, source: string, message: string): Promise<void> {
    await this.incident(installation, source, message);
  }

  private async run(
    installation: PluginInstallation,
    invocation: PluginInvocation,
    source: string,
    wallMs: number,
    mode: BridgeMode = {},
  ): Promise<RunOutcome> {
    if (installation.status !== "active") {
      return { ok: false, value: null, error: `${installation.pluginId} is not active.`, failure: "inactive" };
    }
    const { seed, secrets, unreadable } = await this.seed(installation, invocation.kind !== "function");
    const lines: PluginLogInput[] = [];
    if (unreadable.length > 0) {
      lines.push({ level: "warn", source: "host", message: `Secret settings could not be opened: ${unreadable.join(", ")}.` });
    }
    // A provider never runs with credentials it cannot read or settings the
    // merchant has not completed (fail closed).
    if (mode.provider && (unreadable.length > 0 || !validatePluginSettingValues(installation.manifest.settings, seed.settings).ok)) {
      const error = unreadable.length > 0
        ? "The app's credentials could not be opened; save them again."
        : "The app's settings are incomplete.";
      await this.writeLogs(installation, [...lines, { level: "error", source: "host", message: `${source}: ${error}` }], secrets);
      return { ok: false, value: null, error, failure: "settings_unreadable" };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PluginTimeoutError(wallMs)), wallMs);
    });
    let result: PluginInvocationResult | null = null;
    let error: string | null = null;
    let failure: PluginInvocationFailure = "error";
    try {
      result = await Promise.race([
        this.loaderFor(installation).invoke({ installation, invocation, seed, bridgeProps: this.bridgeProps(installation, mode) }),
        timeout,
      ]);
    } catch (thrown) {
      if (thrown instanceof PluginTimeoutError) {
        error = `${source} exceeded its ${wallMs} ms wall-time limit.`;
        failure = "timeout";
      } else if (thrown instanceof PluginLoadError && thrown.outdated) {
        // The deployment carries a newer build: bring the installation in
        // step (bundled-sync.ts); the next call runs the new version, or
        // waits for approval when the update asks for more access.
        const { syncBundledPlugin } = await import("./bundled-sync");
        const synced = await syncBundledPlugin(this.db, installation.pluginId).catch(() => null);
        error = synced
          ? `${installation.pluginId} was updated to ${synced.version}${synced.status === "active" ? "" : " and waits for approval"}.`
          : thrown.message;
        failure = synced ? "outdated" : "load_failed";
        if (!synced) await markPluginFailed(this.db, installation.pluginId, thrown.message);
      } else if (thrown instanceof PluginLoadError) {
        error = thrown.message;
        failure = thrown.markFailed ? "load_failed" : "unavailable";
        if (thrown.markFailed) await markPluginFailed(this.db, installation.pluginId, thrown.message);
      } else {
        error = `${source} failed: ${thrown instanceof Error ? thrown.name : "error"}.`;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    let provider: RunProviderError | undefined;
    if (result) {
      for (const line of result.logs) lines.push({ level: line.level, source, message: line.message, fields: line.fields });
      if (result.droppedLogs > 0) lines.push({ level: "warn", source: "host", message: `${result.droppedLogs} log lines past the limit were dropped.` });
      if (!result.ok) {
        error = result.error?.message ?? `${source} failed.`;
        if (result.error?.code === "plugin.handlers_mismatch" || result.error?.code === "plugin.identity_mismatch") {
          await markPluginFailed(this.db, installation.pluginId, error);
          failure = "load_failed";
        } else if (result.error?.category) {
          provider = {
            category: result.error.category,
            uncertain: result.error.uncertain === true,
            code: result.error.code,
            message: maskPluginLogText(result.error.message, secrets),
          };
        }
      }
    }
    if (error) lines.push({ level: failure === "outdated" ? "info" : "error", source: "host", message: `${source}: ${error}` });
    await this.writeLogs(installation, lines, secrets);
    if (!error) return { ok: true, value: result?.value ?? null, error: null };
    return { ok: false, value: null, error: maskPluginLogText(error, secrets), failure, ...(provider ? { provider } : {}) };
  }

  /** A refusal of the app's output, logged for the merchant (masked against the app's secrets). */
  async incident(installation: PluginInstallation, source: string, message: string): Promise<void> {
    const { secrets } = await this.seed(installation, false);
    await this.writeLogs(installation, [{ level: "error", source: "host", message: `${source}: ${message}` }], secrets);
  }

  private async writeLogs(installation: PluginInstallation, lines: PluginLogInput[], secrets: string[]): Promise<void> {
    if (lines.length === 0) return;
    try {
      await writePluginLogs(this.db, installation.pluginId, lines, { secrets });
    } catch {
      console.warn(`[plugins] ${installation.pluginId} log write failed`);
    }
  }
}

/** What the bridge is set up for besides the default: a storefront render, or a provider operation. */
type BridgeMode = Pick<PluginBridgeProps, "render" | "provider">;

/** A `ProviderError` an operation raised, as it crossed the loader (message already masked). */
interface RunProviderError {
  category: ProviderErrorCategory;
  uncertain: boolean;
  code: string | null;
  message: string;
}

type RunOutcome =
  | { ok: true; value: unknown; error: null }
  | { ok: false; value: null; error: string; failure: PluginInvocationFailure; provider?: RunProviderError };

function failed<T>(outcome: Extract<RunOutcome, { ok: false }>): PluginInvocationOutcome<T> {
  return { ok: false, value: null, error: outcome.error, failure: outcome.failure };
}

/** A failed provider run as the port's error (see `invokeProvider`). */
function providerFailure(outcome: Extract<RunOutcome, { ok: false }>, providerName: string): ProviderError {
  if (outcome.provider) {
    return new ProviderError(outcome.provider.category, outcome.provider.message.slice(0, 300), {
      uncertain: outcome.provider.uncertain,
      ...(outcome.provider.code ? { code: outcome.provider.code } : {}),
    });
  }
  switch (outcome.failure) {
    case "timeout":
      return new ProviderError("retryable", `${providerName} did not answer in time.`, { uncertain: true, code: "provider.timeout" });
    case "outdated":
      return new ProviderError("retryable", `${providerName} was just updated; try again.`, { code: "provider.updated" });
    case "inactive":
    case "unavailable":
    case "load_failed":
    case "settings_unreadable":
      return new ProviderError("misconfigured", outcome.error.slice(0, 300), { code: `provider.${outcome.failure}` });
    default:
      // A throw that was not a ProviderError: the provider may have acted before it.
      return new ProviderError("retryable", `${providerName} could not complete the operation.`, { uncertain: true, code: "provider.error" });
  }
}

class PluginTimeoutError extends Error {
  constructor(readonly wallMs: number) {
    super(`Plugin exceeded ${wallMs} ms`);
    this.name = "PluginTimeoutError";
  }
}
