// The plugin contract (docs/platform/PLUGINS.md): manifest, settings schema
// and function points. The pieces live in ./plugins/*; this barrel keeps
// `@scalius/shared/plugins` the one import path. Versioned by
// `PLUGIN_API_VERSION`; changes within a version are additive only.
export * from "./plugins/settings-schema";
export * from "./plugins/manifest";
export * from "./plugins/settings-layout";
export * from "./plugins/functions";
export * from "./plugins/function-reads";
export * from "./plugins/handlers";
export * from "./plugins/cron";
export * from "./plugins/ui";
export * from "./plugins/storefront";
export * from "./plugins/storefront-components";
export * from "./plugins/storefront-embeds";
// The HTML sanitizer (htmlparser2) is imported from `@scalius/shared/plugins/html` only where it runs.

export * from "./plugins/buyer-ui";

export * from "./plugins/objects";

export * from "./plugins/messaging";

export * from "./plugins/jobs";
export * from "./plugins/customer-roles";
