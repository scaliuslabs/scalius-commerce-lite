import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

// Before the harness loads: this file's images go to a private cache.
const cache = mkdtempSync(join(tmpdir(), "scalius-image-prebuild-"));
process.env.SCALIUS_TEST_IMAGE_CACHE = cache;
const { compiledMigrationSql, createMigratedSqlite, migratedImageCacheDirectory, prebuildMigratedImages } =
  await import("../src/testing/sqlite-d1");
const { requestedImages } = await import("../src/testing/migrated-image-setup");

afterAll(() => rmSync(cache, { recursive: true, force: true }));

function tables(sqlite: DatabaseSync): unknown[] {
  return sqlite.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
}

describe("migrated image prebuild", () => {
  it("snapshots each cut-off on one pass, under the digest a test process looks up", () => {
    expect(migratedImageCacheDirectory()).toBe(cache);
    // Two spellings of one cut-off share an image.
    const first = prebuildMigratedImages([{ beforeMigration: "0005_" }, { beforeMigration: "0012_" }, { beforeMigration: "0012_light_bedlam.sql" }]);
    expect(first).toEqual({ built: 2, cached: 0 });
    expect(readdirSync(cache).filter((name) => name.endsWith(".sqlite"))).toHaveLength(2);
    expect(prebuildMigratedImages([{ beforeMigration: "0012_" }])).toEqual({ built: 0, cached: 1 });

    for (const beforeMigration of ["0005_", "0012_"]) {
      const replayed = new DatabaseSync(":memory:");
      replayed.exec(compiledMigrationSql("d1", beforeMigration));
      const restored = createMigratedSqlite({ beforeMigration });
      expect(tables(restored)).toEqual(tables(replayed));
      restored.close();
      replayed.close();
    }
    // The test process found the prebuilt files instead of writing its own.
    expect(readdirSync(cache).filter((name) => name.endsWith(".sqlite"))).toHaveLength(2);
  });

  it("finds the literal cut-offs the suite asks for", () => {
    const targets = requestedImages();
    expect(targets).toContainEqual({ provider: "d1" });
    expect(targets).toContainEqual({ provider: "d1", beforeMigration: "0104_" });
    expect(targets).toContainEqual({ provider: "turso" });
  });
});
