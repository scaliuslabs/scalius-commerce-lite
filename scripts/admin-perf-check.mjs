#!/usr/bin/env node
// Dashboard performance gate.
//
// Default: builds the dashboard into a temporary directory, maps every route
// to the JavaScript its first render needs (the entry chunk, plus the lazy
// component chunks of the route and its layouts, plus everything those import
// statically) and checks each against a Brotli budget. It fails when a heavy
// library (rich-text editor, QR scanner, PDF; phone metadata or drag and drop
// on the everyday screens) becomes part of a route's first download, or when
// anything grows past its budget.
//
// --runtime: times first load and route transitions against a running local
// stack in headless Chrome (see scripts/admin-perf-runtime.mjs).
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(scriptDirectory, "..");
const ADMIN_DIR = "apps/admin-v2";

/**
 * Brotli KiB budgets. `entry` is what index.html loads before any route; each
 * route is its full first-render JavaScript (entry included). Budgets sit a
 * little above today's sizes: raise one only with a reason in the commit.
 */
export const BUNDLE_BUDGETS = {
  entry: 138,
  css: 17,
  // Editors (rich text preview, forms, validation) sit near 290-350.
  routeDefault: 360,
  routes: {
    // Rolldown groups lucide icons across entries: the navigation's rail and
    // settings-takeover icons moved a few into the login's icon chunk.
    "auth/login.tsx": 169,
    "admin/index.tsx": 206,
    "admin/orders/_list/index.tsx": 290,
    // Wave B: gift-card tenders, digital and gift-card line cards, refund to a gift card.
    "admin/orders/$orderId/index.tsx": 287,
    "admin/products/index.tsx": 290,
    "admin/products/$productId/edit.tsx": 364,
    // The editor plus the navigation shell (rail, panel, settings takeover).
    "admin/products/new.tsx": 362,
    "admin/inventory/index.tsx": 255,
    "admin/customers/index.tsx": 245,
    "admin/settings/store.tsx": 291,
  },
};

/** The screens merchants live in: they must never pay for another screen's tools. */
const HOT_ROUTES = [
  "admin/index.tsx",
  "admin/orders/_list/index.tsx",
  "admin/orders/$orderId/index.tsx",
  "admin/products/index.tsx",
  "admin/products/$productId/edit.tsx",
  "admin/inventory/index.tsx",
  "admin/customers/index.tsx",
];

/**
 * Libraries that load on demand, never as part of a route's first render
 * (module path patterns). `allow`: routes whose own job needs it first
 * (the scanner's QR engine). `only`: forbidden on these routes alone (phone
 * metadata belongs to phone forms; drag and drop to reordering screens).
 */
export const LAZY_ONLY_MODULES = [
  { name: "Tiptap / ProseMirror", pattern: /node_modules\/(?:@tiptap|prosemirror-)/ },
  { name: "html5-qrcode", pattern: /node_modules\/html5-qrcode\//, allow: ["scanner.tsx"] },
  { name: "html2pdf", pattern: /node_modules\/html2pdf/ },
  { name: "@dnd-kit", pattern: /node_modules\/@dnd-kit\//, only: HOT_ROUTES },
  { name: "libphonenumber-js metadata", pattern: /node_modules\/libphonenumber-js\/.*metadata/, only: HOT_ROUTES },
];

// ── Route tree ─────────────────────────────────────────────────────────────

/** Route file (relative to src/routes, with .tsx) → its parent's route file, or null at the root. */
export function parseRouteTree(source) {
  const fileByImport = new Map();
  for (const match of source.matchAll(/import \{ Route as (\w+)Import \} from '\.\/routes\/([^']+)'/g)) {
    fileByImport.set(match[1], `${match[2]}.tsx`);
  }
  const parentByFile = new Map();
  for (const file of fileByImport.values()) parentByFile.set(file, null);
  for (const match of source.matchAll(/const (\w+) =\s*(\w+)Import\.update\(\{[\s\S]*?getParentRoute: \(\) => (\w+),/g)) {
    const file = fileByImport.get(match[2]);
    const parentFile = fileByImport.get(match[3]);
    if (file) parentByFile.set(file, parentFile && parentFile !== "__root.tsx" ? parentFile : null);
  }
  return parentByFile;
}

export function routeAncestry(routeFile, parentByFile) {
  const chain = [];
  for (let file = routeFile; file; file = parentByFile.get(file) ?? null) chain.unshift(file);
  return chain;
}

// ── Bundle graph ───────────────────────────────────────────────────────────

/**
 * `chunks`: [{ fileName, isEntry, imports, moduleIds }]. Returns the chunk
 * file names that carry each route file's lazy page component.
 */
export function componentChunksByRoute(chunks, routesDir) {
  const byRoute = new Map();
  const prefix = `${routesDir.split("\\").join("/")}/`;
  for (const chunk of chunks) {
    for (const id of chunk.moduleIds) {
      const normalized = id.split("\\").join("/");
      if (!normalized.startsWith(prefix) || !normalized.endsWith("?tsr-split=component")) continue;
      const routeFile = normalized.slice(prefix.length, -"?tsr-split=component".length);
      const list = byRoute.get(routeFile) ?? [];
      list.push(chunk.fileName);
      byRoute.set(routeFile, list);
    }
  }
  return byRoute;
}

/** The chunks plus everything they import statically. */
export function staticClosure(fileNames, chunkByName) {
  const seen = new Set();
  const pending = [...fileNames];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const imported of chunkByName.get(name)?.imports ?? []) pending.push(imported);
  }
  return seen;
}

/** Per-route first-render JavaScript: file names, Brotli bytes and the lazy-only modules it pulls in. */
export function measureRoutes({ chunks, parentByFile, routesDir, brotliBytes }) {
  const chunkByName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = staticClosure(chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName), chunkByName);
  const componentChunks = componentChunksByRoute(chunks, routesDir);
  const sizeOf = (files) => [...files].reduce((sum, file) => sum + brotliBytes(file), 0);
  const lazyOnlyIn = (files, routeFile) => {
    const found = new Set();
    for (const file of files) {
      for (const id of chunkByName.get(file)?.moduleIds ?? []) {
        const normalized = id.split("\\").join("/");
        for (const rule of LAZY_ONLY_MODULES) {
          const applies = rule.only ? rule.only.includes(routeFile) || routeFile === "" : !rule.allow?.includes(routeFile);
          if (applies && rule.pattern.test(normalized)) found.add(rule.name);
        }
      }
    }
    return [...found];
  };

  const routes = [];
  for (const routeFile of [...parentByFile.keys()].sort()) {
    const own = routeAncestry(routeFile, parentByFile).flatMap((file) => componentChunks.get(file) ?? []);
    const files = new Set([...entry, ...staticClosure(own, chunkByName)]);
    routes.push({
      route: routeFile,
      fileNames: [...files].sort((a, b) => brotliBytes(b) - brotliBytes(a)),
      files: files.size,
      brotliBytes: sizeOf(files),
      lazyOnly: lazyOnlyIn(files, routeFile),
    });
  }
  return {
    entry: { files: entry.size, brotliBytes: sizeOf(entry), lazyOnly: lazyOnlyIn(entry, "") },
    routes,
  };
}

export function validateBundleReport(report, budgets = BUNDLE_BUDGETS) {
  const failures = [];
  const kib = (bytes) => bytes / 1024;
  if (kib(report.entry.brotliBytes) > budgets.entry) {
    failures.push(`entry chunk is ${kib(report.entry.brotliBytes).toFixed(1)} KiB Brotli (budget ${budgets.entry} KiB)`);
  }
  if (report.entry.lazyOnly.length > 0) failures.push(`entry chunk loads ${report.entry.lazyOnly.join(", ")}`);
  if (report.css && kib(report.css.brotliBytes) > budgets.css) {
    failures.push(`stylesheet is ${kib(report.css.brotliBytes).toFixed(1)} KiB Brotli (budget ${budgets.css} KiB)`);
  }
  for (const route of report.routes) {
    const budget = budgets.routes[route.route] ?? budgets.routeDefault;
    if (kib(route.brotliBytes) > budget) {
      failures.push(`${route.route} needs ${kib(route.brotliBytes).toFixed(1)} KiB Brotli to render (budget ${budget} KiB)`);
    }
    if (route.lazyOnly.length > 0) failures.push(`${route.route} loads ${route.lazyOnly.join(", ")} before it renders`);
  }
  for (const route of Object.keys(budgets.routes)) {
    if (!report.routes.some((entry) => entry.route === route)) failures.push(`budgeted route ${route} no longer exists`);
  }
  return failures;
}

// ── Build ──────────────────────────────────────────────────────────────────

/** Builds the dashboard into `outDir` and returns its chunk graph (the build's own config, plus a reporter). */
export async function buildAdminBundle(rootDir, outDir) {
  const adminDir = join(rootDir, ADMIN_DIR);
  const requireFromAdmin = createRequire(join(adminDir, "package.json"));
  const { build } = await import(pathToFileURL(requireFromAdmin.resolve("vite")).href);
  let chunks = [];
  let cssFiles = [];
  await build({
    root: adminDir,
    configFile: join(adminDir, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
    plugins: [{
      name: "scalius-admin-perf-report",
      generateBundle(_options, bundle) {
        chunks = Object.values(bundle)
          .filter((item) => item.type === "chunk")
          .map((chunk) => ({
            fileName: chunk.fileName,
            isEntry: chunk.isEntry,
            imports: chunk.imports,
            moduleIds: chunk.moduleIds ?? Object.keys(chunk.modules),
          }));
        cssFiles = Object.values(bundle)
          .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
          .map((item) => item.fileName);
      },
    }],
  });
  return { chunks, cssFiles, routesDir: join(adminDir, "src/routes") };
}

function brotliSize(file) {
  return brotliCompressSync(readFileSync(file), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
}

export async function runBundleCheck({ rootDir = defaultRootDir } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "scalius-admin-perf-build-"));
  try {
    const { chunks, cssFiles, routesDir } = await buildAdminBundle(rootDir, outDir);
    const parentByFile = parseRouteTree(readFileSync(join(rootDir, ADMIN_DIR, "src/routeTree.gen.ts"), "utf8"));
    const cache = new Map();
    const brotliBytes = (fileName) => {
      if (!cache.has(fileName)) cache.set(fileName, brotliSize(join(outDir, fileName)));
      return cache.get(fileName);
    };
    const report = measureRoutes({ chunks, parentByFile, routesDir, brotliBytes });
    report.css = {
      files: cssFiles.length,
      brotliBytes: cssFiles.reduce((sum, file) => sum + brotliBytes(file), 0),
      rawBytes: cssFiles.reduce((sum, file) => sum + statSync(join(outDir, file)).size, 0),
    };
    report.largestChunks = chunks
      .map((chunk) => ({ file: chunk.fileName, brotliBytes: brotliBytes(chunk.fileName) }))
      .sort((a, b) => b.brotliBytes - a.brotliBytes)
      .slice(0, 8);
    report.brotliByFile = Object.fromEntries(cache);
    return report;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

export function formatBundleReport(report, budgets = BUNDLE_BUDGETS) {
  const kib = (bytes) => (bytes / 1024).toFixed(1);
  const lines = [
    `entry: ${kib(report.entry.brotliBytes)} KiB Brotli in ${report.entry.files} file(s) (budget ${budgets.entry})`,
  ];
  if (report.css) lines.push(`stylesheet: ${kib(report.css.brotliBytes)} KiB Brotli (budget ${budgets.css})`);
  const budgeted = report.routes.filter((route) => budgets.routes[route.route] !== undefined);
  const heaviest = report.routes
    .filter((route) => budgets.routes[route.route] === undefined)
    .sort((a, b) => b.brotliBytes - a.brotliBytes)
    .slice(0, 6);
  for (const route of [...budgeted, ...heaviest]) {
    const budget = budgets.routes[route.route] ?? budgets.routeDefault;
    lines.push(`${route.route.padEnd(44)} ${kib(route.brotliBytes).padStart(6)} KiB in ${String(route.files).padStart(2)} file(s) (budget ${budget})`);
  }
  if (report.largestChunks) {
    lines.push(`largest chunks: ${report.largestChunks.map((chunk) => `${chunk.file.split("/").at(-1)} ${kib(chunk.brotliBytes)}`).join(", ")}`);
  }
  for (const route of report.routes.filter((entry) => entry.route === report.explain)) {
    lines.push(`${route.route} first-render files (Brotli KiB):`);
    for (const file of route.fileNames) lines.push(`  ${kib(report.brotliByFile[file]).padStart(6)}  ${file.split("/").at(-1)}`);
  }
  return lines;
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function parseAdminPerfCheckArgs(rawArgs) {
  const options = { runtime: false, check: true };
  const valueOptions = new Map([
    ["--root", "rootDir"], ["--admin", "admin"], ["--cpu", "cpu"], ["--rtt", "latencyMs"],
    ["--mbps", "downloadMbps"], ["--cdp-port", "cdpPort"], ["--explorer", "explorer"],
    ["--typing-product", "typingProduct"], ["--json", "json"], ["--runs", "runs"], ["--explain", "explain"],
  ]);
  const numeric = new Set(["cpu", "latencyMs", "downloadMbps", "cdpPort", "runs"]);
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--runtime") options.runtime = true;
    else if (arg === "--report-only") options.check = false;
    else if (valueOptions.has(arg)) {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Option ${arg} requires a value.`);
      const key = valueOptions.get(arg);
      options[key] = numeric.has(key) ? Number(value) : value;
      index += 1;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.admin) {
    const url = new URL(options.admin);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new Error("--admin must be a local dashboard (localhost): the runtime smoke never drives production.");
    }
  }
  return options;
}

const HELP = `Usage:
  node scripts/admin-perf-check.mjs [--report-only]
      Build the dashboard to a temp dir and check per-route Brotli budgets.
  node scripts/admin-perf-check.mjs --runtime --admin http://localhost:4323
      [--cpu 4] [--rtt 40] [--mbps 25] [--cdp-port 9396] [--runs 3]
      [--explorer http://localhost:8787] [--typing-product <productId>]
      [--json <file>] [--report-only]
  node scripts/admin-perf-check.mjs --explain admin/orders/_list/index.tsx
      Also list the files one route downloads before it renders.
      Time first load, route transitions and product-editor typing in
      headless Chrome against a running local stack (signed in with the
      local dev admin); --report-only skips the runtime budgets.`;

async function main() {
  let options;
  try {
    options = parseAdminPerfCheckArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  if (options.runtime) {
    if (!options.admin) {
      console.error("--runtime needs --admin <local dashboard URL>.");
      process.exit(1);
    }
    const runtime = await import("./admin-perf-runtime.mjs");
    const report = await runtime.runAdminPerfRuntime(options);
    for (const line of runtime.formatRuntimeReport(report)) console.log(line);
    if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    const failures = options.check ? runtime.validateRuntimeReport(report) : [];
    for (const failure of failures) console.error(`FAIL ${failure}`);
    if (failures.length > 0) process.exit(1);
    return;
  }

  const rootDir = resolve(options.rootDir ?? defaultRootDir);
  const report = await runBundleCheck({ rootDir });
  report.explain = options.explain;
  for (const line of formatBundleReport(report)) console.log(line);
  if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  const failures = options.check ? validateBundleReport(report) : [];
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log(`Admin bundle budgets: OK (${relative(process.cwd(), join(rootDir, ADMIN_DIR)) || "."})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
