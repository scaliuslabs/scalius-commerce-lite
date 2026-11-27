// The size of an app package a store accepts (`readPluginPackageZip`), and the
// one number `pnpm plugin pack`, `validate` and a registry check against, so a
// package that packs is a package a store takes. Import-free: the plugin CLI
// (scripts/plugin-registry.mjs) loads this file directly. Sealed limits that
// only rise (app-limits.ts).

/** A whole package (the ZIP, and everything it expands to). */
export const PLUGIN_PACKAGE_MAX_BYTES = 20 * 1024 * 1024;
/** One file in it, `plugin.js` included. */
export const PLUGIN_PACKAGE_FILE_MAX_BYTES = 16 * 1024 * 1024;
