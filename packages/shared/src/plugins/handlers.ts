// Plugin handler inventory (docs/platform/PLUGINS.md): the handlers a plugin
// module must export, derived from its manifest, and the check that a module
// exports exactly those. It runs when a plugin is packed (`pnpm plugin
// build`), when the host loads a bundled plugin and inside a sandboxed
// plugin's wrapper, so an undeclared handler can never run and a declared one
// can never be missing. Pure and free of zod: the sandbox wrapper bundles it.
// Part of the versioned plugin API.

/** What a manifest declares, by handler kind (names as the manifest spells them). */
export interface PluginHandlerInventory {
  /** Topic filters (`order.paid`, `order.*`, `*`); each needs a handler under the same key. */
  events: string[];
  functions: string[];
  routes: { admin: string[]; public: string[]; webhooks: string[] };
  cron: string[];
  providers: string[];
}

/** Lifecycle hooks are optional and need no declaration. */
export const PLUGIN_LIFECYCLE_HOOKS = ["install", "activate", "deactivate", "uninstall"] as const;
export type PluginLifecycleHook = (typeof PLUGIN_LIFECYCLE_HOOKS)[number];

/** The manifest fields the inventory reads (a parsed `PluginManifest` satisfies it). */
export interface PluginHandlerManifest {
  events: readonly string[];
  functions: ReadonlyArray<{ point: string }>;
  routes: {
    admin: ReadonlyArray<{ name: string }>;
    public: ReadonlyArray<{ name: string }>;
    webhooks: readonly string[];
  };
  cron: ReadonlyArray<{ name: string }>;
  providers: ReadonlyArray<{ id: string }>;
}

export function pluginHandlerInventory(manifest: PluginHandlerManifest): PluginHandlerInventory {
  return {
    events: [...manifest.events],
    functions: manifest.functions.map((fn) => fn.point),
    routes: {
      admin: manifest.routes.admin.map((route) => route.name),
      public: manifest.routes.public.map((route) => route.name),
      webhooks: [...manifest.routes.webhooks],
    },
    cron: manifest.cron.map((job) => job.name),
    providers: manifest.providers.map((provider) => provider.id),
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
 * unknown definition key. Empty means the module may run.
 */
export function checkPluginHandlers(inventory: PluginHandlerInventory, definition: unknown): string[] {
  const issues: string[] = [];
  const plugin = pluginDefinitionOf(definition);
  if (!plugin) return ["The plugin module must export a plugin definition (definePlugin) as its default export."];

  const known = new Set(["manifest", "events", "functions", "routes", "cron", "providers", "lifecycle"]);
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
  compare("Cron job", inventory.cron, plugin.cron, "function");
  compare("Provider", inventory.providers, plugin.providers, "object");

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
