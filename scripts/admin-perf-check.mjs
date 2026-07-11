#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(__dirname, "..");

const adminSourceDir = "apps/admin-v2/src";
const sourceExtensions = new Set([".ts", ".tsx"]);
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  ".vite",
  "dist",
  "node_modules",
]);

const majorListRoutes = [
  "apps/admin-v2/src/routes/admin/products/index.tsx",
  "apps/admin-v2/src/routes/admin/orders/index.tsx",
  "apps/admin-v2/src/routes/admin/customers/index.tsx",
  "apps/admin-v2/src/routes/admin/categories/index.tsx",
  "apps/admin-v2/src/routes/admin/collections/index.tsx",
  "apps/admin-v2/src/routes/admin/discounts/index.tsx",
  "apps/admin-v2/src/routes/admin/pages/index.tsx",
];

const dndMarkers = [
  "@dnd-kit",
  "useSortable",
  "DndContext",
  "SortableContext",
  "sortableKeyboardCoordinates",
];

const productFormTiptapInternals = [
  "<TiptapEditor",
  "React.lazy(() => import(",
  "useEditor",
  "EditorContent",
  "prosemirror",
  "@tiptap",
];

function toPosixPath(value) {
  return value.split("\\").join("/");
}

function resolveFromRoot(rootDir, relativePath) {
  return resolve(rootDir, relativePath);
}

function relativeFromRoot(rootDir, absolutePath) {
  return toPosixPath(relative(rootDir, absolutePath));
}

function readFile(rootDir, relativePath) {
  return readFileSync(resolveFromRoot(rootDir, relativePath), "utf8");
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r\n|\r|\n/).length;
}

function collectSourceFiles(directory) {
  const found = [];
  if (!existsSync(directory)) return found;

  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;

    const absolutePath = join(directory, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      found.push(...collectSourceFiles(absolutePath));
      continue;
    }
    if (stat.isFile() && sourceExtensions.has(extname(entry))) {
      found.push(absolutePath);
    }
  }

  return found.sort();
}

function staticImportSpecifiers(source) {
  const specifiers = [];
  const pattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push({
      specifier: match[1],
      index: match.index ?? 0,
    });
  }
  return specifiers;
}

function dynamicImportSpecifiers(source) {
  const specifiers = [];
  const pattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    specifiers.push({
      specifier: match[1],
      index: match.index ?? 0,
    });
  }
  return specifiers;
}

function allImportSpecifiers(source) {
  return [
    ...staticImportSpecifiers(source).map((item) => ({ ...item, dynamic: false })),
    ...dynamicImportSpecifiers(source).map((item) => ({ ...item, dynamic: true })),
  ].sort((a, b) => a.index - b.index);
}

function isApiQueriesSpecifier(specifier) {
  const normalized = specifier
    .replace(/\?(.*)$/, "")
    .replace(/\.(?:m?[jt]sx?)$/, "")
    .replace(/\\/g, "/");

  if (!normalized.endsWith("api.queries")) return false;
  return (
    normalized.startsWith(".") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("@/") ||
    normalized.includes("/lib/api.queries") ||
    normalized.endsWith("/api.queries")
  );
}

function linesContaining(source, pattern) {
  const regex = typeof pattern === "string" ? null : pattern;
  return source
    .split(/\r\n|\r|\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => (regex ? regex.test(line) : line.includes(pattern)));
}

function hasPattern(source, pattern) {
  return typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
}

function addResult(context, status, label, detail) {
  context.results.push({ status, label, detail });
}

function pass(context, label, detail) {
  addResult(context, "PASS", label, detail);
}

function skip(context, label, detail) {
  addResult(context, "SKIP", label, detail);
}

function fail(context, group, message) {
  context.failures.push({ group, message });
}

function runCheck(context, label, callback) {
  const failureCount = context.failures.length;
  callback();
  if (context.failures.length === failureCount) pass(context, label);
}

function requireFile(context, relativePath, group) {
  const absolutePath = resolveFromRoot(context.rootDir, relativePath);
  if (existsSync(absolutePath)) return true;
  fail(context, group, `${relativePath} is missing.`);
  return false;
}

function requireContains(context, relativePath, pattern, group, message) {
  if (!requireFile(context, relativePath, group)) return false;
  const source = readFile(context.rootDir, relativePath);
  if (hasPattern(source, pattern)) return true;
  fail(context, group, `${relativePath}: ${message}`);
  return false;
}

function requireLacksMarkers(context, relativePath, markers, group, messagePrefix) {
  if (!requireFile(context, relativePath, group)) return false;
  const source = readFile(context.rootDir, relativePath);
  const bad = markers.filter((marker) => source.includes(marker));
  if (bad.length === 0) return true;
  fail(context, group, `${relativePath}: ${messagePrefix}: ${bad.join(", ")}`);
  return false;
}

function requireNoStaticImports(context, relativePath, blockedPattern, group, messagePrefix) {
  if (!requireFile(context, relativePath, group)) return false;
  const source = readFile(context.rootDir, relativePath);
  const bad = staticImportSpecifiers(source).filter(({ specifier }) =>
    blockedPattern.test(specifier),
  );
  if (bad.length === 0) return true;
  fail(
    context,
    group,
    `${relativePath}: ${messagePrefix}: ${bad.map((item) => item.specifier).join(", ")}`,
  );
  return false;
}

function checkDeletedApiQueriesBarrel(context) {
  runCheck(context, "source: deleted api.queries barrel is absent", () => {
    const barrel = "apps/admin-v2/src/lib/api.queries.ts";
    if (existsSync(resolveFromRoot(context.rootDir, barrel))) {
      fail(context, "source", `${barrel} exists; the broad query barrel must stay deleted.`);
    }
  });
}

function checkNoApiQueriesImports(context) {
  runCheck(context, "source: no api.queries imports remain", () => {
    const srcDir = resolveFromRoot(context.rootDir, adminSourceDir);
    if (!existsSync(srcDir)) {
      fail(context, "source", `${adminSourceDir} is missing.`);
      return;
    }

    const matches = [];
    for (const file of collectSourceFiles(srcDir)) {
      const source = readFileSync(file, "utf8");
      for (const item of allImportSpecifiers(source)) {
        if (!isApiQueriesSpecifier(item.specifier)) continue;
        matches.push(
          `${relativeFromRoot(context.rootDir, file)}:${lineNumberAt(source, item.index)} imports ${item.specifier}`,
        );
      }
    }

    if (matches.length > 0) {
      fail(
        context,
        "source",
        `Deleted broad api.queries barrel is imported:\n    ${matches.join("\n    ")}`,
      );
    }
  });
}

function checkApiQueryOptionsReferences(context) {
  runCheck(context, "source: api-query-options do not reference api.queries", () => {
    const dir = resolveFromRoot(context.rootDir, "apps/admin-v2/src/lib/api-query-options");
    if (!existsSync(dir)) {
      fail(context, "source", "apps/admin-v2/src/lib/api-query-options is missing.");
      return;
    }

    const matches = [];
    for (const file of collectSourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      for (const { number } of linesContaining(source, "api.queries")) {
        matches.push(`${relativeFromRoot(context.rootDir, file)}:${number}`);
      }
    }

    if (matches.length > 0) {
      fail(
        context,
        "source",
        `api-query-options still reference api.queries: ${matches.join(", ")}`,
      );
    }
  });
}

function checkWarmRouteQueries(context) {
  runCheck(context, "source: major list routes warm route queries", () => {
    for (const route of majorListRoutes) {
      requireContains(
        context,
        route,
        /\bwarmRouteQuery\s*\(/,
        "source",
        "expected a warmRouteQuery(...) call for non-blocking list navigation.",
      );
    }
  });
}

function checkUseServerTableFreshness(context) {
  runCheck(context, "source: useServerTable preserves rows and mount freshness", () => {
    const file = "apps/admin-v2/src/components/admin/data-table/useServerTable.ts";
    if (!requireFile(context, file, "source")) return;
    const source = readFile(context.rootDir, file);

    if (!/placeholderData:\s*keepPreviousData\b/.test(source)) {
      fail(context, "source", `${file}: expected placeholderData: keepPreviousData.`);
    }
    if (!/refetchOnMount\s*:\s*["']always["']/.test(source)) {
      fail(context, "source", `${file}: expected refetchOnMount: "always".`);
    }
    if (/staleTime\s*:\s*(?:Infinity|Number\.POSITIVE_INFINITY)\b/.test(source)) {
      fail(context, "source", `${file}: infinite staleTime would suppress mount freshness.`);
    }
  });
}

function checkDataTableDndBoundary(context) {
  runCheck(context, "source: DataTable DnD stays in sortable lazy path", () => {
    requireLacksMarkers(
      context,
      "apps/admin-v2/src/components/admin/data-table/DataTable.tsx",
      dndMarkers,
      "source",
      "hot DataTable path must not contain drag-and-drop markers",
    );

    const sortableFile =
      "apps/admin-v2/src/components/admin/data-table/SortableDataTableContent.tsx";
    for (const marker of dndMarkers) {
      requireContains(
        context,
        sortableFile,
        marker,
        "source",
        `expected sortable lazy content to own ${marker}.`,
      );
    }
  });
}

function checkProductFormTiptapBoundary(context) {
  runCheck(context, "source: ProductForm uses deferred Tiptap boundary", () => {
    requireLacksMarkers(
      context,
      "apps/admin-v2/src/components/admin/ProductForm.tsx",
      productFormTiptapInternals,
      "source",
      "ProductForm must not directly render/import Tiptap internals",
    );
    requireContains(
      context,
      "apps/admin-v2/src/components/admin/product-form/TitleDescriptionSection.tsx",
      "DeferredTiptapEditor",
      "source",
      "expected the product description section to use DeferredTiptapEditor.",
    );
  });
}

function checkProductImagesBoundary(context) {
  runCheck(context, "source: product images reorder UI is lazy", () => {
    const file = "apps/admin-v2/src/components/admin/product-form/ProductImagesSection.tsx";
    requireContains(
      context,
      file,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\.\/DraggableImageGallery["']\)/,
      "source",
      "expected DraggableImageGallery to be lazy-loaded.",
    );
    requireNoStaticImports(
      context,
      file,
      /(?:^|\/)DraggableImageGallery$/,
      "source",
      "DraggableImageGallery must not be statically imported",
    );
  });
}

function checkVariantToolBoundaries(context) {
  runCheck(context, "source: variant heavy tools are lazy/on-demand", () => {
    const manager = "apps/admin-v2/src/components/admin/product-form/variants/VariantManager.tsx";
    const toolbar =
      "apps/admin-v2/src/components/admin/product-form/variants/VariantActionsToolbar.tsx";

    requireContains(
      context,
      manager,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\/VariantSortModal["']\)/,
      "source",
      "expected VariantSortModal to be lazy-loaded.",
    );
    requireContains(
      context,
      toolbar,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\/bulk-generator["']\)/,
      "source",
      "expected bulk-generator to be lazy-loaded.",
    );
    requireContains(
      context,
      toolbar,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\/VariantImportExport["']\)/,
      "source",
      "expected VariantImportExport to be lazy-loaded.",
    );
    requireContains(
      context,
      toolbar,
      /import\(["']\.\/utils\/csvHelpers["']\)/,
      "source",
      "expected csvHelpers to load only from the export action.",
    );

    const blocked = /(?:bulk-generator|VariantSortModal|VariantImportExport|utils\/csvHelpers)$/;
    requireNoStaticImports(
      context,
      manager,
      blocked,
      "source",
      "variant manager must not statically import heavy variant tools",
    );
    requireNoStaticImports(
      context,
      toolbar,
      blocked,
      "source",
      "variant toolbar must not statically import heavy variant tools",
    );
  });
}

function checkNavigationBuilderBoundary(context) {
  runCheck(context, "source: NavigationBuilder reorder UI is lazy", () => {
    const file = "apps/admin-v2/src/components/admin/navigation/NavigationBuilder.tsx";
    requireContains(
      context,
      file,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\/SortableNavigationEditor["']\)/,
      "source",
      "expected SortableNavigationEditor to be lazy-loaded.",
    );
    requireNoStaticImports(
      context,
      file,
      /(?:^|\/)SortableNavItem$/,
      "source",
      "NavigationBuilder must not directly import SortableNavItem",
    );
  });
}

function checkGeneralSettingsBoundary(context) {
  runCheck(context, "source: GeneralSettings header/footer builders are lazy", () => {
    const file = "apps/admin-v2/src/components/admin/settings/GeneralSettingsPage.tsx";
    requireContains(
      context,
      file,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\.\/header-builder["']\)/,
      "source",
      "expected HeaderBuilder to be lazy-loaded.",
    );
    requireContains(
      context,
      file,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\.\/footer-builder["']\)/,
      "source",
      "expected FooterBuilder to be lazy-loaded.",
    );
    requireNoStaticImports(
      context,
      file,
      /^\.\.\/(?:header-builder|footer-builder)$/,
      "source",
      "GeneralSettingsPage must not statically import builder modules",
    );
  });
}

function checkOrderViewBoundary(context) {
  runCheck(context, "source: OrderView secondary cards are lazy", () => {
    const file = "apps/admin-v2/src/components/admin/OrderView.tsx";
    requireContains(
      context,
      file,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\/orderview\/OrderSupportRequestsCard["']\)/,
      "source",
      "expected support requests card to be lazy-loaded.",
    );
    requireContains(
      context,
      file,
      /lazy\s*\(\s*\(\)\s*=>\s*[\s\n]*import\(["']\.\/orderview\/OrderNotificationsCard["']\)/,
      "source",
      "expected notification history card to be lazy-loaded.",
    );
    requireNoStaticImports(
      context,
      file,
      /(?:OrderSupportRequestsCard|OrderNotificationsCard)$/,
      "source",
      "OrderView must not statically import secondary order cards",
    );
  });
}

function checkServerManifest(context) {
  const manifestPath = "apps/admin-v2/dist/server/.vite/manifest.json";
  const absoluteManifestPath = resolveFromRoot(context.rootDir, manifestPath);
  if (!existsSync(absoluteManifestPath)) {
    skip(context, "dist: server manifest route chunks", `${manifestPath} not found`);
    return;
  }

  const failureCount = context.failures.length;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
  } catch (error) {
    fail(
      context,
      "dist",
      `${manifestPath}: could not parse JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
    return;
  }

  const hotEntries = Object.entries(manifest).filter(
    ([key]) => key.includes("routes/admin/index") || key.includes("routes/admin/settings"),
  );

  if (hotEntries.length === 0) {
    skip(context, "dist: server manifest route chunks", "no dashboard/settings route chunks found");
    return;
  }

  const bad = [];
  for (const [key, value] of hotEntries) {
    const blob = JSON.stringify(value);
    if (/list-helpers|api\.queries/.test(blob)) bad.push(key);
  }

  if (bad.length > 0) {
    fail(
      context,
      "dist",
      `server manifest dashboard/settings chunks reference list-helpers/api.queries: ${bad.join(", ")}`,
    );
  }

  if (context.failures.length === failureCount) {
    pass(context, "dist: server manifest route chunks", `${hotEntries.length} entries`);
  }
}

function checkProductFormClientChunk(context) {
  const assetsPath = "apps/admin-v2/dist/client/assets";
  const absoluteAssetsPath = resolveFromRoot(context.rootDir, assetsPath);
  if (!existsSync(absoluteAssetsPath)) {
    skip(context, "dist: ProductForm client chunk", `${assetsPath} not found`);
    return;
  }

  const files = readdirSync(absoluteAssetsPath)
    .filter((file) => /^ProductForm-.*\.js$/.test(file))
    .sort();
  if (files.length === 0) {
    skip(context, "dist: ProductForm client chunk", "no ProductForm-*.js artifact found");
    return;
  }

  const failureCount = context.failures.length;
  const bad = [];
  for (const file of files) {
    const source = readFileSync(join(absoluteAssetsPath, file), "utf8");
    const imports = staticImportSpecifiers(source).map((item) => item.specifier);
    const forbidden = imports.filter(
      (specifier) =>
        /sortable|AdditionalInfoManager|DraggableImageGallery|TiptapEditor|prosemirror/i.test(
          specifier,
        ) && !/DeferredTiptapEditor/i.test(specifier),
    );
    if (forbidden.length > 0) {
      bad.push(`${assetsPath}/${file}: ${forbidden.join(", ")}`);
    }
  }

  if (bad.length > 0) {
    fail(
      context,
      "dist",
      `ProductForm chunk has forbidden static imports:\n    ${bad.join("\n    ")}`,
    );
  }

  if (context.failures.length === failureCount) {
    pass(context, "dist: ProductForm client chunk", `${files.length} chunk(s)`);
  }
}

function checkAdminDist(context) {
  const distPath = "apps/admin-v2/dist";
  if (!existsSync(resolveFromRoot(context.rootDir, distPath))) {
    skip(context, "dist: admin build artifacts", `${distPath} not found`);
    return;
  }

  checkServerManifest(context);
  checkProductFormClientChunk(context);
}

export function runAdminPerfCheck({ rootDir = defaultRootDir } = {}) {
  const context = {
    rootDir: resolve(rootDir),
    results: [],
    failures: [],
  };

  checkDeletedApiQueriesBarrel(context);
  checkNoApiQueriesImports(context);
  checkApiQueryOptionsReferences(context);
  checkWarmRouteQueries(context);
  checkUseServerTableFreshness(context);
  checkDataTableDndBoundary(context);
  checkProductFormTiptapBoundary(context);
  checkProductImagesBoundary(context);
  checkVariantToolBoundaries(context);
  checkNavigationBuilderBoundary(context);
  checkGeneralSettingsBoundary(context);
  checkOrderViewBoundary(context);
  checkAdminDist(context);

  return {
    rootDir: context.rootDir,
    ok: context.failures.length === 0,
    results: context.results,
    failures: context.failures,
  };
}

export function formatAdminPerfCheckReport(report) {
  const lines = report.results.map(({ status, label, detail }) =>
    detail ? `${status} ${label} - ${detail}` : `${status} ${label}`,
  );

  if (report.failures.length === 0) {
    return lines;
  }

  lines.push("FAIL admin performance confidence gate");
  const grouped = new Map();
  for (const failure of report.failures) {
    const group = grouped.get(failure.group) ?? [];
    group.push(failure.message);
    grouped.set(failure.group, group);
  }

  for (const [group, messages] of grouped) {
    lines.push(`FAIL ${group}`);
    for (const message of messages) {
      lines.push(`  - ${message}`);
    }
  }

  return lines;
}

export function parseAdminPerfCheckArgs(rawArgs) {
  const options = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--root") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Option --root requires a path.");
      }
      options.rootDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      options.rootDir = arg.slice("--root=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/admin-perf-check.mjs [--root <path>]

Runs a read-only admin performance confidence gate over local source and, when
present, apps/admin-v2/dist artifacts.`);
}

function main() {
  let options;
  try {
    options = parseAdminPerfCheckArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    return;
  }

  const report = runAdminPerfCheck({ rootDir: options.rootDir });
  const lines = formatAdminPerfCheckReport(report);
  const firstFailureIndex = lines.findIndex((line) => line.startsWith("FAIL "));
  const resultLines = firstFailureIndex === -1 ? lines : lines.slice(0, firstFailureIndex);
  const failureLines = firstFailureIndex === -1 ? [] : lines.slice(firstFailureIndex);

  for (const line of resultLines) console.log(line);
  for (const line of failureLines) console.error(line);

  if (!report.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
