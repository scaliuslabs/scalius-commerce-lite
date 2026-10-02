// Build steps of the plugin platform (docs/platform/PLUGINS.md), shared by
// `pnpm plugin` (scripts/plugins.mjs) and the tests that prove generated
// files are fresh:
//
// - packPlugin: bundles one plugin into `dist/plugin.js` (the sandbox bundle;
//   its SHA-256 is the plugin version's fingerprint in both loaders),
//   validates its manifest and checks its handlers against it;
// - buildSandboxRuntime: compiles the wrapper module every sandboxed plugin
//   isolate runs (apps/api/src/plugins/runtime/sandbox-entry.ts);
// - render*: the generated TypeScript the API Worker compiles.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const root = resolve(import.meta.dirname, "..");
export const LOCKFILE = join(root, "scalius.plugins.json");
export const BUNDLED_GEN = join(root, "apps/api/src/plugins/bundled.gen.ts");
export const SANDBOX_RUNTIME_GEN = join(root, "apps/api/src/plugins/sandbox-runtime.gen.ts");
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
      contents: 'export * from "@scalius/shared/plugins";',
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
 * Packs one plugin: bundle, manifest validation, handler check. Writes
 * `dist/plugin.js` and `dist/manifest.json` next to a path source.
 */
export async function packPlugin(source) {
  const entry = resolvePluginEntry(source);
  const code = await bundlePlugin(entry);
  const digest = sha256(code);
  const contract = await loadPluginContract();
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const definition = contract.pluginDefinitionOf(loaded);
  if (!definition) throw new Error(`${source}: the module has no default export from definePlugin().`);
  const parsed = contract.parsePluginManifest(definition.manifest);
  if (!parsed.ok) {
    throw new Error(`${source}: invalid manifest: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  const issues = contract.checkPluginHandlers(contract.pluginHandlerInventory(parsed.manifest), loaded);
  if (issues.length > 0) throw new Error(`${source}: ${issues.join(" ")}`);
  if (isPathSource(source)) {
    const dist = join(resolve(root, source), "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "plugin.js"), code);
    writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(parsed.manifest, null, 2)}\n`);
  }
  return { id: parsed.manifest.id, version: parsed.manifest.version, sha256: digest, manifest: parsed.manifest, code, entry };
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
