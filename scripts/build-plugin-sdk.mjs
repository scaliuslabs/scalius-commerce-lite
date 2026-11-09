#!/usr/bin/env node
// Publish the SDK without exposing private workspace packages. Keep source
// exports in the workspace; pnpm pack replaces them with publishConfig.exports.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadEsbuild, root, sdkSourceDigest } from "./plugin-build.mjs";

const directory = join(root, "packages/plugin-sdk");
const packages = join(root, "packages");
const finalDist = join(directory, "dist");
// Built beside dist/ and swapped in whole: two packs at once (two apps
// scaffolded in parallel) never see a dist/ the other one is deleting.
const dist = join(directory, `.dist-build-${process.pid}`);
const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
const entries = Object.values(metadata.exports).map((entry) => resolve(directory, entry));
const options = {
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  declaration: true,
  emitDeclarationOnly: true,
  noEmitOnError: true,
  rootDir: packages,
  outDir: join(dist, "types"),
  types: [],
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
};
const host = ts.createCompilerHost(options);
const graph = ts.createProgram(entries, options, host);
// TypeScript does not emit workspace packages reached through node_modules
// unless their source files are roots, even though their declarations are public.
const sources = graph.getSourceFiles().filter((file) => !file.isDeclarationFile && file.fileName.startsWith(`${packages}/`)).map((file) => file.fileName);
const program = ts.createProgram(sources, options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
process.on("exit", () => rmSync(dist, { recursive: true, force: true }));
function declarationPath(source) {
  return join(options.outDir, relative(packages, source)).replace(/\.[cm]?tsx?$/, ".d.ts");
}
const declarationReferences = new Set();
const emitted = program.emit(undefined, (file, text, _bom, _onError, sources) => {
  const source = sources?.[0]?.fileName;
  if (!source) throw new Error(`No source for ${file}`);
  // Resolve imports while the source workspace still exists, then make every
  // private declaration reference relative to its copied declaration.
  const rewritten = text.replace(/((?:from\s+|import\s*\(\s*|import\s+)["'])([^"']+)(["'])/g, (match, before, specifier, after) => {
    const resolved = ts.resolveModuleName(specifier, source, options, host).resolvedModule?.resolvedFileName;
    if (!resolved || !resolved.startsWith(`${packages}/`)) {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (!specifier.startsWith(".") && !metadata.dependencies?.[name]) throw new Error(`Undeclared SDK type dependency: ${specifier}`);
      return match;
    }
    declarationReferences.add(declarationPath(resolved));
    let target = relative(dirname(file), declarationPath(resolved)).replaceAll("\\", "/").replace(/\.d\.ts$/, ".js");
    if (!target.startsWith(".")) target = `./${target}`;
    return `${before}${target}${after}`;
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rewritten);
});
if (emitted.emitSkipped) throw new Error("SDK declarations were not emitted.");
for (const file of declarationReferences) {
  if (!existsSync(file)) throw new Error(`SDK declaration is missing: ${file}`);
}

const esbuild = await loadEsbuild();
await esbuild.build({
  entryPoints: entries,
  outbase: join(directory, "src"),
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "import"],
  target: "es2022",
  legalComments: "eof",
  logLevel: "warning",
});
const staged = (path) => resolve(dist, relative("dist", path));
for (const entry of Object.values(metadata.publishConfig.exports)) {
  if (!existsSync(staged(entry.types))) throw new Error(`Missing published types: ${entry.types}`);
  await import(pathToFileURL(staged(entry.import)).href);
}
copyFileSync(join(root, "LICENSE"), join(directory, "LICENSE"));
// Which sources this build is: `pnpm plugin validate` warns when an app's installed build differs from the checkout's.
writeFileSync(join(dist, "build.json"), `${JSON.stringify({ name: metadata.name, version: metadata.version, sourceDigest: sdkSourceDigest() }, null, 2)}\n`);
const previous = join(directory, `.dist-old-${process.pid}`);
if (existsSync(finalDist)) renameSync(finalDist, previous);
try {
  renameSync(dist, finalDist);
} catch {
  // Another build swapped its own in meanwhile: the same sources, replace it.
  rmSync(finalDist, { recursive: true, force: true });
  renameSync(dist, finalDist);
}
rmSync(previous, { recursive: true, force: true });
console.log(`Built ${metadata.name}@${metadata.version}: ${entries.length} ESM entries with portable declarations.`);
