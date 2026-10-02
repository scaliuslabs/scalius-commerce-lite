// The plugin API version (docs/platform/PLUGINS.md). Date-versioned and equal
// to the event catalog's `EVENTS_API_VERSION` (manifest.test.ts proves it).
// Kept import-free: plugins import it at runtime, and a plugin bundle must not
// carry the manifest's schema code.

export const PLUGIN_API_VERSION = "2026-10" as const;
export const SUPPORTED_PLUGIN_API_VERSIONS = [PLUGIN_API_VERSION] as const;
export type PluginApiVersion = (typeof SUPPORTED_PLUGIN_API_VERSIONS)[number];
