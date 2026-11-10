#!/usr/bin/env node
// Publish the SDK without exposing private workspace packages. Keep source
// exports in the workspace; pnpm pack replaces them with publishConfig.exports.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { CHECKOUT as root, loadEsbuild, sdkSourceDigest } from "./plugin-host.mjs";

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
  // TypeScript's own scanner finds the real import, export and import() type
  // specifiers, never words in a comment or a string that only look like one.
  const rewrite = (specifier) => {
    const resolved = ts.resolveModuleName(specifier, source, options, host).resolvedModule?.resolvedFileName;
    if (!resolved || !resolved.startsWith(`${packages}/`)) {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (!specifier.startsWith(".") && !metadata.dependencies?.[name]) throw new Error(`Undeclared SDK type dependency: ${specifier}`);
      return specifier;
    }
    declarationReferences.add(declarationPath(resolved));
    let target = relative(dirname(file), declarationPath(resolved)).replaceAll("\\", "/").replace(/\.d\.ts$/, ".js");
    if (!target.startsWith(".")) target = `./${target}`;
    return target;
  };
  let rewritten = "";
  let cursor = 0;
  for (const { fileName, pos } of ts.preProcessFile(text, true, true).importedFiles.sort((a, b) => a.pos - b.pos)) {
    // `pos` is the opening quote; the specifier follows it.
    const start = pos + 1;
    if (text.slice(start, start + fileName.length) !== fileName) throw new Error(`Could not place the import ${fileName} in ${file}`);
    rewritten += text.slice(cursor, start) + rewrite(fileName);
    cursor = start + fileName.length;
  }
  rewritten += text.slice(cursor);
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
// The SDK's own CLI, `scalius-plugin` (publishConfig.bin): the same authoring
// scripts `pnpm plugin` runs, with the SDK host in place of the checkout's,
// so an app outside any checkout validates, builds, previews, packs and
// verifies with the SDK it installed. esbuild stays a dependency, never in an app's bundle.
await esbuild.build({
  entryPoints: [join(root, "scripts/plugin-sdk-cli.mjs")],
  outfile: join(dist, "cli.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  // The SDK's dependencies, installed beside it.
  external: Object.keys(metadata.dependencies),
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "eof",
  logLevel: "warning",
  plugins: [{
    name: "sdk-host",
    setup(build) {
      build.onResolve({ filter: /\/plugin-host\.mjs$/ }, () => ({ path: join(root, "scripts/plugin-host.sdk.mjs") }));
    },
  }],
});
chmodSync(join(dist, "cli.js"), 0o755);
// The theme starter's templates, where the bundled scaffold reads them (beside cli.js).
cpSync(join(root, "scripts/plugin-scaffold/theme"), join(dist, "plugin-scaffold/theme"), { recursive: true });
const cli = spawnSync(process.execPath, [join(dist, "cli.js"), "--version"], { encoding: "utf8" });
if (cli.status !== 0 || cli.stdout.trim() !== metadata.version) throw new Error(`The SDK's CLI does not start: ${cli.stderr || cli.stdout}`);
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
