#!/usr/bin/env node
// The app SDK's size budgets (`pnpm check:sdk-budgets`; plugin-sdk-size.test.mjs
// runs the same check in the suite). An app's server code runs in a size- and
// CPU-limited sandbox and its storefront parts reach the buyer's browser, and
// each carries whatever the SDK entries it imports reach: on rc.1's way one
// value import (the courier statuses, from the courier port's schema module)
// put all of zod in every app's bundle, five times its size, with no change
// on the app's side.
//
// The check builds the SDK's published entries the way `pnpm pack` does
// (`sdkBundleOptions`, which scripts/build-plugin-sdk.mjs builds with) into a
// temporary folder, and fails when:
//
// - a runtime entry (`SDK_ENTRY_TIERS`) reaches a module on RUNTIME_DENIED
//   (zod, the HTML parser, the theme document and its compiler, the manifest
//   parser, the testing harness) or one module over RUNTIME_MODULE_MAX_KIB;
//   the problem names the import chain from the entry;
// - an entry, or an app bundled against the packed SDK (the scaffold of
//   `pnpm plugin create`, its storefront and theme variants, and the SDK's
//   examples), grows past its budget in SDK_SIZE_BUDGETS_KIB.
//
// Budgets are ceilings with a little headroom over what was measured: make
// the output fit (a constant or a small helper goes in a zod-free leaf module;
// a schema stays on the host and in `./manifest` / `./testing`) rather than
// raising one. Sizes are the built JavaScript, unminified for the sandbox
// bundle (as `pnpm plugin pack` writes `plugin.js`), minified for the
// storefront module.
//
//   node scripts/plugin-sdk-size.mjs           print the sizes
//   node scripts/plugin-sdk-size.mjs --check   and exit 1 on a broken budget

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePlugin, bundleStorefrontModule } from "./plugin-build.mjs";
import { CHECKOUT, loadEsbuild } from "./plugin-host.mjs";
import { scaffoldFiles } from "./plugin-scaffold.mjs";

const SDK = join(CHECKOUT, "packages/plugin-sdk");

/** The esbuild options the SDK's published entries are built with (`entries`: absolute source paths). */
export function sdkBundleOptions(entries, outdir) {
  return {
    entryPoints: entries,
    outbase: join(SDK, "src"),
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    target: "es2022",
    legalComments: "eof",
    logLevel: "warning",
  };
}

/**
 * Each published entry's tier. `runtime`: an app's code runs with it (the
 * sandbox bundle, the storefront module, an island or pixel in the buyer's
 * browser, the sandbox wrapper). `tooling`: tests, fixtures and the manifest
 * parser, which run in Node and may carry schemas. A new export needs a tier.
 */
export const SDK_ENTRY_TIERS = {
  ".": "runtime",
  "./runtime": "runtime",
  "./storefront": "runtime",
  "./storefront/jsx-runtime": "runtime",
  "./storefront/jsx-dev-runtime": "runtime",
  "./island": "runtime",
  "./pixel": "runtime",
  "./fixtures": "tooling",
  "./manifest": "tooling",
  "./testing": "tooling",
  "./storefront/testing": "tooling",
};

/** What a runtime entry never reaches (module paths as esbuild names them from the checkout). */
export const RUNTIME_DENIED = [
  { pattern: /(^|\/)node_modules\/zod\//, what: "zod (schemas stay on the host and in ./manifest and ./testing)" },
  { pattern: /(^|\/)node_modules\/(htmlparser2|entities|domhandler|domutils|dom-serializer)\//, what: "the HTML parser" },
  { pattern: /(^|\/)node_modules\/(esbuild|typescript)\//, what: "a build tool" },
  { pattern: /packages\/shared\/src\/storefront-theme\//, what: "the theme document and its compiler" },
  { pattern: /packages\/shared\/src\/plugins\/manifest\.ts$/, what: "the manifest parser" },
  { pattern: /packages\/plugin-sdk\/src\/(testing|fixtures|pixel-testing|storefront\/testing)/, what: "the testing harness" },
];

/**
 * The largest single module a runtime entry may carry. The largest today is
 * the sealed error-code table (app-errors.ts, 22 KiB, which the root entry and
 * the sandbox wrapper both need); a schema library or a parser is larger.
 */
export const RUNTIME_MODULE_MAX_KIB = 32;

/**
 * Ceilings in KiB (1024 bytes), each about 2 KiB (5% for the large tooling
 * entries) over its measurement on 2026-11-27, after rc.1's fix; beta 8 in
 * brackets where it differs, and rc.1 before the fix where zod was in it.
 */
export const SDK_SIZE_BUDGETS_KIB = {
  // The published entry with every chunk it imports, unminified.
  entries: {
    ".": 86, // 82.2 (beta 8: 72.8; before the fix: 845.1)
    "./runtime": 55, // 52.3 (49.6)
    "./storefront": 45, // 42.9 (42.5)
    "./storefront/jsx-runtime": 7, // 5.9
    "./storefront/jsx-dev-runtime": 7, // 5.9
    "./island": 12.5, // 11.1 (10.6)
    "./pixel": 3.5, // 2.5
    // Tooling: they run in Node; the ceiling only stops a runaway.
    "./fixtures": 16.5, // 15.0 (14.4)
    "./manifest": 1445, // 1375.7 (1362.9)
    "./testing": 2120, // 2015.9 (1997.6)
    "./storefront/testing": 1030, // 980.8 (984.6)
  },
  // Apps bundled against the packed SDK: `plugin.js` (unminified) and `storefront.js` (minified).
  apps: {
    "scaffold plugin.js": 40, // 38.1 (beta 8: 34.0; before the fix: 742.7)
    "scaffold --storefront plugin.js": 40.5, // 38.5 (34.3)
    "scaffold --storefront storefront.js": 10, // 8.4
    "scaffold --theme plugin.js": 34.5, // 32.5 (28.7)
    "scaffold --theme storefront.js": 16, // 14.1
    "root helper storefront.js": 18.5, // 16.6 (15.0; before the fix: 418.5)
    "example cart-recovery plugin.js": 35, // 32.8 (28.9)
    "example chat plugin.js": 36, // 33.9 (30.1)
    "example delivery-slots plugin.js": 43.5, // 41.3 (37.1)
    "example marketplace plugin.js": 55, // 52.9 (49.0)
    "example pixel plugin.js": 32, // 30.1 (26.2)
    "example pos plugin.js": 36, // 33.8 (29.9)
    "example reviews plugin.js": 42, // 40.1 (36.0)
  },
};

const kib = (bytes) => Math.round((bytes / 1024) * 10) / 10;

/** The import chain from `from` to `to` in a metafile's inputs, or [to] when there is none. */
function importChain(inputs, from, to) {
  const previous = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === to) break;
    for (const edge of inputs[current]?.imports ?? []) {
      if (edge.kind !== "import-statement" || !edge.path || previous.has(edge.path)) continue;
      previous.set(edge.path, current);
      queue.push(edge.path);
    }
  }
  if (!previous.has(to)) return [to];
  const chain = [];
  for (let at = to; at !== null; at = previous.get(at)) chain.unshift(at);
  return chain;
}

/** Bundles an app against the packed SDK at `dist` (a resolver for `@scalius/plugin-sdk/*`). */
function packedSdk(dist, publishExports) {
  return {
    name: "packed-plugin-sdk",
    setup(build) {
      build.onResolve({ filter: /^@scalius\/plugin-sdk(\/.*)?$/ }, (args) => {
        const subpath = `.${args.path.slice("@scalius/plugin-sdk".length)}`;
        const target = publishExports[subpath]?.import;
        if (!target) return { errors: [{ text: `@scalius/plugin-sdk has no export "${subpath}".` }] };
        return { path: join(dist, relative("dist", target)) };
      });
    },
  };
}

/**
 * The apps the budgets measure: a directory with `src/index.ts` (unless `storefrontOnly`) and maybe `src/storefront.tsx`.
 * @returns {{ label: string, directory: string, storefrontOnly?: boolean }[]}
 */
function appsToMeasure(scratch) {
  const apps = [];
  for (const [label, options] of [["scaffold", {}], ["scaffold --storefront", { storefront: true }], ["scaffold --theme", { theme: true }]]) {
    const directory = join(scratch, "apps", label.replaceAll(/\W+/g, "-"));
    for (const [path, text] of Object.entries(scaffoldFiles("acme.size-probe", "size-probe", { standalone: true, sdkVersion: "0.0.0", ...options }))) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
    apps.push({ label, directory });
  }
  // A storefront module that imports one helper from the root entry, as a
  // theme's header does: before rc.1 that put the root's zod (packed) or its
  // error table (source) in the module the storefront Worker runs.
  const probe = join(scratch, "apps", "root-helper");
  mkdirSync(join(probe, "src"), { recursive: true });
  writeFileSync(join(probe, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(join(probe, "src/storefront.tsx"), [
    "import { trimTrailingCharacter } from \"@scalius/plugin-sdk\";",
    "import { defineStorefront } from \"@scalius/plugin-sdk/storefront\";",
    "export default defineStorefront({ sections: { title: ({ settings }: { settings: { title: string } }) => <h2>{trimTrailingCharacter(settings.title, \".\")}</h2> } });",
    "",
  ].join("\n"));
  apps.push({ label: "root helper", directory: probe, storefrontOnly: true });
  const examples = join(SDK, "examples");
  for (const name of readdirSync(examples).sort()) {
    if (existsSync(join(examples, name, "src/index.ts"))) apps.push({ label: `example ${name}`, directory: join(examples, name) });
  }
  return apps;
}

/**
 * Builds the SDK's entries and the apps against them, and measures both:
 * `{ entries: { [subpath]: { tier, bytes, modules: { [path]: bytes }, source } }, inputs, apps: { [name]: bytes } }`.
 */
export async function measureSdk() {
  const esbuild = await loadEsbuild();
  const metadata = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8"));
  const scratch = mkdtempSync(join(tmpdir(), "scalius-sdk-size-"));
  try {
    const dist = join(scratch, "dist");
    const subpaths = Object.keys(metadata.exports);
    const sources = subpaths.map((subpath) => resolve(SDK, metadata.exports[subpath]));
    const result = await esbuild.build({ ...sdkBundleOptions(sources, dist), absWorkingDir: CHECKOUT, metafile: true, logLevel: "silent" });
    const outputs = result.metafile.outputs;
    const closure = (path, seen = new Set()) => {
      if (seen.has(path)) return seen;
      seen.add(path);
      for (const edge of outputs[path].imports) if (edge.kind === "import-statement" && outputs[edge.path]) closure(edge.path, seen);
      return seen;
    };
    const entries = {};
    for (const [index, subpath] of subpaths.entries()) {
      const source = relative(CHECKOUT, sources[index]);
      const output = Object.keys(outputs).find((path) => outputs[path].entryPoint === source);
      if (!output) throw new Error(`esbuild wrote no output for ${subpath} (${source}).`);
      let bytes = 0;
      const modules = {};
      for (const file of closure(output)) {
        bytes += outputs[file].bytes;
        for (const [path, input] of Object.entries(outputs[file].inputs)) if (input.bytesInOutput > 0) modules[path] = (modules[path] ?? 0) + input.bytesInOutput;
      }
      entries[subpath] = { tier: SDK_ENTRY_TIERS[subpath], bytes, modules, source };
    }
    const sdk = packedSdk(dist, metadata.publishConfig.exports);
    const apps = {};
    for (const { label, directory, storefrontOnly } of appsToMeasure(scratch)) {
      if (!storefrontOnly) apps[`${label} plugin.js`] = Buffer.byteLength(await bundlePlugin(join(directory, "src/index.ts"), sdk));
      const storefront = join(directory, "src/storefront.tsx");
      if (existsSync(storefront)) apps[`${label} storefront.js`] = Buffer.byteLength(await bundleStorefrontModule(storefront, directory, sdk));
    }
    return { entries, inputs: result.metafile.inputs, apps };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What breaks the budgets (strings, empty when none). */
export function sdkSizeProblems(report, budgets = SDK_SIZE_BUDGETS_KIB) {
  const problems = [];
  for (const subpath of Object.keys(report.entries)) {
    if (!SDK_ENTRY_TIERS[subpath]) problems.push(`the SDK export "${subpath}" has no tier in SDK_ENTRY_TIERS (runtime or tooling)`);
  }
  for (const subpath of Object.keys(SDK_ENTRY_TIERS)) {
    if (!report.entries[subpath]) problems.push(`SDK_ENTRY_TIERS names "${subpath}", which the SDK no longer exports`);
  }
  for (const [subpath, entry] of Object.entries(report.entries)) {
    if (entry.tier === "runtime") {
      const chain = (path) => importChain(report.inputs ?? {}, entry.source, path).join(" -> ");
      for (const { pattern, what } of RUNTIME_DENIED) {
        const reached = Object.keys(entry.modules).filter((path) => pattern.test(path));
        if (reached.length === 0) continue;
        // The shortest way in names the import to cut.
        const length = (way) => (way.startsWith(entry.source) ? way.split(" -> ").length : Number.MAX_SAFE_INTEGER);
        const shortest = reached.map(chain).sort((a, b) => length(a) - length(b))[0];
        const bytes = reached.reduce((sum, path) => sum + entry.modules[path], 0);
        problems.push(`the runtime entry "${subpath}" reaches ${what}, ${reached.length} module(s) and ${kib(bytes)} KiB, by ${shortest}`);
      }
      for (const [path, bytes] of Object.entries(entry.modules)) {
        if (RUNTIME_DENIED.some(({ pattern }) => pattern.test(path))) continue;
        if (kib(bytes) > RUNTIME_MODULE_MAX_KIB) problems.push(`the runtime entry "${subpath}" carries ${path} at ${kib(bytes)} KiB, over the ${RUNTIME_MODULE_MAX_KIB} KiB a runtime module may be: ${chain(path)}`);
      }
    }
    const budget = budgets.entries[subpath];
    if (budget === undefined) problems.push(`the SDK export "${subpath}" has no budget in SDK_SIZE_BUDGETS_KIB.entries (it measures ${kib(entry.bytes)} KiB)`);
    else if (kib(entry.bytes) > budget) problems.push(`the SDK entry "${subpath}" is ${kib(entry.bytes)} KiB, over its ${budget} KiB budget`);
  }
  for (const [name, bytes] of Object.entries(report.apps)) {
    const budget = budgets.apps[name];
    if (budget === undefined) problems.push(`the app bundle "${name}" has no budget in SDK_SIZE_BUDGETS_KIB.apps (it measures ${kib(bytes)} KiB)`);
    else if (kib(bytes) > budget) problems.push(`the app bundle "${name}" is ${kib(bytes)} KiB against the packed SDK, over its ${budget} KiB budget`);
  }
  for (const name of Object.keys(budgets.apps)) if (report.apps[name] === undefined) problems.push(`the budgeted app bundle "${name}" was not measured`);
  for (const subpath of Object.keys(budgets.entries)) if (!report.entries[subpath]) problems.push(`the budgeted SDK entry "${subpath}" is not exported`);
  return problems;
}

/** The sizes as lines, each with its budget. */
export function formatSdkSizeReport(report, budgets = SDK_SIZE_BUDGETS_KIB) {
  const lines = ["SDK entries (with the chunks each imports; unminified):"];
  for (const [subpath, entry] of Object.entries(report.entries)) {
    lines.push(`  ${subpath.padEnd(28)} ${entry.tier.padEnd(8)} ${String(kib(entry.bytes)).padStart(8)} KiB (budget ${budgets.entries[subpath] ?? "none"})`);
  }
  lines.push("Apps against the packed SDK:");
  for (const [name, bytes] of Object.entries(report.apps)) {
    lines.push(`  ${name.padEnd(40)} ${String(kib(bytes)).padStart(8)} KiB (budget ${budgets.apps[name] ?? "none"})`);
  }
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const report = await measureSdk();
  console.log(formatSdkSizeReport(report));
  const problems = sdkSizeProblems(report);
  if (problems.length > 0) {
    console.error(`\n✗ The app SDK breaks ${problems.length} size rule${problems.length === 1 ? "" : "s"}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    if (check) process.exit(1);
  } else {
    console.log("\n✓ The app SDK within its size budgets (no runtime entry reaches zod, the HTML parser, the theme compiler or the testing harness)");
  }
}
