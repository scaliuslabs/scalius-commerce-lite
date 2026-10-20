/**
 * Vitest global setup: build every migrated D1/Turso image the suite asks
 * for once, before the test processes start, so no test file pays for the
 * migrations inside its first test's time limit and no two workers build the
 * same image at once. The images live in a machine-wide, content-addressed
 * cache (`migratedImageCacheDirectory()`), so a fresh agent worktree starts
 * warm. The `beforeMigration` cut-offs are read from the test sources; a
 * cut-off this scan cannot see (a computed string) is still built lazily by
 * the first test that needs it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prebuildMigratedImages, pruneMigratedImageCache, type MigratedImageTarget } from "./sqlite-d1";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".astro", ".turbo", ".wrangler", ".git"]);
const TEST_FILE = /\.test\.(?:c|m)?[jt]sx?$/;
const CUT_OFF = /beforeMigration\s*:\s*["'`](\d{4}_[^"'`$]*)["'`]/g;
const TURSO = /provider\s*:\s*["']turso["']/;

function testFiles(directory: string, found: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) testFiles(join(directory, entry.name), found);
    } else if (TEST_FILE.test(entry.name)) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

/** The images the test sources request: the full D1 chain, every literal cut-off, and the full Turso chain when a test asks for it. */
export function requestedImages(roots = ["apps", "packages", "scripts"].map((name) => join(repoRoot, name))): MigratedImageTarget[] {
  const targets: MigratedImageTarget[] = [{ provider: "d1" }];
  let turso = false;
  for (const file of roots.flatMap((root) => testFiles(root))) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("beforeMigration") && !source.includes("turso")) continue;
    for (const match of source.matchAll(CUT_OFF)) targets.push({ provider: "d1", beforeMigration: match[1] });
    turso ||= TURSO.test(source);
  }
  if (turso) targets.push({ provider: "turso" });
  return targets;
}

export default function setup(): void {
  pruneMigratedImageCache();
  const started = Date.now();
  const { built } = prebuildMigratedImages(requestedImages());
  if (built > 0) console.log(`Built ${built} migrated test image(s) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}
