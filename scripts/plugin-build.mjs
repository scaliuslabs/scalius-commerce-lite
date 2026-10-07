// Build steps of the plugin platform (docs/platform/PLUGINS.md), shared by
// `pnpm plugin` (scripts/plugins.mjs) and the tests that prove generated
// files are fresh:
//
// - packPlugin: bundles one plugin into `dist/plugin.js` (the sandbox bundle;
//   its SHA-256 is the plugin version's fingerprint in both loaders),
//   validates its manifest and checks its handlers against it, and checks
//   and carries its listing images (icon, screenshots);
// - buildSandboxRuntime: compiles the wrapper module every sandboxed plugin
//   isolate runs (apps/api/src/plugins/runtime/sandbox-entry.ts);
// - render*: the generated TypeScript the API Worker compiles: the bundled
//   plugins, their listing images and the catalog of first-party plugins
//   this deployment does not bundle.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const root = resolve(import.meta.dirname, "..");
export const LOCKFILE = join(root, "scalius.plugins.json");
export const BUNDLED_GEN = join(root, "apps/api/src/plugins/bundled.gen.ts");
export const SANDBOX_RUNTIME_GEN = join(root, "apps/api/src/plugins/sandbox-runtime.gen.ts");
export const ASSETS_GEN = join(root, "apps/api/src/plugins/assets.gen.ts");
export const CATALOG_GEN = join(root, "apps/api/src/plugins/catalog.gen.ts");
/** First-party plugins: one package per directory. */
export const FIRST_PARTY_DIR = join(root, "plugins");
export const SANDBOX_ENTRY = join(root, "apps/api/src/plugins/runtime/sandbox-entry.ts");
const API_PLUGINS_DIR = join(root, "apps/api/src/plugins");

const requireFromRoot = createRequire(join(root, "package.json"));

/** esbuild, resolved from the repo root. */
export async function loadEsbuild() {
  return import(pathToFileURL(requireFromRoot.resolve("esbuild")).href);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ── Lockfile ─────────────────────────────────────────────────────────────

export function readLockfile(path = LOCKFILE) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.plugins)) throw new Error("Unsupported lockfile version.");
    return { version: 1, sandbox: parsed.sandbox === true, plugins: parsed.plugins };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, sandbox: false, plugins: [] };
    throw error;
  }
}

export function renderLockfile(lockfile) {
  const plugins = [...lockfile.plugins]
    .map(({ id, version, source, sha256: digest }) => ({ id, version, source, sha256: digest }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return `${JSON.stringify({
    $comment: "Plugins compiled into the API Worker (bundled loader). Maintained by `pnpm plugin`; deploy after changing it. `sandbox: true` deploys with the Dynamic Worker loader (Workers Paid).",
    version: 1,
    sandbox: lockfile.sandbox === true,
    plugins,
  }, null, 2)}\n`;
}

// ── Sources ──────────────────────────────────────────────────────────────

/** Whether a lockfile source is a path in this repository (else an installed package name). */
export function isPathSource(source) {
  return source.startsWith("./") || source.startsWith("../") || source.startsWith("plugins/") || source.startsWith("/");
}

/** The plugin's package directory: the path itself, or the installed package's root. */
export function pluginPackageDir(source) {
  if (isPathSource(source)) return resolve(root, source);
  return dirname(createRequire(join(root, "apps/api/package.json")).resolve(`${source}/package.json`));
}

/** `plugins/<dir>` of every first-party plugin package, sorted. */
export function firstPartyPluginSources() {
  return readdirSync(FIRST_PARTY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(FIRST_PARTY_DIR, entry.name, "package.json")))
    .map((entry) => `plugins/${entry.name}`)
    .sort();
}

/** The plugin's entry module: `exports["."]`, `main`, or `src/index.ts` of a path source; a resolved package otherwise. */
export function resolvePluginEntry(source) {
  if (!isPathSource(source)) {
    return createRequire(join(root, "apps/api/package.json")).resolve(source);
  }
  const directory = resolve(root, source);
  let entry = "src/index.ts";
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const exported = typeof manifest.exports === "string" ? manifest.exports : manifest.exports?.["."];
    entry = typeof exported === "string" ? exported : typeof manifest.main === "string" ? manifest.main : entry;
  } catch {
    // A directory without package.json uses the conventional entry.
  }
  return join(directory, entry);
}

// ── Packing ──────────────────────────────────────────────────────────────

let contractModule = null;

/** The plugin contract (manifest parser, handler check) compiled for Node. */
export async function loadPluginContract() {
  if (contractModule) return contractModule;
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    stdin: {
      contents: 'export * from "@scalius/shared/plugins";\nexport { checkPluginAsset } from "@scalius/shared/plugins/assets";',
      resolveDir: join(root, "packages/plugin-sdk"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  contractModule = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return contractModule;
}

/** Bundles a plugin entry into one self-contained ES module (no imports, no Worker APIs). */
export async function bundlePlugin(entry) {
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    entryPoints: [entry],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    target: "es2022",
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/**
 * The manifest's listing images (its icon, screenshots and each provider's
 * own icon), read from the plugin package and checked (type, size, safe SVG). Their digests end the packed bundle as a comment,
 * so the bundle's SHA-256 (the version's fingerprint in both loaders) also
 * changes when only an image does.
 */
function readListingAssets(contract, manifest, source) {
  const directory = pluginPackageDir(source);
  const declared = [
    ...(manifest.icon ? [{ path: manifest.icon, role: "icon" }] : []),
    ...manifest.screenshots.map((path) => ({ path, role: "screenshot" })),
    ...manifest.providers.flatMap((provider) => (provider.icon ? [{ path: provider.icon, role: "icon" }] : [])),
  ];
  const seen = new Set();
  return declared.filter(({ path }) => !seen.has(path) && seen.add(path)).map(({ path, role }) => {
    let bytes;
    try {
      bytes = readFileSync(join(directory, path));
    } catch {
      throw new Error(`${source}: ${path} is declared in the manifest but missing.`);
    }
    const problem = contract.checkPluginAsset(path, new Uint8Array(bytes), role);
    if (problem) throw new Error(`${source}: ${problem}`);
    return { path, role, contentType: contract.pluginAssetContentType(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  });
}

/** The packed bundle: the plugin's code, then its images' digests (only when it has images). */
export function sealBundle(code, assets) {
  if (assets.length === 0) return code;
  return `${code}//# scalius-assets ${JSON.stringify(Object.fromEntries(assets.map((asset) => [asset.path, asset.sha256])))}\n`;
}

/**
 * Packs one plugin: bundle, manifest validation, handler check, listing
 * images. Writes `dist/plugin.js`, `dist/manifest.json` and `dist/assets/*`
 * (what a sandbox install stores in R2) next to a path source.
 */
export async function packPlugin(source) {
  const entry = resolvePluginEntry(source);
  const bundled = await bundlePlugin(entry);
  const contract = await loadPluginContract();
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString("base64")}`);
  const definition = contract.pluginDefinitionOf(loaded);
  if (!definition) throw new Error(`${source}: the module has no default export from definePlugin().`);
  const parsed = contract.parsePluginManifest(definition.manifest);
  if (!parsed.ok) {
    throw new Error(`${source}: invalid manifest: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  const issues = contract.checkPluginHandlers(contract.pluginHandlerInventory(parsed.manifest), loaded);
  if (issues.length > 0) throw new Error(`${source}: ${issues.join(" ")}`);
  const assets = readListingAssets(contract, parsed.manifest, source);
  const code = sealBundle(bundled, assets);
  if (isPathSource(source)) {
    const dist = join(resolve(root, source), "dist");
    rmSync(join(dist, "assets"), { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "plugin.js"), code);
    writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(parsed.manifest, null, 2)}\n`);
    for (const asset of assets) {
      mkdirSync(dirname(join(dist, "assets", asset.path)), { recursive: true });
      writeFileSync(join(dist, "assets", asset.path), asset.bytes);
    }
  }
  return { id: parsed.manifest.id, version: parsed.manifest.version, sha256: sha256(code), manifest: parsed.manifest, code, entry, assets };
}

// ── Generated modules ────────────────────────────────────────────────────

/** The import specifier of a plugin entry, as seen from apps/api/src/plugins. */
export function bundledImportSpecifier(source, entry = resolvePluginEntry(source)) {
  if (!isPathSource(source)) return source;
  const path = relative(API_PLUGINS_DIR, entry).split("\\").join("/").replace(/\.(?:ts|mts|js|mjs)$/, "");
  return path.startsWith(".") ? path : `./${path}`;
}

export function renderBundledGen(lockfile, specifierOf = (plugin) => bundledImportSpecifier(plugin.source)) {
  const entries = [...lockfile.plugins]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((plugin) => `  ${JSON.stringify(plugin.id)}: {\n    version: ${JSON.stringify(plugin.version)},\n    sha256: ${JSON.stringify(plugin.sha256)},\n    load: () => import(${JSON.stringify(specifierOf(plugin))}),\n  },`);
  return [
    "// Generated by `pnpm plugin` from scalius.plugins.json. Do not edit by hand.",
    "// Each plugin is a lazy import: it costs nothing at Worker startup and loads",
    "// only when one of its handlers runs (loaders/bundled.ts).",
    "",
    'import type { BundledPluginEntry } from "./loaders/bundled";',
    "",
    "export const BUNDLED_PLUGINS: Readonly<Record<string, BundledPluginEntry>> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

/**
 * The listing images of the bundled and catalogued plugins, by plugin id and
 * manifest path, as base64. The API imports it lazily, only to serve one.
 */
export function renderAssetsGen(packedPlugins) {
  const entries = [...packedPlugins]
    .filter((packed) => packed.assets.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((packed) => [
      `  ${JSON.stringify(packed.id)}: {`,
      ...packed.assets.map((asset) => `    ${JSON.stringify(asset.path)}: { type: ${JSON.stringify(asset.contentType)}, sha256: ${JSON.stringify(asset.sha256)}, data: ${JSON.stringify(Buffer.from(asset.bytes).toString("base64"))} },`),
      "  },",
    ].join("\n"));
  return [
    "// Generated by `pnpm plugin` from the bundled and catalogued plugins' listing",
    "// images (checked by @scalius/shared/plugins/assets). Do not edit by hand.",
    "// Imported lazily by the asset route only.",
    "",
    'import type { PluginAssetFile } from "./listing";',
    "",
    "export const PLUGIN_ASSETS: Readonly<Record<string, Readonly<Record<string, PluginAssetFile>>>> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

/** The manifest fields the Apps page lists a plugin by (`apps/api/src/plugins/listing.ts`). */
export const LISTING_FIELDS = [
  "name", "version", "description", "author", "homepage", "icon", "tagline", "categories", "screenshots", "support",
  "privacyPolicyUrl", "documentationUrl", "changelogUrl", "countries", "minPlatformVersion",
];

/**
 * First-party plugins this deployment does not bundle: the Apps page lists
 * them as available, with the `pnpm plugin add` command that installs one.
 */
export function renderCatalogGen(packedPlugins) {
  const entries = [...packedPlugins]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((packed) => {
      const listing = Object.fromEntries(LISTING_FIELDS.filter((key) => packed.manifest[key] !== undefined).map((key) => [key, packed.manifest[key]]));
      const bn = packed.manifest.translations?.bn;
      if (bn) listing.translations = { bn: Object.fromEntries(["name", "tagline", "description"].filter((key) => bn[key] !== undefined).map((key) => [key, bn[key]])) };
      return `  ${JSON.stringify({ id: packed.id, source: packed.source, sha256: packed.sha256, listing })},`;
    });
  return [
    "// Generated by `pnpm plugin` from plugins/*: the first-party plugins this",
    "// deployment does not bundle (scalius.plugins.json). Do not edit by hand.",
    "",
    'import type { PluginCatalogEntry } from "./listing";',
    "",
    "export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}

/**
 * Packs every bundled plugin and every first-party plugin the lockfile does
 * not list: what the generated asset and catalog modules are made from.
 */
export async function packForGenerated(lockfile) {
  const bundled = [];
  for (const plugin of lockfile.plugins) bundled.push({ ...(await packPlugin(plugin.source)), source: plugin.source });
  const bundledSources = new Set(lockfile.plugins.map((plugin) => plugin.source));
  const bundledIds = new Set(bundled.map((packed) => packed.id));
  const catalog = [];
  for (const source of firstPartyPluginSources()) {
    if (bundledSources.has(source)) continue;
    const packed = { ...(await packPlugin(source)), source };
    if (!bundledIds.has(packed.id)) catalog.push(packed);
  }
  return { bundled, catalog };
}

/** The wrapper module of every sandboxed plugin isolate. */
export async function buildSandboxRuntime() {
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    entryPoints: [SANDBOX_ENTRY],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers", "./plugin.js"],
    minify: true,
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

export function renderSandboxRuntimeGen(code) {
  return [
    "// Generated by `pnpm plugin build` from runtime/sandbox-entry.ts and the",
    "// SDK runtime (@scalius/plugin-sdk/runtime). Do not edit by hand. The main module of every",
    "// sandboxed plugin's Dynamic Worker; it imports the plugin as ./plugin.js.",
    "",
    `export const SANDBOX_RUNTIME_SHA256 = ${JSON.stringify(sha256(code))};`,
    "",
    `export const SANDBOX_RUNTIME_MODULE = ${JSON.stringify(code)};`,
    "",
  ].join("\n");
}

export function writeIfChanged(path, text) {
  let current = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // Missing: write it.
  }
  if (current === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}
