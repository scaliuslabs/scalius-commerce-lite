import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every module a Wrangler `--outdir` build uploads, main first, for Miniflare:
 * the bundle and its Text modules (generated *.txt and the places dataset,
 * which workerd does not compile at isolate start).
 */
export function workerdModules(dist: string, main: string): Array<{ type: "ESModule" | "Text"; path: string }> {
  const uploaded = readdirSync(dist).filter((file) => /\.(?:js|txt|json)$/.test(file) && file !== main);
  return [main, ...uploaded].map((file) => ({ type: file.endsWith(".js") ? "ESModule" : "Text", path: join(dist, file) }));
}
