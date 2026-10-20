// Plugin handler inventory (docs/platform/PLUGINS.md): the handlers a plugin
// module must export, derived from its manifest, and the check that a module
// exports exactly those. It runs when a plugin is packed (`pnpm plugin
// build`), when the host loads a bundled plugin and inside a sandboxed
// plugin's wrapper, so an undeclared handler can never run and a declared one
// can never be missing. Pure and free of zod: the sandbox wrapper bundles it.
// Part of the versioned plugin API.

import { PROVIDER_KINDS, PROVIDER_OPERATIONS, type ProviderKind } from "./providers/kinds";

/** What a manifest declares, by handler kind (names as the manifest spells them). */
export interface PluginHandlerInventory {
  /** Topic filters (`order.paid`, `order.*`, `*`); each needs a handler under the same key. */
  events: string[];
  functions: string[];
  /** Storefront extensions by UI slot (`extensions: { "checkout.actions.before": render }`); absent in seeds from before they existed. */
  extensions?: string[];
  routes: { admin: string[]; public: string[]; webhooks: string[] };
  cron: string[];
  /** Each provider's port and the operations its implementation must have. */
  providers: PluginProviderInventory[];
  /** Declared data updates, by version (`migrations: { "1": handler }`); absent in seeds from before they existed. */
  migrations?: string[];
  /**
   * Handlers of features that are off (`manifest.features`): the module must
   * still export exactly them, but none of them runs. Absent when every
   * declared handler is live.
   */
  dormant?: PluginDormantInventory;
}

/** The handlers of features that are off, by kind. */
export interface PluginDormantInventory {
  events: string[];
  functions: string[];
  extensions?: string[];
  routes: { admin: string[]; public: string[]; webhooks: string[] };
  cron: string[];
  providers: PluginProviderInventory[];
}

export interface PluginProviderInventory {
  id: string;
  kind: ProviderKind;
  /** The operations the host may call: the port's required ones and the declared optional ones. */
  operations: string[];
}

/**
 * Lifecycle hooks are optional and need no declaration. `enable` and
 * `disable` run when a person turns one of the app's features on or off
 * (`{ feature }`), with the access the app has after the change.
 */
export const PLUGIN_LIFECYCLE_HOOKS = ["install", "activate", "deactivate", "uninstall", "enable", "disable"] as const;
export type PluginLifecycleHook = (typeof PLUGIN_LIFECYCLE_HOOKS)[number];

/** The manifest fields the inventory reads (a parsed `PluginManifest` satisfies it). */
export interface PluginHandlerManifest {
  events: readonly string[];
  functions: ReadonlyArray<{ point: string }>;
  storefront?: { extensions?: ReadonlyArray<{ target: string }> };
  routes: {
    admin: ReadonlyArray<{ name: string }>;
    public: ReadonlyArray<{ name: string }>;
    webhooks: ReadonlyArray<{ name: string }>;
  };
  cron: ReadonlyArray<{ name: string }>;
  providers: ReadonlyArray<{ id: string; kind: ProviderKind; operations: readonly string[] }>;
  migrations?: ReadonlyArray<{ version: number }>;
}

/**
 * The handlers a module must export. With `declared` (the manifest as
 * declared) and `manifest` the running one (features off removed), the
 * handlers of off features are listed as `dormant`: present, never run.
 */
export function pluginHandlerInventory(manifest: PluginHandlerManifest, declared?: PluginHandlerManifest): PluginHandlerInventory {
  const live = liveInventory(manifest);
  if (!declared || declared === manifest) return live;
  const all = liveInventory(declared);
  const minus = (values: readonly string[], present: readonly string[]) => values.filter((value) => !present.includes(value));
  const dormant: PluginDormantInventory = {
    events: minus(all.events, live.events),
    functions: minus(all.functions, live.functions),
    extensions: minus(all.extensions ?? [], live.extensions ?? []),
    routes: {
      admin: minus(all.routes.admin, live.routes.admin),
      public: minus(all.routes.public, live.routes.public),
      webhooks: minus(all.routes.webhooks, live.routes.webhooks),
    },
    cron: minus(all.cron, live.cron),
    providers: all.providers.filter((provider) => !live.providers.some((entry) => entry.id === provider.id)),
  };
  const empty = dormant.events.length + dormant.functions.length + (dormant.extensions?.length ?? 0) + dormant.routes.admin.length + dormant.routes.public.length
    + dormant.routes.webhooks.length + dormant.cron.length + dormant.providers.length === 0;
  return empty ? live : { ...live, dormant };
}

function liveInventory(manifest: PluginHandlerManifest): PluginHandlerInventory {
  return {
    events: [...manifest.events],
    functions: manifest.functions.map((fn) => fn.point),
    extensions: (manifest.storefront?.extensions ?? []).map((extension) => extension.target),
    routes: {
      admin: manifest.routes.admin.map((route) => route.name),
      public: manifest.routes.public.map((route) => route.name),
      webhooks: manifest.routes.webhooks.map((route) => route.name),
    },
    cron: manifest.cron.map((job) => job.name),
    providers: manifest.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      operations: [...PROVIDER_OPERATIONS[provider.kind].required, ...provider.operations],
    })),
    migrations: (manifest.migrations ?? []).map((migration) => String(migration.version)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The module's default export, or the module itself when it exports the definition's fields. */
export function pluginDefinitionOf(module: unknown): Record<string, unknown> | null {
  if (!isRecord(module)) return null;
  const candidate = isRecord(module.default) ? module.default : module;
  return isRecord(candidate) ? candidate : null;
}

/**
 * Every way a plugin definition disagrees with its manifest: a declared
 * handler that is missing or not a function, an undeclared handler, or an
 * unknown definition key. Empty means the module may run. Dormant handlers
 * (features that are off) count as declared.
 */
export function checkPluginHandlers(live: PluginHandlerInventory, definition: unknown): string[] {
  const dormant = live.dormant;
  const inventory: PluginHandlerInventory = dormant
    ? {
      events: [...live.events, ...dormant.events],
      functions: [...live.functions, ...dormant.functions],
      extensions: [...(live.extensions ?? []), ...(dormant.extensions ?? [])],
      routes: {
        admin: [...live.routes.admin, ...dormant.routes.admin],
        public: [...live.routes.public, ...dormant.routes.public],
        webhooks: [...live.routes.webhooks, ...dormant.routes.webhooks],
      },
      cron: [...live.cron, ...dormant.cron],
      providers: [...live.providers, ...dormant.providers],
      ...(live.migrations ? { migrations: live.migrations } : {}),
    }
    : live;
  const issues: string[] = [];
  const plugin = pluginDefinitionOf(definition);
  if (!plugin) return ["The plugin module must export a plugin definition (definePlugin) as its default export."];

  const known = new Set(["manifest", "events", "functions", "extensions", "routes", "cron", "providers", "lifecycle", "migrations"]);
  for (const key of Object.keys(plugin)) {
    if (!known.has(key)) issues.push(`Unknown plugin definition key "${key}".`);
  }

  const compare = (
    label: string,
    declared: readonly string[],
    value: unknown,
    kind: "function" | "object",
  ) => {
    if (value !== undefined && !isRecord(value)) {
      issues.push(`${label} must be an object of handlers.`);
      return;
    }
    const handlers = (value ?? {}) as Record<string, unknown>;
    const declaredSet = new Set(declared);
    for (const name of declared) {
      const handler = handlers[name];
      if (handler === undefined) issues.push(`${label} "${name}" is declared in the manifest but has no handler.`);
      else if (kind === "function" ? typeof handler !== "function" : !isRecord(handler)) {
        issues.push(`${label} "${name}" must be ${kind === "function" ? "a function" : "an object"}.`);
      }
    }
    for (const name of Object.keys(handlers)) {
      if (!declaredSet.has(name)) issues.push(`${label} "${name}" has a handler but is not declared in the manifest.`);
    }
  };

  compare("Event", inventory.events, plugin.events, "function");
  compare("Function", inventory.functions, plugin.functions, "function");
  compare("Extension", inventory.extensions ?? [], plugin.extensions, "function");
  compare("Cron job", inventory.cron, plugin.cron, "function");
  compare("Migration", inventory.migrations ?? [], plugin.migrations, "function");
  compare("Provider", inventory.providers.map((provider) => provider.id), plugin.providers, "object");
  if (isRecord(plugin.providers)) {
    for (const declared of inventory.providers) {
      const implementation = plugin.providers[declared.id];
      if (isRecord(implementation)) issues.push(...providerIssues(declared, implementation));
    }
  }

  const routes = plugin.routes;
  if (routes !== undefined && !isRecord(routes)) {
    issues.push("routes must be an object with admin, public and webhooks handlers.");
  } else {
    const byKind = (routes ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(byKind)) {
      if (key !== "admin" && key !== "public" && key !== "webhooks") issues.push(`Unknown route kind "${key}".`);
    }
    compare("Admin route", inventory.routes.admin, byKind.admin, "function");
    compare("Public route", inventory.routes.public, byKind.public, "function");
    compare("Webhook route", inventory.routes.webhooks, byKind.webhooks, "function");
  }

  const lifecycle = plugin.lifecycle;
  if (lifecycle !== undefined) {
    if (!isRecord(lifecycle)) {
      issues.push("lifecycle must be an object of hooks.");
    } else {
      for (const [name, hook] of Object.entries(lifecycle)) {
        if (!(PLUGIN_LIFECYCLE_HOOKS as readonly string[]).includes(name)) issues.push(`Unknown lifecycle hook "${name}".`);
        else if (typeof hook !== "function") issues.push(`Lifecycle hook "${name}" must be a function.`);
      }
    }
  }
  return issues;
}

/**
 * The handler key an event is delivered to: the exact topic, else its
 * resource wildcard (`order.*`), else `*`. Null when the plugin does not
 * subscribe to the topic.
 */
export function pluginEventHandlerKey(topic: string, declared: readonly string[]): string | null {
  if (declared.includes(topic)) return topic;
  const prefix = topic.split(".", 1)[0];
  if (prefix && declared.includes(`${prefix}.*`)) return `${prefix}.*`;
  return declared.includes("*") ? "*" : null;
}

/**
 * How a provider implementation disagrees with its declaration: the port it
 * was defined for (`definePaymentProvider` stamps `kind`), a declared
 * operation it lacks, an operation it has but does not declare, or one the
 * port does not have.
 */
function providerIssues(declared: PluginProviderInventory, implementation: Record<string, unknown>): string[] {
  const label = `Provider "${declared.id}"`;
  if (!(PROVIDER_KINDS as readonly unknown[]).includes(declared.kind)) return [`${label} names an unknown port.`];
  const issues: string[] = [];
  if (implementation.kind !== declared.kind) {
    issues.push(`${label} is declared as a ${declared.kind} provider but defined for another port.`);
  }
  const port = PROVIDER_OPERATIONS[declared.kind];
  const known = new Set<string>([...port.required, ...port.optional]);
  for (const operation of declared.operations) {
    if (typeof implementation[operation] !== "function") issues.push(`${label} must implement ${operation}.`);
  }
  for (const [key, value] of Object.entries(implementation)) {
    if (key === "kind") continue;
    if (!known.has(key)) issues.push(`${label} has "${key}", which the ${declared.kind} port does not define.`);
    else if (typeof value !== "function") issues.push(`${label}: ${key} must be a function.`);
    else if (!declared.operations.includes(key)) issues.push(`${label} implements ${key}; declare it in the provider's operations.`);
  }
  return issues;
}
