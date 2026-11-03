// The dashboard build's chunk graph, written by the build itself so
// scripts/admin-perf-check.mjs does not have to build the dashboard again.
//
// `adminChunkGraphPlugin()` (apps/admin-v2/vite.config.ts) records, after each
// write, every chunk's imports and modules and the SHA-256 of every emitted
// chunk and stylesheet, in the Vite cache directory (never in `dist/`, which is
// served: the graph holds local source paths). `readBuiltChunkGraph` returns it
// only when `dist/` still holds exactly those bytes, so a graph that belongs to
// another build, an edited `dist/` or a cache restored without it all read as
// "no graph" and the caller builds as before.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The build's Vite cache directory, relative to the dashboard root (`cacheDir` in vite.config.ts). */
export const ADMIN_BUILD_CACHE_DIR = "node_modules/.vite-build";

export const sha256 = (content) => createHash("sha256").update(content).digest("hex");

/** Where the graph of the build written to `outDir` lives: one file per output directory. */
export function chunkGraphPath(adminDir, outDir) {
  return join(adminDir, ADMIN_BUILD_CACHE_DIR, `scalius-chunk-graph-${sha256(resolve(outDir)).slice(0, 16)}.json`);
}

const bytesOf = (item) => Buffer.from(item.type === "chunk" ? item.code : item.source);

/** The graph of one finished bundle (Rollup/Rolldown `bundle` object). */
export function chunkGraphOf(bundle, outDir) {
  const items = Object.values(bundle);
  return {
    version: 1,
    outDir: resolve(outDir),
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
    },
  };
}

/**
 * The graph of the dashboard build in `outDir`, or undefined when there is none
 * or `outDir` does not hold exactly the bytes it describes.
 * @returns {{ chunks: object[], cssFiles: string[], outDir: string } | undefined}
 */
export function readBuiltChunkGraph(adminDir, outDir) {
  const file = chunkGraphPath(adminDir, outDir);
  if (!existsSync(file)) return undefined;
  try {
    const graph = JSON.parse(readFileSync(file, "utf8"));
    if (graph.version !== 1 || graph.outDir !== resolve(outDir) || !Array.isArray(graph.chunks) || graph.chunks.length === 0) return undefined;
    for (const entry of [...graph.chunks, ...graph.cssFiles]) {
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
