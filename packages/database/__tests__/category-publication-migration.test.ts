import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0016_simple_phil_sheldon.sql"),
  "utf8",
);

const oldSchema = `
  CREATE TABLE categories (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    image_url text,
    meta_title text,
    meta_description text,
    canonical_path text,
    no_index integer DEFAULT false NOT NULL,
    exclude_from_sitemap integer DEFAULT false NOT NULL,
    created_at integer NOT NULL,
    updated_at integer NOT NULL,
    deleted_at integer
  );
  CREATE VIRTUAL TABLE categories_fts USING fts5(
    name,
    description,
    content='categories',
    content_rowid='rowid'
  );
  CREATE TRIGGER categories_fts_after_insert AFTER INSERT ON categories BEGIN
    INSERT INTO categories_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
  END;
  CREATE TRIGGER categories_fts_after_update AFTER UPDATE ON categories BEGIN
    INSERT INTO categories_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
  END;
  CREATE TRIGGER categories_fts_before_delete BEFORE DELETE ON categories BEGIN
    INSERT INTO categories_fts(categories_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
  END;
  CREATE TRIGGER categories_fts_before_update BEFORE UPDATE ON categories BEGIN
    INSERT INTO categories_fts(categories_fts, rowid, name, description) VALUES('delete', old.rowid, old.name, old.description);
  END;
`;

describe("category publication migration", () => {
  it("preserves existing public demo truth, seeds revisions, and rebuilds FTS", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${oldSchema}
        INSERT INTO categories VALUES ('cat_1', 'Summer Drinks', 'summer-drinks', 'Cold drinks', NULL, NULL, NULL, NULL, 0, 0, 100, 200, NULL);
        ${migration}
        SELECT id, status, revision, created_at, updated_at FROM categories;
        SELECT name FROM categories WHERE rowid IN (SELECT rowid FROM categories_fts WHERE categories_fts MATCH 'Summer');
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "cat_1|published|1|100|200",
      "Summer Drinks",
    ]);
  });

  it("defaults new categories to draft and rejects invalid states and revisions", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail off
        ${oldSchema}
        ${migration}
        INSERT INTO categories (id, name, slug) VALUES ('draft', 'Draft', 'draft');
        SELECT status, revision FROM categories WHERE id = 'draft';
        INSERT INTO categories (id, name, slug, status) VALUES ('bad_status', 'Bad', 'bad-status', 'private');
        INSERT INTO categories (id, name, slug, revision) VALUES ('bad_revision', 'Bad', 'bad-revision', 0);
      `,
      encoding: "utf8",
    });

    expect(result.stdout).toContain("draft|1");
    expect(result.stderr).toContain("categories_status_valid");
    expect(result.stderr).toContain("categories_revision_positive");
  });
});
