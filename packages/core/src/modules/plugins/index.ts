// Plugin platform persistence (docs/platform/PLUGINS.md, P1): installations
// and their grants and settings, extension-point registrations, declared
// storage collections, the plugin key/value store and the plugin log ring.
// The host runtime (loaders, bridge, principal) lives in apps/api/src/plugins.

export * from "./errors";
export * from "./grants";
export * from "./index-encoding";
export * from "./installations";
export * from "./kv";
export * from "./logs";
export * from "./registry";
export * from "./settings-crypto";
export * from "./storage";
