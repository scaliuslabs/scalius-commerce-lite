// The dashboard build's chunk graph, written by the build itself so
// scripts/admin-perf-check.mjs does not have to build the dashboard again.
//
// `adminChunkGraphPlugin()` (apps/admin-v2/vite.config.ts) records, after each
// write, every chunk's imports and modules, the SHA-256 of every emitted chunk,
// stylesheet and `index.html`, in the Vite cache directory (never in `dist/`,
// which is served: the graph holds local source paths). `readBuiltChunkGraph`
// returns it only when `dist/` is exactly that build: the JavaScript and CSS under
// `dist/assets` are the recorded set (a restore that overlays an older build, or
// leaves files of another one, adds names) and every recorded file and `index.html`
// still has its recorded bytes. Anything else reads as "no graph" and the caller
// builds as before.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** The build's Vite cache directory, relative to the dashboard root (`cacheDir` in vite.config.ts). */
export const ADMIN_BUILD_CACHE_DIR = "node_modules/.vite-build";

const GRAPH_FILE = /^scalius-chunk-graph-[0-9a-f]{16}\.json$/;

export const sha256 = (content) => createHash("sha256").update(content).digest("hex");

/** Where the graph of the build written to `outDir` lives: one file per output directory. */
export function chunkGraphPath(adminDir, outDir) {
  return join(adminDir, ADMIN_BUILD_CACHE_DIR, `scalius-chunk-graph-${sha256(resolve(outDir)).slice(0, 16)}.json`);
}

const bytesOf = (item) => Buffer.from(item.type === "chunk" ? item.code : item.source);

/** The graph of one finished bundle (Rollup/Rolldown `bundle` object). */
export function chunkGraphOf(bundle, outDir) {
  const items = Object.values(bundle);
  const index = items.find((item) => item.type === "asset" && item.fileName === "index.html");
  return {
    version: 2,
    outDir: resolve(outDir),
    indexHtml: index ? sha256(bytesOf(index)) : null,
    chunks: items
      .filter((item) => item.type === "chunk")
      .map((chunk) => ({
        fileName: chunk.fileName,
        isEntry: chunk.isEntry,
        imports: chunk.imports,
        moduleIds: chunk.moduleIds ?? Object.keys(chunk.modules),
        sha256: sha256(bytesOf(chunk)),
      })),
    cssFiles: items
      .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
      .map((item) => ({ fileName: item.fileName, sha256: sha256(bytesOf(item)) })),
  };
}

/** The `outDir` a graph file records, read from its first bytes (it is written first). */
function recordedOutDir(file) {
  let descriptor;
  try {
    descriptor = openSync(file, "r");
    const head = Buffer.alloc(1024);
    const length = readSync(descriptor, head, 0, head.length, 0);
    const match = head.toString("utf8", 0, length).match(/"outDir":("(?:[^"\\]|\\.)*")/);
    return match ? JSON.parse(match[1]) : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Removes the graphs of builds whose output directory is gone (the canary builds and the
 * perf gate's own build write to temporary directories), keeping `keep`.
 */
export function pruneChunkGraphs(adminDir, keep) {
  const directory = join(adminDir, ADMIN_BUILD_CACHE_DIR);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    if (!GRAPH_FILE.test(name) || file === keep) continue;
    const outDir = recordedOutDir(file);
    if (outDir === undefined || !existsSync(outDir)) rmSync(file, { force: true });
  }
}

/** A Vite plugin: writes the finished build's graph to the build cache. */
export function adminChunkGraphPlugin() {
  let root = process.cwd();
  return {
    name: "scalius-admin-chunk-graph",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    writeBundle(options, bundle) {
      const outDir = options.dir ?? resolve(root, "dist");
      const file = chunkGraphPath(root, outDir);
      mkdirSync(join(root, ADMIN_BUILD_CACHE_DIR), { recursive: true });
      writeFileSync(file, `${JSON.stringify(chunkGraphOf(bundle, outDir))}\n`);
      pruneChunkGraphs(root, file);
    },
  };
}

/** The JavaScript and CSS files under `outDir/assets`, as paths relative to `outDir`. */
function builtAssetFiles(outDir) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:[cm]?js|css)$/.test(entry.name)) found.push(relative(outDir, path).split(sep).join("/"));
    }
  };
  if (existsSync(join(outDir, "assets"))) walk(join(outDir, "assets"));
  return found.sort();
}

/**
 * The graph of the dashboard build in `outDir`, or undefined when there is none or
 * `outDir` is not exactly the build it describes.
 * @returns {{ chunks: object[], cssFiles: string[], outDir: string } | undefined}
 */
export function readBuiltChunkGraph(adminDir, outDir) {
  const file = chunkGraphPath(adminDir, outDir);
  if (!existsSync(file)) return undefined;
  try {
    const graph = JSON.parse(readFileSync(file, "utf8"));
    if (graph.version !== 2 || graph.outDir !== resolve(outDir) || !Array.isArray(graph.chunks) || graph.chunks.length === 0) return undefined;
    const recorded = [...graph.chunks, ...graph.cssFiles];
    const present = builtAssetFiles(outDir);
    const expected = recorded.map((entry) => entry.fileName).filter((name) => name.startsWith("assets/")).sort();
    if (present.length !== expected.length || present.some((name, position) => name !== expected[position])) return undefined;
    if (graph.indexHtml !== null) {
      const index = join(outDir, "index.html");
      if (!existsSync(index) || sha256(readFileSync(index)) !== graph.indexHtml) return undefined;
    }
    for (const entry of recorded) {
      const path = join(outDir, entry.fileName);
      if (!existsSync(path) || sha256(readFileSync(path)) !== entry.sha256) return undefined;
    }
    return {
      outDir: graph.outDir,
      chunks: graph.chunks.map(({ sha256: _hash, ...chunk }) => chunk),
      cssFiles: graph.cssFiles.map((entry) => entry.fileName),
    };
  } catch {
    return undefined;
  }
}
