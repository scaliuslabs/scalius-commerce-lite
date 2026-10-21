import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// Before the harness loads: this file's images go to a private cache.
const cache = mkdtempSync(join(tmpdir(), "scalius-provider-replay-"));
process.env.SCALIUS_TEST_IMAGE_CACHE = cache;
const { createProviderSchemaDatabase } = await import("../scripts/sqlite-provider-schema");

afterAll(() => rmSync(cache, { recursive: true, force: true }));

const images = () => readdirSync(cache).filter((name) => name.endsWith(".sqlite"));

describe("createProviderSchemaDatabase", () => {
  it("replays the chain for a production tool, so seeded timestamps are real", async () => {
    const replayed = await createProviderSchemaDatabase("d1", ":memory:", "0012_", { replay: true });
    replayed.close();
    expect(images()).toHaveLength(0);
  });

  it("restores the cached image by default under test", async () => {
    const restored = await createProviderSchemaDatabase("d1", ":memory:", "0012_");
    restored.close();
    expect(images()).toHaveLength(1);
  });
});
