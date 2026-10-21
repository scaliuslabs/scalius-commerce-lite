/**
 * Test and tooling helper: the numbered migrations applied to an empty
 * node:sqlite database, cached as a serialized image. Applying the chain takes
 * seconds (each DDL statement re-reads a schema of thousands of triggers), so
 * every database built from it (the test harness in `sqlite-d1.ts`, the
 * provider schema in `scripts/sqlite-provider-schema.ts`) restores one image
 * instead. Never import this from Worker code.
 */
import { createHash, type Hash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { compileSqliteMigrationForProvider } from "../migration-artifacts";
import type { DatabaseProvider } from "../provider";

type SqliteProvider = DatabaseProvider;

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
/**
 * Migrated images shared by test processes, keyed by the digest of the script
 * that built them. The key is content-addressed, so one machine-wide directory
 * serves every checkout and agent worktree: a new worktree starts warm.
 * `SCALIUS_TEST_IMAGE_CACHE` overrides it; the checkout's node_modules/.cache
 * is the fallback when the user cache cannot be written.
 */
const localImageCacheDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.cache/scalius-migrated-sqlite");
let imageCacheDirectoryPath: string | undefined;

export function migratedImageCacheDirectory(): string {
  if (imageCacheDirectoryPath) return imageCacheDirectoryPath;
  const userCacheRoot = process.platform === "darwin"
    ? join(homedir(), "Library", "Caches")
    : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const userCache = process.env.SCALIUS_TEST_IMAGE_CACHE || join(userCacheRoot, "scalius-migrated-sqlite");
  try {
    mkdirSync(userCache, { recursive: true });
    imageCacheDirectoryPath = userCache;
  } catch {
    imageCacheDirectoryPath = localImageCacheDirectory;
  }
  return imageCacheDirectoryPath;
}
const compiledMigrations = new Map<string, string>();
const migratedImages = new Map<string, Uint8Array>();

/** node:sqlite serialize/deserialize (Node 24.x); older typings omit them. */
type SerializableSqlite = DatabaseSync & {
  serialize?: () => Uint8Array;
  deserialize?: (image: Uint8Array) => void;
};

/**
 * Numbered migrations compiled for the provider as one script (cached per
 * process). `beforeMigration` stops before that file and `fromMigration`
 * starts at one, so upgrade tests can seed old rows between the two.
 */
export function compiledMigrationSql(
  provider: SqliteProvider = "d1",
  beforeMigration?: string,
  fromMigration?: string,
): string {
  const cacheKey = `${provider}:${beforeMigration ?? ""}:${fromMigration ?? ""}`;
  const cached = compiledMigrations.get(cacheKey);
  if (cached !== undefined) return cached;
  const sql = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .filter((name) => beforeMigration === undefined || name < beforeMigration)
    .filter((name) => fromMigration === undefined || name >= fromMigration)
    .sort()
    .map((name) => compileSqliteMigrationForProvider(
      readFileSync(`${migrationDirectory}/${name}`, "utf8"),
      provider,
    ))
    .join("\n");
  compiledMigrations.set(cacheKey, sql);
  return sql;
}

/**
 * Applying every migration takes seconds (each DDL statement re-reads a
 * schema of thousands of triggers), so test files would each pay it in their
 * first test. The image is the same for the same script: a process reuses the
 * image another one built. A changed migration changes the digest.
 */
function imageFile(provider: SqliteProvider, beforeMigration: string | undefined): string {
  const digest = createHash("sha256")
    .update(`${process.version}\n${compiledMigrationSql(provider, beforeMigration)}`)
    .digest("hex");
  return imageFileForDigest(digest);
}

function imageFileForDigest(digest: string): string {
  return join(migratedImageCacheDirectory(), `${digest}.sqlite`);
}

function readImageFile(provider: SqliteProvider, beforeMigration: string | undefined): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(imageFile(provider, beforeMigration)));
  } catch {
    return undefined;
  }
}

function writeImageFile(provider: SqliteProvider, beforeMigration: string | undefined, image: Uint8Array): void {
  writeImageFileAt(imageFile(provider, beforeMigration), image);
}

function writeImageFileAt(file: string, image: Uint8Array): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write then rename: a process reading at the same time sees the whole image or none.
    const partial = `${file}.${process.pid}.${Date.now()}.partial`;
    writeFileSync(partial, image);
    renameSync(partial, file);
  } catch {
    // A read-only checkout still works: each process builds its own image.
  }
}

function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export interface MigratedImageTarget {
  provider?: SqliteProvider;
  beforeMigration?: string;
}

/**
 * Builds every image the tests will ask for in one pass per provider: the
 * migrations are applied in order once and the database is snapshotted at
 * each `beforeMigration` cut-off on the way, instead of each cut-off
 * replaying its own prefix in whichever test process asks first (several at
 * once, inside a test's time limit). Images already cached are touched, so
 * the prune keeps them, and skipped. A digest here equals `imageFile()`'s:
 * the same compiled files, joined the same way.
 */
export function prebuildMigratedImages(targets: readonly MigratedImageTarget[]): { built: number; cached: number } {
  let built = 0;
  let cached = 0;
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const provider of new Set(targets.map((target) => target.provider ?? "d1"))) {
    // "￿" sorts after every file name: no cut-off is the whole chain.
    const cutOffs = [...new Set(targets
      .filter((target) => (target.provider ?? "d1") === provider)
      .map((target) => target.beforeMigration ?? "\uffff"))].sort();
    const compiled = files.map((name) => compileSqliteMigrationForProvider(readFileSync(join(migrationDirectory, name), "utf8"), provider));
    // One running hash over the joined script; a copy at each cut-off is that prefix's digest.
    const hash: Hash = createHash("sha256").update(`${process.version}\n`);
    const plan: Array<{ applied: number; file: string }> = [];
    let next = 0;
    for (let index = 0; index <= files.length; index += 1) {
      while (next < cutOffs.length && (index === files.length || files[index]! >= cutOffs[next]!)) {
        const file = imageFileForDigest(hash.copy().digest("hex"));
        if (!plan.some((step) => step.file === file)) plan.push({ applied: index, file });
        next += 1;
      }
      if (index < files.length) hash.update(index === 0 ? compiled[index]! : `\n${compiled[index]!}`);
    }
    const missing = plan.filter((step) => {
      if (!fileExists(step.file)) return true;
      const now = new Date();
      try {
        utimesSync(step.file, now, now);
      } catch {
        // Touching only protects the image from the prune.
      }
      cached += 1;
      return false;
    });
    if (missing.length === 0) continue;
    const sqlite: SerializableSqlite = new DatabaseSync(":memory:");
    try {
      if (!sqlite.serialize) continue;
      let applied = 0;
      for (const step of missing) {
        for (; applied < step.applied; applied += 1) sqlite.exec(compiled[applied]!);
        writeImageFileAt(step.file, sqlite.serialize());
        built += 1;
      }
    } finally {
      sqlite.close();
    }
  }
  return { built, cached };
}

/**
 * Removes images and Turso engine store templates (turso-engine.ts) unused
 * for `maxAgeDays`, and abandoned partial writes, from the shared cache.
 */
export function pruneMigratedImageCache(maxAgeDays = 14): number {
  const directory = migratedImageCacheDirectory();
  const now = Date.now();
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = join(directory, name);
    try {
      const age = now - statSync(file).mtimeMs;
      const abandoned = name.endsWith(".partial") || name.includes(".building-");
      const unused = name.endsWith(".sqlite") || /^turso-engine-[0-9a-f]+$/.test(name);
      if (abandoned ? age > 3_600_000 : unused && age > maxAgeDays * 86_400_000) {
        rmSync(file, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Another process removed or renamed it.
    }
  }
  return removed;
}

/**
 * The serialized database the provider's migrations (before `beforeMigration`)
 * build, from this process's memo, the shared cache, or one replay that then
 * fills both. Each caller restores a copy (`deserialize` copies the bytes).
 * Undefined when this Node's node:sqlite cannot serialize: the caller replays.
 */
export function migratedImage(provider: SqliteProvider = "d1", beforeMigration?: string): Uint8Array | undefined {
  const imageKey = `${provider}:${beforeMigration ?? ""}`;
  const memo = migratedImages.get(imageKey);
  if (memo) return memo;
  const sqlite: SerializableSqlite = new DatabaseSync(":memory:");
  try {
    if (!sqlite.serialize || !sqlite.deserialize) return undefined;
    let image = readImageFile(provider, beforeMigration);
    if (!image) {
      sqlite.exec(compiledMigrationSql(provider, beforeMigration));
      image = sqlite.serialize();
      writeImageFile(provider, beforeMigration, image);
    }
    migratedImages.set(imageKey, image);
    return image;
  } finally {
    sqlite.close();
  }
}

/** Replaces `sqlite`'s (empty) main database with a copy of `image`. */
export function restoreMigratedImage(sqlite: DatabaseSync, image: Uint8Array): void {
  (sqlite as SerializableSqlite).deserialize!(image);
}
