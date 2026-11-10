// One module per API operation in the dashboard build.
//
// The generated SDK (packages/api-client/src/generated/sdk.gen.ts) is a single
// module of every operation. A bundler places a module in exactly one chunk, so
// the dashboard's shared SDK chunk carried every operation any screen calls, and
// every route downloaded it before rendering: each operation added for one screen
// cost every other screen its bytes. This plugin serves sdk.gen.ts as a list of
// re-exports, one virtual module per operation, so each operation lands with the
// screens that call it (measured on 2026-11-10: 5.9 KiB Brotli off every route).
// The operations' code is the generator's own, unchanged; only the module
// boundaries move. Build only: dev serves the file as written.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const SDK_SOURCE = resolve(scriptDirectory, "../packages/api-client/src/generated/sdk.gen.ts");

/** Virtual module id prefix of one operation. */
export const SDK_OPERATION_PREFIX = "\0scalius-sdk-operation:";

/**
 * Whether a chunk is named after an operation module (Rolldown names a chunk of
 * operations shared by several screens after its first one). vite.config.ts
 * names those files `admin-sdk-[hash].js`: every lazy import lists the files it
 * needs by name, and an operation's name is long.
 */
export const isSdkOperationChunk = (chunkName) => /^_?scalius-sdk-operation[_:]/.test(chunkName);

/**
 * Splits the generator's output (already plain JavaScript) into its imports and
 * one statement per exported operation. Anything else is a generator change this
 * split does not know, so it fails the build instead of guessing.
 * @param {string} code
 * @param {(code: string) => { body: any[] }} parse an ESTree parser (Vite's parseAst)
 */
export function splitSdkOperations(code, parse) {
  const imports = [];
  const operations = [];
  for (const node of parse(code).body) {
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type") continue;
      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier") throw new Error(`sdk.gen: unexpected import form ${specifier.type}`);
        imports.push({ local: specifier.local.name, imported: specifier.imported.name, source: node.source.value });
      }
      continue;
    }
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : null;
    if (declaration?.type === "VariableDeclaration" && declaration.declarations.length === 1 && declaration.declarations[0].id.type === "Identifier") {
      operations.push({ name: declaration.declarations[0].id.name, code: code.slice(node.start, node.end) });
      continue;
    }
    if (node.type === "ExportNamedDeclaration" && !node.declaration && node.specifiers.length === 0) continue;
    throw new Error(`sdk.gen: unexpected top-level ${node.type}; update scripts/admin-sdk-operations.mjs`);
  }
  if (operations.length === 0) throw new Error("sdk.gen: no operations found");
  return { imports, operations };
}

/** The module of one operation: its statement plus the imports it reads. */
export function operationModule(operation, imports, resolvedSource) {
  const used = imports.filter(({ local }) => new RegExp(`(?<![\\w$])${local.replace(/\$/g, "\\$")}(?![\\w$])`).test(operation.code));
  const lines = used.map(({ local, imported, source }) =>
    `import { ${imported === local ? local : `${imported} as ${local}`} } from ${JSON.stringify(resolvedSource(source))};`,
  );
  return `${lines.join("\n")}\n${operation.code}\n`;
}

/** A Vite plugin (build only): sdk.gen.ts becomes re-exports of one module per operation. */
export function adminSdkOperationsPlugin({ source = SDK_SOURCE } = {}) {
  let split;
  let root = process.cwd();
  // Module ids are real paths (a temporary or symlinked directory resolves).
  const file = realpathSync(source);
  return {
    name: "scalius-admin-sdk-operations",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    async load(id) {
      if (id.startsWith(SDK_OPERATION_PREFIX)) {
        const name = id.slice(SDK_OPERATION_PREFIX.length);
        const operation = split?.operations.find((entry) => entry.name === name);
        if (!operation) throw new Error(`sdk.gen: no operation ${name}`);
        return { code: operationModule(operation, split.imports, (specifier) => split.resolved.get(specifier)), moduleSideEffects: false };
      }
      if (id.split("?")[0] !== file) return null;
      // The dashboard's own Vite (this file lives outside the dashboard package).
      const vite = pathToFileURL(createRequire(join(root, "package.json")).resolve("vite")).href;
      const { parseAst, transformWithOxc } = await import(vite);
      const { code } = await transformWithOxc(readFileSync(file, "utf8"), file, { lang: "ts" });
      const { imports, operations } = splitSdkOperations(code, parseAst);
      const resolved = new Map();
      for (const specifier of new Set(imports.map((entry) => entry.source))) {
        const target = await this.resolve(specifier, file);
        if (!target) throw new Error(`sdk.gen: cannot resolve ${specifier}`);
        resolved.set(specifier, target.id);
      }
      split = { imports, operations, resolved };
      return operations.map(({ name }) => `export { ${name} } from ${JSON.stringify(SDK_OPERATION_PREFIX + name)};`).join("\n");
    },
    resolveId(id) {
      return id.startsWith(SDK_OPERATION_PREFIX) ? id : null;
    },
  };
}
