#!/usr/bin/env node
// Dashboard performance gate.
//
// Default: takes the chunk graph of the dashboard build that is already in
// apps/admin-v2/dist (the build writes it beside its cache: scripts/admin-chunk-graph.mjs,
// valid only while dist holds the bytes it describes), or else builds the
// dashboard into a temporary directory. It maps every route
// to the JavaScript its first render needs (the entry chunk, plus the lazy
// component chunks of the route and its layouts, plus everything those import
// statically) and checks each against a Brotli budget. It fails when a heavy
// library (rich-text editor, QR scanner, PDF; phone metadata or drag and drop
// on the everyday screens) becomes part of a route's first download, or when
// anything grows past its budget.
//
// --runtime: times first load and route transitions against a running local
// stack in headless Chrome (see scripts/admin-perf-runtime.mjs).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

import { chunkGraphPath, readBuiltChunkGraph, sha256 } from "./admin-chunk-graph.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(scriptDirectory, "..");
const ADMIN_DIR = "apps/admin-v2";

/**
 * Brotli KiB budgets. `entry` is what index.html loads before any route; each
 * route is its full first-render JavaScript (entry included). These are
 * release ceilings: reduce the output to fit rather than raising a budget.
 * Every route keeps ROUTE_MIN_HEADROOM_KIB below its ceiling for shared-chunk
 * churn. A feature consumes that space only after another dependency is
 * trimmed. The entry chunk stays exact.
 */
export const ROUTE_MIN_HEADROOM_KIB = 1.5;

/**
 * The stylesheet keeps its existing tolerance. One Tailwind file compresses as a
 * whole, so its Brotli size swings by tens of bytes when any one rule changes:
 * swapping `left-(--tip-x)` for `inset-s-(--tip-x)` alone added 67 bytes, and
 * a build whose raw CSS shrank by 80 bytes grew by 57 compressed. An exact
 * ceiling made every class change a lottery. Real growth past the slack (a
 * library's styles, a stray utility family) still fails.
 */
export const STYLESHEET_HEADROOM_KIB = 1;

export const BUNDLE_BUDGETS = {
  entry: 138,
  // +0.1: rendered section-library layouts and shared hybrid touch controls.
  // Measured 17,486 bytes after deduplicating unchanged dark-theme tokens.
  // +0.2: the Apps redesign (feature cards, consent and setup checklist).
  css: 17.3,
  // Editors (rich text preview, forms, validation) sit near 290-350.
  routeDefault: 360,
  routes: {
    "auth/login.tsx": 168,
    // +1 (global G1a): the store time zone every date in the shell is formatted
    // in. The setup guide loads after Home's first render, so it costs nothing here.
    "admin/index.tsx": 207,
    "admin/orders/_list/index.tsx": 290,
    // Wave B: gift-card tenders, digital and gift-card line cards, refund to a gift card.
    // +1 (catalogue dashboard): the Brands link and its search words in the shell.
    // The status card's cancel confirmation loads when first asked for (list UX).
    // -3.5: the Messages card (thread, reply box, copy) and the cash-on-delivery
    // dialogs load after the page; measured 284.1.
    // -0.8: the timeline, returns, notifications and payment and hand-over dialogs'
    // own copy loads with them, not in the page's catalog; measured 283.3.
    "admin/orders/$orderId/index.tsx": 283.7,
    "admin/products/index.tsx": 290,
    // +1 (catalogue dashboard): the brand field and the lazy merchandising cards' loaders.
    // +1 (catalogue dashboard): categories named by their tree path, and saving the
    // content-block, bundle and template sections in turn under the product revision.
    // +1: the shared icon and SDK chunks the new catalogue screens regrouped.
    // +0.1: truthful app consent copy (storefront components, en + bn).
    // -8.3: the cards under the variants (digital delivery, gift card, attributes, search
    // listing) and the category picker's list load after the page; measured 360.6.
    // -1.3: the variant editor's copy loads with the editor; measured 359.3.
    "admin/products/$productId/edit.tsx": 359.7,
    // The editor plus the navigation shell and the save system's real
    // variant diff and in-flight-save rebase (edits typed while saving stay dirty).
    // +2 (catalogue dashboard): the same category paths and section-save code as the edit
    // page, and the shared icon and SDK chunks the new catalogue screens regrouped.
    // +0.3: the local "Bengali System" fallback face that keeps the Taka sign off the platform font search.
    // -8.5: the same lazy cards and category list as the edit page; measured 357.3.
    // -1: the variant editor's copy loads with the editor; measured 356.1.
    "admin/products/new.tsx": 356.5,
    // +0.3 over the default: the type preview's "Bengali System" fallback face.
    // -4.7: theme sections check custom field keys without the value codec; measured 355.2.
    // 2026-10-24: shipping profiles add 0.3 KiB of shared-chunk churn (entry, dialog) that every route pays.
    // -10.3: the first screen reads section names, fit reasons and the resource picker's words from
    // the common online store copy; the rest of the online store's words load with its panels.
    // Measured 347.1; the budget keeps that headroom for the shell's shared churn.
    "admin/online-store/theme_.editor.tsx": 356.0,
    "admin/inventory/index.tsx": 255,
    // The customer page's own copy is apart from the list's (list UX).
    "admin/customers/index.tsx": 245,
    // -53.3: the dialogs' fields (email check, phone input, image pickers, the
    // web-address check) load after the page, so zod and their widgets do too;
    // the contact row formats a landline without them. Measured 237.3.
    "admin/settings/store.tsx": 237.7,
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
  { name: "store settings editing copy", pattern: /\/i18n\/settings-store-fields\.ts$/, only: ["admin/settings/store.tsx"] },
  { name: "invoice printing copy", pattern: /\/i18n\/order-invoice\.ts$/, only: HOT_ROUTES },
  { name: "order address editing copy", pattern: /\/i18n\/order-address-edit\.ts$/, only: ["admin/orders/$orderId/index.tsx"] },
  { name: "shell dialog copy", pattern: /\/i18n\/shell-dialogs\.ts$/ },
  { name: "product attribute picker copy", pattern: /\/i18n\/product-attributes\.ts$/, only: ["admin/products/new.tsx", "admin/products/$productId/edit.tsx"] },
  { name: "extra product sections copy", pattern: /\/i18n\/product-sections\.ts$/, only: ["admin/products/new.tsx", "admin/products/$productId/edit.tsx"] },
  { name: "custom data editor", pattern: /\/custom-fields\/CustomFieldsCard\.tsx$/ },
  { name: "gift card product editor copy", pattern: /\/i18n\/gift-card-product\.ts$/, only: ["admin/products/new.tsx", "admin/products/$productId/edit.tsx"] },
  { name: "gift card order dialogs", pattern: /\/i18n\/gift-card-orders\.ts$|\/orderview\/GiftCardLinesCard\.tsx$/, only: ["admin/orders/$orderId/index.tsx"] },
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
 * file names that carry each route file's lazy page component and loader
 * (both load before the page renders).
 */
export function renderChunksByRoute(chunks, routesDir) {
  const byRoute = new Map();
  const prefix = `${routesDir.split("\\").join("/")}/`;
  for (const chunk of chunks) {
    for (const id of chunk.moduleIds) {
      const normalized = id.split("\\").join("/");
      const split = normalized.match(/\?tsr-split=(?:component|loader)$/);
      if (!split || !normalized.startsWith(prefix)) continue;
      const routeFile = normalized.slice(prefix.length, -split[0].length);
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
  const renderChunks = renderChunksByRoute(chunks, routesDir);
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
    const own = routeAncestry(routeFile, parentByFile).flatMap((file) => renderChunks.get(file) ?? []);
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
  if (report.css && kib(report.css.brotliBytes) > budgets.css + STYLESHEET_HEADROOM_KIB) {
    failures.push(`stylesheet is ${kib(report.css.brotliBytes).toFixed(1)} KiB Brotli (budget ${budgets.css} KiB)`);
  }
  for (const route of report.routes) {
    const budget = budgets.routes[route.route] ?? budgets.routeDefault;
    if (kib(route.brotliBytes) > budget - ROUTE_MIN_HEADROOM_KIB) {
      failures.push(`${route.route} needs ${kib(route.brotliBytes).toFixed(1)} KiB Brotli to render (budget ${budget} KiB; keep ${ROUTE_MIN_HEADROOM_KIB} KiB free)`);
    }
    if (route.lazyOnly.length > 0) failures.push(`${route.route} loads ${route.lazyOnly.join(", ")} before it renders`);
  }
  for (const route of Object.keys(budgets.routes)) {
    if (!report.routes.some((entry) => entry.route === route)) failures.push(`budgeted route ${route} no longer exists`);
  }
  return failures;
}

// ── Build ──────────────────────────────────────────────────────────────────

/**
 * Builds the dashboard into `outDir` and returns its chunk graph. The build's own
 * config writes the graph (adminChunkGraphPlugin); this reads it back and drops it.
 */
export async function buildAdminBundle(rootDir, outDir) {
  const adminDir = join(rootDir, ADMIN_DIR);
  const requireFromAdmin = createRequire(join(adminDir, "package.json"));
  const { build } = await import(pathToFileURL(requireFromAdmin.resolve("vite")).href);
  await build({
    root: adminDir,
    configFile: join(adminDir, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
  const graph = readBuiltChunkGraph(adminDir, outDir);
  rmSync(chunkGraphPath(adminDir, outDir), { force: true });
  if (!graph) throw new Error("The dashboard build wrote no chunk graph (adminChunkGraphPlugin in apps/admin-v2/vite.config.ts).");
  return { chunks: graph.chunks, cssFiles: graph.cssFiles, routesDir: join(adminDir, "src/routes") };
}

const BROTLI_QUALITY = 11;

function brotliSize(content) {
  return brotliCompressSync(content, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }).length;
}

/**
 * Brotli sizes cached by content hash: a chunk whose bytes did not change is not
 * compressed again at quality 11 (about 14 s for the dashboard). The key holds the
 * quality and the Node build's Brotli version, so neither can serve a stale size.
 * `size(path)` reads the file; `save()` writes the cache file, keeping the entries
 * this run used and the most recent earlier ones.
 */
export function createBrotliCache({ file, compress = brotliSize, keep = 4000, brotliVersion = process.versions.brotli } = {}) {
  let stored = {};
  try {
    const parsed = file ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.sizes) stored = parsed.sizes;
  } catch {
    stored = {};
  }
  const used = new Map();
  const stats = { hits: 0, compressed: 0 };
  return {
    stats,
    size(path) {
      const content = readFileSync(path);
      const key = `brotli@${brotliVersion}:q${BROTLI_QUALITY}:${sha256(content)}`;
      let bytes = used.get(key) ?? stored[key];
      if (Number.isInteger(bytes)) stats.hits += 1;
      else {
        bytes = compress(content);
        stats.compressed += 1;
      }
      used.set(key, bytes);
      return bytes;
    },
    save() {
      if (!file) return;
      const sizes = {};
      const older = Object.keys(stored).filter((key) => !used.has(key)).slice(-Math.max(0, keep - used.size));
      for (const key of older) sizes[key] = stored[key];
      for (const [key, bytes] of used) sizes[key] = bytes;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ version: 1, sizes })}\n`);
    },
  };
}

export async function runBundleCheck({ rootDir = defaultRootDir, brotliCacheFile = join(rootDir, "node_modules/.cache/scalius/admin-perf-brotli.json") } = {}) {
  const adminDir = join(rootDir, ADMIN_DIR);
  const builtDir = join(adminDir, "dist");
  const existing = readBuiltChunkGraph(adminDir, builtDir);
  const outDir = existing ? builtDir : mkdtempSync(join(tmpdir(), "scalius-admin-perf-build-"));
  try {
    const { chunks, cssFiles, routesDir } = existing
      ? { chunks: existing.chunks, cssFiles: existing.cssFiles, routesDir: join(adminDir, "src/routes") }
      : await buildAdminBundle(rootDir, outDir);
    const parentByFile = parseRouteTree(readFileSync(join(rootDir, ADMIN_DIR, "src/routeTree.gen.ts"), "utf8"));
    const brotli = createBrotliCache({ file: brotliCacheFile });
    const cache = new Map();
    const brotliBytes = (fileName) => {
      if (!cache.has(fileName)) cache.set(fileName, brotli.size(join(outDir, fileName)));
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
    report.source = {
      graph: existing ? "the existing dashboard build" : "a fresh dashboard build",
      brotliCached: brotli.stats.hits,
      brotliCompressed: brotli.stats.compressed,
    };
    brotli.save();
    return report;
  } finally {
    if (!existing) rmSync(outDir, { recursive: true, force: true });
  }
}

export function formatBundleReport(report, budgets = BUNDLE_BUDGETS) {
  const kib = (bytes) => (bytes / 1024).toFixed(1);
  const lines = [
    `entry: ${kib(report.entry.brotliBytes)} KiB Brotli in ${report.entry.files} file(s) (budget ${budgets.entry})`,
  ];
  if (report.source) {
    lines.unshift(`chunk graph from ${report.source.graph}; Brotli 11 sizes: ${report.source.brotliCached} cached by content hash, ${report.source.brotliCompressed} compressed`);
  }
  if (report.css) lines.push(`stylesheet: ${kib(report.css.brotliBytes)} KiB Brotli (budget ${budgets.css})`);
  const budgeted = report.routes.filter((route) => budgets.routes[route.route] !== undefined);
  const heaviest = report.routes
    .filter((route) => budgets.routes[route.route] === undefined)
    .sort((a, b) => b.brotliBytes - a.brotliBytes)
    .slice(0, 6);
  for (const route of [...budgeted, ...heaviest]) {
    const budget = budgets.routes[route.route] ?? budgets.routeDefault;
    const headroom = (budget - route.brotliBytes / 1024).toFixed(3);
    lines.push(`${route.route.padEnd(44)} ${kib(route.brotliBytes).padStart(6)} KiB in ${String(route.files).padStart(2)} file(s) (budget ${budget}; ${headroom} KiB free)`);
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
