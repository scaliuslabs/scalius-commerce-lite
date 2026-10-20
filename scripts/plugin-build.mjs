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
/** The storefront's generated registry of bundled apps' storefront parts, and their compiled files. */
export const STOREFRONT_BUNDLED_GEN = join(root, "apps/storefront/src/extensions/bundled.gen.ts");
export const STOREFRONT_BUNDLED_DIR = join(root, "apps/storefront/src/extensions/bundled");
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
    return { version: 1, sandbox: parsed.sandbox === true, plugins: parsed.plugins, trustedKeys: readTrustedKeys(parsed.trustedKeys) };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, sandbox: false, plugins: [], trustedKeys: [] };
    throw error;
  }
}

/** Developer keys the operator trusts for `pnpm plugin add --registry` (`{ id, name, publicKey }`); malformed entries are dropped. */
function readTrustedKeys(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((key) => key && typeof key.id === "string" && typeof key.name === "string" && typeof key.publicKey === "string")
    .map(({ id, name, publicKey }) => ({ id, name, publicKey }));
}

export function renderLockfile(lockfile) {
  const plugins = [...lockfile.plugins]
    .map(({ id, version, source, sha256: digest }) => ({ id, version, source, sha256: digest }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const trustedKeys = readTrustedKeys(lockfile.trustedKeys).sort((left, right) => left.id.localeCompare(right.id));
  return `${JSON.stringify({
    $comment: "Plugins compiled into the API Worker (bundled loader). Maintained by `pnpm plugin`; deploy after changing it. `sandbox: true` deploys with the Dynamic Worker loader (Workers Paid).",
    version: 1,
    sandbox: lockfile.sandbox === true,
    plugins,
    ...(trustedKeys.length > 0 ? { trustedKeys } : {}),
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
      contents: [
        'export * from "@scalius/shared/plugins";',
        'export { checkPluginAsset, checkStorefrontPublicFile } from "@scalius/shared/plugins/assets";',
        'export { storefrontDefinitionOf } from "./src/storefront/define";',
        'export { checkSkinHtml, checkStorefrontHeaderHtml, fixtureContext, fixtureProductCard, fixtureProductPage, fixtureSkinData } from "./src/storefront/testing";',
      ].join("\n"),
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

// ── Storefront components ────────────────────────────────────────────────

const STOREFRONT_SOURCE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

function firstExisting(directory, base) {
  for (const extension of STOREFRONT_SOURCE_EXTENSIONS) {
    const candidate = join(directory, `${base}.${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function listFiles(directory, prefix = "") {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(join(directory, entry.name), path);
    return entry.isFile() ? [path] : [];
  }).sort();
}

function storefrontFile(contract, path, bytes) {
  return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: contract.storefrontFileContentType(path) };
}

/**
 * Settings for a smoke render at pack time: each field's default (or, for a
 * required field, a fixture value), images and products from the SDK's fixtures.
 */
export function smokeSettings(contract, schema) {
  const stored = {};
  const item = (fields) => Object.fromEntries(fields.map((field) => [field.key, fixtureValue(field)]));
  function fixtureValue(field) {
    switch (field.type) {
      case "image": return "media_fixture";
      case "products": return "newest";
      case "product": return "prod_fixture";
      case "link": return "/";
      case "url": return "https://example.com/";
      case "color": return "#112233";
      case "number": return field.min ?? 1;
      case "boolean": return true;
      case "select": return field.options[0].value;
      case "multiselect": return [field.options[0].value];
      case "list": return [item(field.fields), item(field.fields)].slice(0, Math.max(field.min, 2));
      case "email": return "hello@example.com";
      default: return "Sample text";
    }
  }
  for (const field of schema) {
    if (field.type === "secret") continue;
    if (field.required || field.type === "list") stored[field.key] = fixtureValue(field);
  }
  return contract.resolveStorefrontSettings(schema, stored, {
    image: () => contract.fixtureProductCard().image,
    products: () => [contract.fixtureProductCard(), contract.fixtureProductCard({ id: "prod_2", quickAdd: false, compareAt: null })],
  });
}

/**
 * Compiles an app's storefront part (storefront-components.ts) and checks it
 * against the manifest and the budgets:
 *
 * - `src/storefront.(tsx|ts|jsx|js)` → `storefront/storefront.js`: one
 *   self-contained, minified module whose default export is
 *   `defineStorefront()`, with a component for every component section,
 *   component product block and skin (and no other), each rendering its
 *   defaults without throwing and every skin keeping its target's embed rule;
 * - `src/islands/<name>.(ts|tsx|js|jsx)` → `storefront/islands/<name>.js`, one
 *   per declared island, minified for browsers;
 * - `src/storefront.css` → `storefront/styles.css` when the manifest declares
 *   a stylesheet (`url(../public/…)` points at the app's public files);
 * - `public/**` → `storefront/public/**`: fonts and images, checked like
 *   listing images.
 */
export async function packStorefront(contract, manifest, source) {
  const directory = pluginPackageDir(source);
  const storefront = manifest.storefront;
  const limits = contract.STOREFRONT_COMPONENT_LIMITS;
  const esbuild = await loadEsbuild();
  const files = [];
  const fail = (message) => {
    throw new Error(`${source}: ${message}`);
  };
  const prebuilt = prebuiltStorefront(contract, directory, manifest, fail);
  if (prebuilt) return prebuilt;

  // The module.
  const moduleEntry = firstExisting(join(directory, "src"), "storefront");
  const needsModule = contract.pluginHasStorefrontModule(storefront);
  if (needsModule && !moduleEntry) fail("the manifest declares component sections, product blocks or skins: write them in src/storefront.tsx (defineStorefront).");
  if (!needsModule && moduleEntry) fail("src/storefront exists but the manifest declares no component section or product block (one without a route) or skin.");
  if (moduleEntry) {
    const result = await esbuild.build({
      entryPoints: [moduleEntry],
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "import"],
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: "@scalius/plugin-sdk/storefront",
      minify: true,
      legalComments: "none",
      charset: "utf8",
      logLevel: "silent",
    });
    const code = result.outputFiles[0].text;
    const bytes = Buffer.byteLength(code);
    if (bytes > limits.moduleBytes) fail(`storefront.js is ${bytes} bytes; the limit is ${limits.moduleBytes}. Keep server code and data out of it.`);
    const loaded = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const definition = contract.storefrontDefinitionOf(loaded.default);
    if (!definition) fail("src/storefront has no default export from defineStorefront().");
    const { sections } = storefront;
    const blocks = storefront.productBlocks;
    const expected = [
      ...sections.map((section) => ({ kind: "section", key: section.type, components: definition.sections ?? {} })),
      ...blocks.map((block) => ({ kind: "block", key: block.type, components: definition.blocks ?? {} })),
      ...storefront.skins.map((skin) => ({ kind: "skin", key: skin.id, components: definition.skins ?? {} })),
    ];
    for (const { kind, key, components } of expected) {
      if (typeof components[key] !== "function") fail(`the ${kind} ${key} has no component in defineStorefront({ ${kind}s }).`);
    }
    for (const key of Object.keys(definition.sections ?? {})) {
      if (!sections.some((section) => section.type === key)) fail(`defineStorefront has a section ${key} the manifest does not declare as a component section.`);
    }
    for (const key of Object.keys(definition.blocks ?? {})) {
      if (!blocks.some((block) => block.type === key)) fail(`defineStorefront has a block ${key} the manifest does not declare as a component product block.`);
    }
    for (const key of Object.keys(definition.skins ?? {})) {
      if (!storefront.skins.some((skin) => skin.id === key)) fail(`defineStorefront has a skin ${key} the manifest does not declare.`);
    }
    // Smoke render: every component draws its defaults over the fixture data.
    const jobs = [
      ...sections.map((section) => ({ id: `section:${section.type}`, kind: "section", type: section.type, instanceId: "smoke", settings: smokeSettings(contract, section.settings) })),
      ...blocks.map((block) => ({
        id: `block:${block.type}`, kind: "block", target: block.placement, type: block.type, instanceId: "smoke",
        settings: smokeSettings(contract, block.settings), data: contract.fixtureProductPage(),
      })),
      ...storefront.skins.map((skin) => ({
        id: `skin:${skin.id}`, kind: "skin", target: skin.target, component: skin.id, settings: smokeSettings(contract, skin.settings),
        data: contract.fixtureSkinData(skin.target),
        ...(skin.target.startsWith("section:") ? { instanceId: "smoke" } : {}),
      })),
    ];
    const reply = loaded.default.render({ abi: contract.STOREFRONT_COMPONENT_ABI, context: contract.fixtureContext(), jobs });
    for (const result of reply.results) {
      if ("error" in result) fail(`${result.id} fails to render its defaults: ${result.error}`);
      if (Buffer.byteLength(result.html) > limits.htmlBytes) fail(`${result.id} renders ${Buffer.byteLength(result.html)} bytes of HTML; the limit is ${limits.htmlBytes}.`);
      const job = jobs.find((each) => each.id === result.id);
      if (job?.kind !== "skin") continue;
      // The storefront would draw the core unit instead of a skin that breaks its target's embed rule.
      const issues = contract.checkSkinHtml(job.target, result.html);
      if (job.target === "header") issues.push(...contract.checkStorefrontHeaderHtml(result.html, { islands: storefront.islands.map((island) => island.name) }));
      if (issues.length > 0) fail(`${result.id} (${job.target}): ${issues.join(" ")}`);
    }
    files.push(storefrontFile(contract, contract.STOREFRONT_MODULE_FILE, Buffer.from(code)));
  }

  // Islands.
  const islandsDir = join(directory, "src", "islands");
  const islandSources = listFiles(islandsDir).filter((path) => !path.includes("/") && !/\.test\.[jt]sx?$/.test(path));
  const declaredIslands = new Set(storefront.islands.map((island) => island.name));
  for (const path of islandSources) {
    const name = path.replace(/\.[^.]+$/, "");
    if (!declaredIslands.has(name)) fail(`src/islands/${path} is not declared in storefront.islands.`);
  }
  let islandBytes = 0;
  for (const island of storefront.islands) {
    const entry = firstExisting(islandsDir, island.name);
    if (!entry) fail(`the island ${island.name} has no src/islands/${island.name}.ts.`);
    const result = await esbuild.build({
      entryPoints: [entry],
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: ["es2022", "chrome111", "safari16.4", "firefox115"],
      minify: true,
      metafile: true,
      legalComments: "none",
      charset: "utf8",
      logLevel: "silent",
    });
    const code = result.outputFiles[0].text;
    const output = Object.values(result.metafile.outputs)[0];
    if (!output?.exports?.includes("default")) fail(`src/islands/${island.name} has no default export (export default defineIsland(…)).`);
    const bytes = Buffer.byteLength(code);
    if (bytes > limits.islandBytes) fail(`the island ${island.name} is ${bytes} bytes; one island is at most ${limits.islandBytes}.`);
    islandBytes += bytes;
    files.push(storefrontFile(contract, contract.storefrontIslandFile(island.name), Buffer.from(code)));
  }
  if (islandBytes > limits.islandsBytes) fail(`the islands are ${islandBytes} bytes together; the limit is ${limits.islandsBytes}.`);

  // The stylesheet.
  const cssEntry = join(directory, "src", "storefront.css");
  if (storefront.stylesheet && !existsSync(cssEntry)) fail("the manifest declares a stylesheet: write src/storefront.css.");
  if (!storefront.stylesheet && existsSync(cssEntry)) fail("src/storefront.css exists: declare storefront.stylesheet: true.");
  if (storefront.stylesheet) {
    const result = await esbuild.build({
      entryPoints: [cssEntry],
      absWorkingDir: root,
      bundle: true,
      write: false,
      minify: true,
      // Public files stay references; they are served beside the stylesheet.
      external: ["../public/*"],
      target: ["chrome111", "safari16.4", "firefox115"],
      logLevel: "silent",
    });
    const css = result.outputFiles[0].text.replace(/url\(\s*(["']?)\.\.\/public\//g, "url($1public/");
    const bytes = Buffer.byteLength(css);
    if (bytes > limits.stylesheetBytes) fail(`styles.css is ${bytes} bytes; the limit is ${limits.stylesheetBytes}.`);
    files.push(storefrontFile(contract, contract.STOREFRONT_STYLESHEET_FILE, Buffer.from(css)));
  }

  // Public files.
  const publicFiles = listFiles(join(directory, "public"));
  if (publicFiles.length > limits.publicFiles) fail(`public/ holds ${publicFiles.length} files; the limit is ${limits.publicFiles}.`);
  let publicBytes = 0;
  for (const path of publicFiles) {
    const bytes = new Uint8Array(readFileSync(join(directory, "public", path)));
    const problem = contract.checkStorefrontPublicFile(path, bytes);
    if (problem) fail(problem);
    publicBytes += bytes.byteLength;
    files.push(storefrontFile(contract, contract.storefrontPublicFile(path), bytes));
  }
  if (publicBytes > limits.publicBytes) fail(`public/ is ${publicBytes} bytes; the limit is ${limits.publicBytes}.`);
  if (files.length > 0 && !needsModule && storefront.islands.length === 0 && !storefront.stylesheet) {
    fail("public/ files are served only with storefront components: declare a component section or product block, a skin, an island or a stylesheet.");
  }
  return files;
}

/**
 * A package installed from a registry holds the developer's compiled
 * storefront files (`storefront/`, checked against the release's sealed
 * digests when it was installed) instead of sources: they are used as they
 * are, within the same budgets.
 */
function prebuiltStorefront(contract, directory, manifest, fail) {
  const prebuiltDir = join(directory, "storefront");
  const hasSources = firstExisting(join(directory, "src"), "storefront") || existsSync(join(directory, "src", "storefront.css")) || existsSync(join(directory, "src", "islands"));
  if (!existsSync(prebuiltDir) || hasSources) return null;
  const files = listFiles(prebuiltDir).map((path) => {
    if (!contract.STOREFRONT_FILE_PATH.test(path)) fail(`storefront/${path} is not a storefront file.`);
    return storefrontFile(contract, path, new Uint8Array(readFileSync(join(prebuiltDir, path))));
  });
  const has = (path) => files.some((file) => file.path === path);
  if (contract.pluginHasStorefrontModule(manifest.storefront) !== has(contract.STOREFRONT_MODULE_FILE)) fail("storefront/storefront.js does not match the manifest's component sections, product blocks and skins.");
  if (manifest.storefront.stylesheet !== has(contract.STOREFRONT_STYLESHEET_FILE)) fail("storefront/styles.css does not match the manifest's stylesheet.");
  for (const island of manifest.storefront.islands) if (!has(contract.storefrontIslandFile(island.name))) fail(`storefront/islands/${island.name}.js is missing.`);
  for (const file of files) {
    if (file.path.startsWith("public/")) {
      const problem = contract.checkStorefrontPublicFile(file.path.slice("public/".length), file.bytes);
      if (problem) fail(problem);
    }
  }
  return files;
}

/** The packed bundle with its storefront files' digests (only when it has some). */
export function sealStorefront(code, files) {
  if (files.length === 0) return code;
  return `${code}//# scalius-storefront ${JSON.stringify(Object.fromEntries(files.map((file) => [file.path, file.sha256])))}\n`;
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
  const storefront = await packStorefront(contract, parsed.manifest, source);
  const code = sealStorefront(sealBundle(bundled, assets), storefront);
  if (isPathSource(source)) {
    const dist = join(resolve(root, source), "dist");
    rmSync(join(dist, "assets"), { recursive: true, force: true });
    rmSync(join(dist, "storefront"), { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "plugin.js"), code);
    writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(parsed.manifest, null, 2)}\n`);
    for (const asset of assets) {
      mkdirSync(dirname(join(dist, "assets", asset.path)), { recursive: true });
      writeFileSync(join(dist, "assets", asset.path), asset.bytes);
    }
    for (const file of storefront) {
      mkdirSync(dirname(join(dist, "storefront", file.path)), { recursive: true });
      writeFileSync(join(dist, "storefront", file.path), file.bytes);
    }
  }
  return { id: parsed.manifest.id, version: parsed.manifest.version, sha256: sha256(code), manifest: parsed.manifest, code, entry, assets, storefront };
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
      const translated = Object.entries(packed.manifest.translations ?? {}).map(([locale, text]) => [
        locale,
        Object.fromEntries(["name", "tagline", "description"].filter((key) => text[key] !== undefined).map((key) => [key, text[key]])),
      ]);
      if (translated.length > 0) listing.translations = Object.fromEntries(translated);
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

/** The folder of one bundled app's compiled storefront part (`<vendor>-<name>`). */
function storefrontBundledFolder(id) {
  return id.replace(/\./g, "-");
}

/**
 * The storefront's generated files for the bundled apps with storefront
 * parts: the registry (`bundled.gen.ts`), and per app its compiled module
 * (`storefront.gen.js` with its declaration) and its other files
 * (`files.gen.ts`, text and base64). The release each is compiled from is
 * the lockfile's SHA-256, the bundled installation's `bundleSha256`.
 * Returns the paths written; folders of apps no longer bundled are removed.
 */
export function writeStorefrontGenerated(lockfile, packedBundled) {
  const written = [];
  const byId = new Map(packedBundled.map((packed) => [packed.id, packed]));
  const entries = [];
  const keep = new Set();
  for (const plugin of [...lockfile.plugins].sort((left, right) => left.id.localeCompare(right.id))) {
    const packed = byId.get(plugin.id);
    if (!packed || packed.storefront.length === 0) continue;
    const folder = storefrontBundledFolder(plugin.id);
    keep.add(folder);
    const dir = join(STOREFRONT_BUNDLED_DIR, folder);
    const module = packed.storefront.find((file) => file.path === "storefront.js");
    const files = packed.storefront.filter((file) => file.path !== "storefront.js");
    const header = `// Generated by \`pnpm plugin\` from ${plugin.source} (${plugin.id}@${plugin.version}). Do not edit by hand.\n`;
    if (module) {
      // Compiled and minified by the packer: not for the type checker or the linters.
      const compiled = `${header}// @ts-nocheck\n/* eslint-disable */\n/* oxlint-disable */\n${Buffer.from(module.bytes).toString("utf8")}`;
      if (writeIfChanged(join(dir, "storefront.gen.js"), compiled)) written.push(join(dir, "storefront.gen.js"));
      const declaration = `${header}import type { StorefrontModule } from "@scalius/shared/plugins/storefront-protocol";\ndeclare const storefront: StorefrontModule;\nexport default storefront;\n`;
      if (writeIfChanged(join(dir, "storefront.gen.d.ts"), declaration)) written.push(join(dir, "storefront.gen.d.ts"));
    }
    const fileEntries = files.map((file) => {
      const text = /^(?:islands\/.*\.js|styles\.css)$/.test(file.path);
      const body = text ? `text: ${JSON.stringify(Buffer.from(file.bytes).toString("utf8"))}` : `base64: ${JSON.stringify(Buffer.from(file.bytes).toString("base64"))}`;
      return `  ${JSON.stringify(file.path)}: { type: ${JSON.stringify(file.contentType)}, ${body} },`;
    });
    const filesModule = [header.trimEnd(), "", "export const FILES: Readonly<Record<string, { type: string; text?: string; base64?: string }>> = {", ...fileEntries, "};", ""].join("\n");
    if (writeIfChanged(join(dir, "files.gen.ts"), filesModule)) written.push(join(dir, "files.gen.ts"));
    entries.push([
      `  ${JSON.stringify(plugin.id)}: {`,
      `    release: ${JSON.stringify(plugin.sha256)},`,
      module
        ? `    module: () => import(${JSON.stringify(`./bundled/${folder}/storefront.gen.js`)}),`
        : "    module: async () => { throw new Error(\"This app has no storefront module.\"); },",
      `    files: () => import(${JSON.stringify(`./bundled/${folder}/files.gen`)}),`,
      "  },",
    ].join("\n"));
  }
  if (existsSync(STOREFRONT_BUNDLED_DIR)) {
    for (const entry of readdirSync(STOREFRONT_BUNDLED_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && !keep.has(entry.name)) {
        rmSync(join(STOREFRONT_BUNDLED_DIR, entry.name), { recursive: true, force: true });
        written.push(join(STOREFRONT_BUNDLED_DIR, entry.name));
      }
    }
  }
  const registry = [
    "// Generated by `pnpm plugin` from scalius.plugins.json: the storefront parts",
    "// of bundled apps (their compiled storefront module and files). Do not edit",
    "// by hand. Each is a lazy import: it costs nothing at Worker startup and",
    "// loads only when a page draws one of its components or serves one of its files.",
    "",
    'import type { BundledStorefrontExtension } from "../lib/extensions/loaders";',
    "",
    entries.length > 0
      ? `export const BUNDLED_STOREFRONT_EXTENSIONS: Readonly<Record<string, BundledStorefrontExtension>> = {\n${entries.join("\n")}\n};`
      : "export const BUNDLED_STOREFRONT_EXTENSIONS: Readonly<Record<string, BundledStorefrontExtension>> = {};",
    "",
  ].join("\n");
  if (writeIfChanged(STOREFRONT_BUNDLED_GEN, registry)) written.push(STOREFRONT_BUNDLED_GEN);
  return written;
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
