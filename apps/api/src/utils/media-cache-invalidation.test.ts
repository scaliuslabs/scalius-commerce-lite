import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidateCatalogCaches: vi.fn(),
  invalidateProductAvailabilityCacheSubjects: vi.fn(),
}));

vi.mock("./cache-invalidation", async () => {
  const actual = await vi.importActual<typeof import("./cache-invalidation")>(
    "./cache-invalidation",
  );
  return {
    ...actual,
    invalidateCatalogCaches: mocks.invalidateCatalogCaches,
    invalidateProductAvailabilityCacheSubjects:
      mocks.invalidateProductAvailabilityCacheSubjects,
  };
});

import { invalidateMediaDependentProductCaches } from "./media-cache-invalidation";

describe("media dependent product cache invalidation", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
    vi.clearAllMocks();
  });

  function createDatabase(execute?: () => never) {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        poster_media_id TEXT
      );
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        category_id TEXT
      );
      CREATE TABLE product_media (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        media_id TEXT NOT NULL
      );
    `);

    return drizzle(async (query, params, method) => {
      execute?.();
      const statement = sqlite!.prepare(query);
      statement.setReturnArrays(true);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        return { rows: statement.get(...params) as unknown as unknown[] };
      }
      return { rows: statement.all(...params) as unknown as unknown[][] };
    }) as unknown as Database;
  }

  it("invalidates every high-reuse product in sequential exact-path pages", async () => {
    const db = createDatabase();
    sqlite!.exec("INSERT INTO media VALUES ('media_shared', 'image', NULL)");
    const insertProduct = sqlite!.prepare(
      "INSERT INTO products (id, slug, category_id) VALUES (?, ?, NULL)",
    );
    const insertAssociation = sqlite!.prepare(
      "INSERT INTO product_media (id, product_id, media_id) VALUES (?, ?, 'media_shared')",
    );
    for (let index = 0; index < 25; index += 1) {
      const suffix = String(index).padStart(3, "0");
      insertProduct.run(`prod_${suffix}`, `product-${suffix}`);
      insertAssociation.run(`pmed_${suffix}`, `prod_${suffix}`);
    }
    const context = { env: {} as Env };

    await invalidateMediaDependentProductCaches(db, "media_shared", context);

    expect(mocks.invalidateProductAvailabilityCacheSubjects).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateProductAvailabilityCacheSubjects.mock.calls[0]?.[0]).toHaveLength(20);
    expect(mocks.invalidateProductAvailabilityCacheSubjects.mock.calls[1]?.[0]).toHaveLength(5);
    expect(mocks.invalidateProductAvailabilityCacheSubjects).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        expect.objectContaining({ productId: "prod_000" }),
        expect.objectContaining({ productId: "prod_019" }),
      ]),
      context,
      db,
    );
    expect(mocks.invalidateProductAvailabilityCacheSubjects).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        expect.objectContaining({ productId: "prod_020" }),
        expect.objectContaining({ productId: "prod_024" }),
      ]),
      context,
      db,
    );
    expect(mocks.invalidateCatalogCaches).not.toHaveBeenCalled();
  });

  it("falls back to broad catalog invalidation when dependency resolution fails", async () => {
    const db = createDatabase(() => {
      throw new Error("D1 unavailable");
    });
    const context = { env: {} as Env };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      invalidateMediaDependentProductCaches(db, "media_changed", context),
    ).resolves.toBeUndefined();

    expect(mocks.invalidateProductAvailabilityCacheSubjects).not.toHaveBeenCalled();
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith("products", context);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("falling back to catalog invalidation"),
      expect.any(Error),
    );
  });
});
