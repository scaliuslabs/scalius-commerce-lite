/**
 * Reads a fixture file (tests only). `node:fs` is loaded by a runtime
 * specifier so the Workers typecheck of this package needs no Node types.
 */
export async function readFixture(name: string): Promise<string> {
  const specifier = "node:fs/promises";
  const fs = (await import(/* @vite-ignore */ specifier)) as { readFile(path: URL, encoding: "utf8"): Promise<string> };
  return fs.readFile(new URL(`./${name}`, import.meta.url), "utf8");
}
