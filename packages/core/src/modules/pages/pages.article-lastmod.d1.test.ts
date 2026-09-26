// An article's public payload keeps `updatedAt` (the blog's dateModified).
// `pages.updated_at` is noise to the cache registry except through the
// lastmod rule, so it may move only with a buyer-visible change: a save that
// changes nothing leaves it and the article's keys alone, and a real edit
// moves both (truthfulUpdatedAt in pages.service.ts).
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { updatePage } from "./pages.service";

const STALE_UPDATED_AT = 1_700_000_000;

describe("article updated_at and cache keys", () => {
  let sqlite: DatabaseSync | null = null;
  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("moves updated_at and the article's key only on a real edit", async () => {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    sqlite.exec(`
      INSERT INTO pages (id, content_type, title, slug, content, is_published, revision, updated_at)
      VALUES ('article_one', 'article', 'Eid care', 'eid-care', '<p>x</p>', 1, 1, ${STALE_UPDATED_AT});
    `);
    const state = () => ({
      updatedAt: (sqlite!.prepare("SELECT updated_at AS v FROM pages WHERE id = 'article_one'").get() as { v: number }).v,
      seq: (sqlite!.prepare("SELECT seq AS v FROM cache_dep WHERE dep = 'pg:article_one'").get() as { v: number } | undefined)?.v ?? 0,
    });
    const before = state();

    await updatePage(harness.db, "article_one", { expectedRevision: 1, title: "Eid care" } as never);
    expect(state()).toEqual(before);
    expect(before.updatedAt).toBe(STALE_UPDATED_AT);

    await updatePage(harness.db, "article_one", { expectedRevision: 2, title: "Eid garment care" } as never);
    const after = state();
    expect(after.updatedAt).toBeGreaterThan(STALE_UPDATED_AT);
    expect(after.seq).toBeGreaterThan(before.seq);
  });
});
