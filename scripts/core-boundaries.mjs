// The structural boundaries of @scalius/core's domains (packages/core/src/modules/<domain>):
//
// - each domain has two public entries: index.ts (the server API) and, when it
//   has pure types and policies, browser.ts;
// - package consumers reach a domain only through those entries (the exports
//   map in packages/core/package.json lists nothing else);
// - inside core, one domain imports another only through a public file: the
//   other domain's entry or a file that entry re-exports;
// - a browser entry is closed: everything it reaches, types included, is itself
//   browser-exported, so the dashboard never compiles or bundles server code;
// - the directed domain dependency graph only shrinks (core-domain-graph.test.mjs).
//
// All checks take a Map of repo-relative path -> source text, so tests can feed
// small synthetic trees.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stronglyConnectedComponents } from "./admin-client-import-graph.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const ts = createRequire(import.meta.url)("typescript");

export const CORE_SRC = "packages/core/src";
export const MODULES_DIR = `${CORE_SRC}/modules`;
const BROWSER_EXTERNALS = /^(?:zod$|@scalius\/shared\/)/;
/** Core files outside the domains that browser code may use: the error classes. */
const BROWSER_SAFE_CORE = new Set([`${CORE_SRC}/errors/index.ts`]);

const isTestPath = (path) => /\.test\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:__tests__|testing)\//.test(path);

/** Repo-relative core source files (tests, declarations and test fixtures excluded). */
export function readCoreSources(root = repoRoot) {
  const sources = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (/\.ts$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !isTestPath(path)) {
        sources.set(path, readFileSync(join(root, path), "utf8"));
      }
    }
  };
  walk(CORE_SRC);
  return sources;
}

/** The domain a core path belongs to, or null outside packages/core/src/modules/<domain>/. */
export function domainOf(path) {
  const match = path.match(/^packages\/core\/src\/modules\/([^/]+)\//);
  return match ? match[1] : null;
}

const entryPath = (domain, entry) => `${MODULES_DIR}/${domain}/${entry}.ts`;

const importsCache = new Map();

/** Every static import/export specifier of a file, with whether it is type-only or a re-export. */
export function importsOf(path, text) {
  const cached = importsCache.get(path);
  if (cached?.text === text) return cached.imports;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const add = (node, spec, typeOnly, reexport) => imports.push({
    spec,
    typeOnly,
    reexport,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  });
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      const typeOnly = Boolean(clause?.isTypeOnly || (clause && !clause.name && named.length && named.every((element) => element.isTypeOnly)));
      add(statement, statement.moduleSpecifier.text, typeOnly, false);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      add(statement, statement.moduleSpecifier.text, statement.isTypeOnly, true);
    }
  }
  const visit = (node) => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node, node.argument.literal.text, true, false);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      add(node, node.arguments[0].text, false, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  importsCache.set(path, { text, imports });
  return imports;
}

/** Resolves a specifier from a core file to a repo-relative core path, or null for anything outside core. */
export function resolveCoreImport(spec, from, sources) {
  let base;
  if (spec.startsWith(".")) {
    base = relative(repoRoot, resolve(repoRoot, dirname(from), spec));
  } else if (spec.startsWith("@scalius/core/")) {
    const entry = spec.match(/^@scalius\/core\/modules\/([^/]+)(\/browser)?$/);
    base = entry ? entryPath(entry[1], entry[2] ? "browser" : "index").replace(/\.ts$/, "") : `${CORE_SRC}/${spec.slice("@scalius/core/".length)}`;
  } else {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) if (sources.has(candidate)) return candidate;
  return null;
}

/** A module and the files it re-exports (`export * from`, `export { x } from`), transitively. */
function reexportedFiles(path, sources, seen = new Set()) {
  if (seen.has(path)) return seen;
  seen.add(path);
  for (const { spec, reexport } of importsOf(path, sources.get(path))) {
    const target = reexport && resolveCoreImport(spec, path, sources);
    if (target) reexportedFiles(target, sources, seen);
  }
  return seen;
}

/** Per domain: the files its public entries expose (the entries themselves included). */
export function publicFilesByDomain(sources) {
  const result = new Map();
  for (const path of sources.keys()) {
    const domain = domainOf(path);
    if (!domain || result.has(domain)) continue;
    const files = new Set();
    for (const entry of ["index", "browser"]) {
      const file = entryPath(domain, entry);
      if (sources.has(file)) for (const reached of reexportedFiles(file, sources)) if (domainOf(reached) === domain) files.add(reached);
    }
    result.set(domain, files);
  }
  return result;
}

/** Files some browser entry exposes. */
export function browserFiles(sources) {
  const files = new Set();
  for (const path of sources.keys()) {
    if (path.endsWith("/browser.ts") && domainOf(path) && path === entryPath(domainOf(path), "browser")) {
      for (const reached of reexportedFiles(path, sources)) files.add(reached);
    }
  }
  return files;
}

/**
 * Imports that cross into another domain without going through a public file.
 * `@scalius/core/modules/<domain>/<file>` package paths are always violations.
 */
export function crossDomainImportViolations(sources) {
  const publicFiles = publicFilesByDomain(sources);
  const violations = [];
  for (const [path, text] of sources) {
    const from = domainOf(path);
    for (const { spec, line } of importsOf(path, text)) {
      if (/^@scalius\/core\/modules\/[^/]+\/(?!browser$)/.test(spec)) {
        violations.push(`${path}:${line} imports ${spec}; use the domain entry (@scalius/core/modules/<domain> or /browser)`);
        continue;
      }
      const target = resolveCoreImport(spec, path, sources);
      const to = target && domainOf(target);
      if (!to || to === from) continue;
      if (!publicFiles.get(to)?.has(target)) {
        violations.push(`${path}:${line} imports ${spec}, which ${to}'s index.ts and browser.ts do not export`);
      }
    }
  }
  return violations;
}

/** Everything a browser entry reaches (types included) must itself be browser-exported and pure. */
export function browserClosureViolations(sources) {
  const allowed = new Set([...browserFiles(sources), ...BROWSER_SAFE_CORE]);
  const violations = [];
  for (const file of allowed) {
    if (!sources.has(file)) continue;
    for (const { spec, line } of importsOf(file, sources.get(file))) {
      const target = resolveCoreImport(spec, file, sources);
      if (target) {
        if (!allowed.has(target)) violations.push(`${file}:${line} (browser) reaches ${target}, which no browser entry exports`);
      } else if (!BROWSER_EXTERNALS.test(spec)) {
        violations.push(`${file}:${line} (browser) imports ${spec}; browser code may import only zod, @scalius/shared and browser entries`);
      }
    }
  }
  return violations;
}

/** Directed domain edges ("from -> to") of production code, type imports included. */
export function domainEdges(sources) {
  const edges = new Map();
  for (const [path, text] of sources) {
    const from = domainOf(path);
    if (!from) continue;
    for (const { spec } of importsOf(path, text)) {
      const target = resolveCoreImport(spec, path, sources);
      const to = target && domainOf(target);
      if (!to || to === from) continue;
      const key = `${from} -> ${to}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return edges;
}

/** Strongly connected domain groups with more than one member (dependency cycles). */
export function domainCycles(edges) {
  const graph = new Map();
  for (const key of edges.keys()) {
    const [from, to] = key.split(" -> ");
    if (!graph.has(from)) graph.set(from, new Set());
    if (!graph.has(to)) graph.set(to, new Set());
    graph.get(from).add(to);
  }
  return stronglyConnectedComponents(graph)
    .filter((component) => component.length > 1)
    .map((component) => component.sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** The exports map lists exactly one index entry per domain plus its browser entry, and no module wildcard. */
export function coreExportsViolations(pkg, domains) {
  const violations = [];
  const exportsMap = pkg.exports ?? {};
  for (const key of Object.keys(exportsMap)) {
    if (!key.startsWith("./modules")) continue;
    const match = key.match(/^\.\/modules\/([^/*]+)(\/browser)?$/);
    if (!match) {
      violations.push(`packages/core/package.json exports ${key}; module exports are ./modules/<domain> and ./modules/<domain>/browser only`);
      continue;
    }
    const [, domain, browser] = match;
    const expected = `./src/modules/${domain}/${browser ? "browser" : "index"}.ts`;
    if (exportsMap[key] !== expected) violations.push(`packages/core/package.json exports ${key} -> ${exportsMap[key]}; expected ${expected}`);
    if (!domains.has(domain)) violations.push(`packages/core/package.json exports ${key}, but ${MODULES_DIR}/${domain} does not exist`);
  }
  for (const [domain, entries] of domains) {
    if (!entries.index) violations.push(`${MODULES_DIR}/${domain} has no index.ts`);
    if (!exportsMap[`./modules/${domain}`]) violations.push(`packages/core/package.json does not export ./modules/${domain}`);
    if (entries.browser && !exportsMap[`./modules/${domain}/browser`]) violations.push(`packages/core/package.json does not export ./modules/${domain}/browser`);
    if (!entries.browser && exportsMap[`./modules/${domain}/browser`]) violations.push(`packages/core/package.json exports ./modules/${domain}/browser, but ${domain} has no browser.ts`);
  }
  return violations;
}

/** Domain directories on disk and which entries they have. */
export function readDomains(root = repoRoot) {
  const domains = new Map();
  for (const entry of readdirSync(join(root, MODULES_DIR), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    domains.set(entry.name, {
      index: existsSync(join(root, MODULES_DIR, entry.name, "index.ts")),
      browser: existsSync(join(root, MODULES_DIR, entry.name, "browser.ts")),
    });
  }
  return domains;
}

/** All boundary violations of the current tree (the source-policy check runs this). */
export function collectCoreBoundaryViolations(root = repoRoot) {
  const sources = readCoreSources(root);
  const pkg = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8"));
  return [
    ...coreExportsViolations(pkg, readDomains(root)),
    ...crossDomainImportViolations(sources),
    ...browserClosureViolations(sources),
  ];
}

// `node scripts/core-boundaries.mjs` prints the domain graph; `--write-allowlist`
// rewrites scripts/core-domain-graph.allow.json from the current code. Commit a
// shrinking allowlist freely; a growing one is a reviewed dependency decision.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const edges = domainEdges(readCoreSources());
  const cycles = domainCycles(edges);
  const allowlist = {
    $comment: [
      "Directed dependencies between packages/core/src/modules domains (type imports included).",
      "scripts/core-domain-graph.test.mjs fails on any edge not listed here and on any listed edge the code no longer has.",
      "cycles lists the strongly connected domain groups these edges allow; shrink them, never grow them without review.",
      "Regenerate with: node scripts/core-boundaries.mjs --write-allowlist",
    ],
    edges: [...edges.keys()].sort(),
    cycles,
  };
  if (process.argv.includes("--write-allowlist")) {
    writeFileSync(join(repoRoot, "scripts/core-domain-graph.allow.json"), `${JSON.stringify(allowlist, null, 2)}\n`);
  }
  console.log(`${edges.size} domain edges; ${cycles.length} cycle group(s): ${cycles.map((group) => group.join(" ↔ ")).join("; ") || "none"}`);
}
