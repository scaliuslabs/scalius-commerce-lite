import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { prepareLiveCheckoutTargetSchema } from "../scripts/prepare-live-checkout-target";

describe("live checkout target preparation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("creates one standalone SQLite artifact for PostgreSQL migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-postgres-loadtest-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "source.sqlite");

    const result = await prepareLiveCheckoutTargetSchema("postgres", outputPath);

    expect(result).toMatchObject({
      provider: "postgres",
      journalMode: "delete",
      integrity: "ok",
      foreignKeyViolations: 0,
    });
    expect(await readdir(directory)).toEqual(["source.sqlite"]);
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      database.close();
    }
  });
});
