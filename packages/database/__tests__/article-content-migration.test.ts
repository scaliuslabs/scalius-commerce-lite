import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0043_grey_the_spike.sql"),
  "utf8",
);

describe("article content migration", () => {
  it("extends pages additively so the existing pages FTS table and triggers survive", () => {
    expect(migration).toContain("ADD COLUMN `content_type`");
    expect(migration).toContain("ADD COLUMN `excerpt`");
    expect(migration).toContain("ADD COLUMN `author`");
    expect(migration).toContain("ADD COLUMN `tags`");
    expect(migration).not.toMatch(
      /DROP TABLE|__new_pages|DROP TRIGGER|pages_fts/i,
    );
  });

  it("keeps static pages free of article-only metadata", () => {
    expect(migration).toContain(
      "`content_type` = 'article' OR `excerpt` IS NULL",
    );
    expect(migration).toContain(
      "`content_type` = 'article' OR `author` IS NULL",
    );
    expect(migration).toContain(
      "`content_type` = 'article' OR json_array_length(`tags`) = 0",
    );
  });
});
