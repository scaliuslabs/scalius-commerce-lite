import { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHeroSlider,
  deleteHeroSlider,
  getHeroSlider,
  updateHeroSlider,
} from "./hero-sliders.service";

describe("hero slider revision authority", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE hero_sliders (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        images TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE UNIQUE INDEX hero_sliders_active_type_unique
        ON hero_sliders (type) WHERE deleted_at IS NULL;
    `);
    db = drizzle(async (query, params, method) => {
      const statement = sqlite.prepare(query);
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
  });

  afterEach(() => sqlite.close());

  it("creates an inactive draft and advances revision once per explicit save", async () => {
    const created = await createHeroSlider(db, {
      type: "desktop",
      images: [],
      isActive: false,
    });
    expect(created).toMatchObject({ type: "desktop", revision: 1, isActive: false });

    const updated = await updateHeroSlider(db, created.id, {
      expectedRevision: 1,
      images: [{
        id: "img_1",
        url: "https://cdn.example.com/hero.jpg",
        title: "  New arrivals  ",
        link: "#",
        focalPoint: { x: 26.125, y: 72.875 },
      }],
      isActive: true,
    });
    expect(updated).toMatchObject({
      revision: 2,
      isActive: true,
      images: [{
        title: "New arrivals",
        link: "",
        focalPoint: { x: 26.13, y: 72.88 },
      }],
    });

    await expect(updateHeroSlider(db, created.id, {
      expectedRevision: 1,
      isActive: false,
    })).rejects.toMatchObject({
      code: "HERO_SLIDER_REVISION_CONFLICT",
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect((await getHeroSlider(db, created.id)).revision).toBe(2);
  });

  it("requires content before activation and one current slider per viewport", async () => {
    await expect(createHeroSlider(db, {
      type: "mobile",
      images: [],
      isActive: true,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await createHeroSlider(db, { type: "mobile", images: [], isActive: false });
    await expect(createHeroSlider(db, {
      type: "mobile",
      images: [],
      isActive: false,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("soft-deletes only the claimed revision", async () => {
    const created = await createHeroSlider(db, {
      type: "desktop",
      images: [],
      isActive: false,
    });
    const deleted = await deleteHeroSlider(db, created.id, 1);
    expect(deleted).toMatchObject({ revision: 2, isActive: false });
    expect(deleted.deletedAt).not.toBeNull();
    await expect(deleteHeroSlider(db, created.id, 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
