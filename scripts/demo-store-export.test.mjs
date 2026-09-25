import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CURRENT_DATABASE_SCHEMA } from "../packages/database/src/schema-contract";
import { compiledMigrationSql } from "../packages/database/src/testing/sqlite-d1";

import { main, parseDemoStoreArgs } from "./demo-store.mjs";
import { collectExportTables } from "./demo-store/export/collect.mjs";
import { runDemoStoreExport } from "./demo-store/export/run.mjs";
import { readCanonicalSchemaRevision } from "./demo-store/export/schema-revision.mjs";
import { openSourceDatabase } from "./demo-store/export/source.mjs";
import { EXPORTED_TABLES } from "./demo-store/export/tables.mjs";
import { assertExportPreconditions } from "./demo-store/export/validate.mjs";

const FIXED_TIMESTAMP = 1_750_000_000;

/**
 * The fixture is a real migrated database, not a stub: every rule the exporter
 * enforces is a rule about SQLite rows, and the schema's own CHECK constraints
 * and guard triggers are part of what makes a bundle loadable.
 */
function migrateDatabase(file) {
  const database = new DatabaseSync(file);
  database.exec(compiledMigrationSql("d1"));
  return database;
}

function seedDemoCatalog(database) {
  database.exec("PRAGMA foreign_keys = ON");
  const run = (sql, ...values) => database.prepare(sql).run(...values);

  run(
    "INSERT INTO media_folders (id, name, version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    "mf_demo", "Demo", FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  const mediaRows = [
    ["med_a1", "aurora-1.jpg", "image", "demo/aurora-1.jpg", 2048, "image/jpeg", "Aurora front", null, 1200, 900, null, null, "mf_demo", "ready", null],
    ["med_a2", "aurora-2.jpg", "image", "demo/aurora-2.jpg", 3072, "image/jpeg", "Aurora side", null, 1200, 900, null, null, "mf_demo", "ready", null],
    ["med_b1", "basin-1.png", "image", "demo/basin-1.png", 4096, "image/png", "Basin", null, 800, 800, null, null, null, "ready", null],
    ["med_poster", "clip-poster.jpg", "image", "demo/clip-poster.jpg", 1024, "image/jpeg", null, null, 640, 360, null, null, null, "ready", null],
    ["med_clip", "clip.mp4", "video", "demo/clip.mp4", 9000, "video/mp4", null, "A short clip", null, null, 4200, "med_poster", "mf_demo", "ready", null],
    ["med_trashed", "old.jpg", "image", "demo/old.jpg", 500, "image/jpeg", null, null, null, null, null, null, null, "trashed", FIXED_TIMESTAMP],
  ];
  for (const row of mediaRows) {
    run(
      `INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, caption, width, height,
        duration_ms, poster_media_id, folder_id, status, version, created_at, updated_at, trashed_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
      ...row.slice(0, 14), FIXED_TIMESTAMP, FIXED_TIMESTAMP, row[14],
    );
  }

  run(
    `INSERT INTO categories (id, name, slug, description, content, image_url, meta_title, meta_description,
      canonical_path, no_index, exclude_from_sitemap, status, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, 0, 0, 'published', 1, ?, ?)`,
    "cat_lighting", "Lighting", "lighting", "Lamps and it's fixtures", "Lighting for every room",
    FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  run(
    `INSERT INTO categories (id, name, slug, description, content, image_url, meta_title, meta_description,
      canonical_path, no_index, exclude_from_sitemap, status, revision, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 'published', 1, ?, ?)`,
    "cat_bags", "Bags", "bags", FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  run(
    `INSERT INTO collections (id, name, description, content, presentation, config, sort_order, is_active,
      version, meta_title, meta_description, canonical_path, no_index, exclude_from_sitemap, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'grid', ?, 0, 1, 1, NULL, NULL, NULL, 0, 0, ?, ?)`,
    "col_featured", "Featured", "Editor picks", '{"kind":"manual","productIds":["prod_halo"]}',
    FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  run(
    "INSERT INTO product_attributes (id, name, slug, filterable, options, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
    "attr_material", "Material", "material", '["Aluminium","Canvas"]', FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );

  const insertProduct = (id, name, slug, price, categoryId) => run(
    `INSERT INTO products (id, name, description, price_minor, category_id, slug, meta_title, meta_description,
      canonical_path, no_index, exclude_from_sitemap, exclude_from_product_feed, product_condition,
      aggregate_revision, created_at, updated_at, is_active, discount_bps, discount_type,
      discount_amount_minor, free_delivery, tax_class_id, tax_classification_version)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 0, 'new', 1, ?, ?, 1, 0, 'percentage', 0, 0, NULL, 1)`,
    id, name, `A ${name} you'll like`, Math.round(price * 100), categoryId, slug, FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  insertProduct("prod_halo", "Halo Arc Table Lamp", "halo-arc-table-lamp", 149.5, "cat_lighting");
  insertProduct("prod_basin", "Basin Weekend Tote", "basin-weekend-tote", 89, "cat_bags");

  const insertProductMedia = (id, productId, mediaId, isPrimary, sortOrder) => run(
    `INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    id, productId, mediaId, isPrimary, sortOrder, FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  insertProductMedia("pmed_halo_1", "prod_halo", "med_a1", 1, 0);
  insertProductMedia("pmed_halo_2", "prod_halo", "med_a2", 0, 1);
  insertProductMedia("pmed_halo_3", "prod_halo", "med_clip", 0, 2);
  insertProductMedia("pmed_basin_1", "prod_basin", "med_b1", 1, 0);

  const insertOptionDefinition = (id, productId, name, position) => run(
    `INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'none', ?, ?)`,
    id, productId, name, name.toLowerCase(), position, FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  insertOptionDefinition("pod_finish", "prod_halo", "Finish", 0);
  insertOptionDefinition("pod_plug", "prod_halo", "Plug", 1);

  const insertOptionValue = (id, definitionId, value, position) => run(
    `INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, definitionId, value, value.toLowerCase(), position, FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  insertOptionValue("pov_matte", "pod_finish", "Matte", 0);
  insertOptionValue("pov_gloss", "pod_finish", "Gloss", 1);
  insertOptionValue("pov_eu", "pod_plug", "EU", 0);
  insertOptionValue("pov_us", "pod_plug", "US", 1);

  const insertVariant = (id, productId, optionKey, imageId, sku, price, stock, isDefault) => run(
    `INSERT INTO product_variants (id, product_id, option_combination_key, image_id, weight, sku, price_minor, stock,
      reserved_stock, preorder_stock, is_default, track_inventory, version, stock_version, low_stock_threshold,
      allow_preorder, preorder_date, preorder_message, allow_backorder, backorder_limit, tax_class_id,
      tax_classification_version, discount_bps, discount_type, discount_amount_minor, barcode, barcode_type,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, ?, 1, 1, 1, NULL, 0, NULL, NULL, 0, 0, NULL, 1, 0, 'percentage', 0, NULL, NULL, ?, ?)`,
    id, productId, optionKey, imageId, sku, Math.round(price * 100), stock, isDefault, FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  insertVariant("var_halo_matte_eu", "prod_halo", "matte|eu", "pmed_halo_1", "HALO-MATTE-EU", 149.5, 18, 0);
  insertVariant("var_halo_gloss_eu", "prod_halo", "gloss|eu", "pmed_halo_2", "HALO-GLOSS-EU", 159.5, 12, 0);
  insertVariant("var_basin_default", "prod_basin", null, null, "BASIN-ONE", 89, 24, 1);

  const insertVariantOption = (variantId, definitionId, valueId) => run(
    "INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES (?, ?, ?)",
    variantId, definitionId, valueId,
  );
  insertVariantOption("var_halo_matte_eu", "pod_finish", "pov_matte");
  insertVariantOption("var_halo_matte_eu", "pod_plug", "pov_eu");
  insertVariantOption("var_halo_gloss_eu", "pod_finish", "pov_gloss");
  insertVariantOption("var_halo_gloss_eu", "pod_plug", "pov_eu");

  run(
    "INSERT INTO product_attribute_values (id, product_id, attribute_id, value, created_at) VALUES (?, ?, ?, ?, ?)",
    "pav_halo", "prod_halo", "attr_material", "Aluminium", FIXED_TIMESTAMP,
  );
  run(
    "INSERT INTO product_rich_content (id, product_id, title, content, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    "prc_halo", "prod_halo", "Fit and sizing", "<p>Stands 42cm tall.</p>", FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  run(
    "INSERT INTO hero_sections (id, name, type, is_active, config, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
    "hero_home", "Home hero", "split", '{"headline":"Light it up"}', FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
  run(
    "INSERT INTO hero_sliders (id, type, images, is_active, revision, created_at, updated_at) VALUES (?, 'desktop', ?, 1, 1, ?, ?)",
    "hs_desktop", '["demo/hero.webp"]', FIXED_TIMESTAMP, FIXED_TIMESTAMP,
  );
}

/** Object keys and byte sizes the fixture's ready media rows declare. */
const FIXTURE_MEDIA_OBJECTS = Object.freeze([
  ["demo/aurora-1.jpg", 2048],
  ["demo/aurora-2.jpg", 3072],
  ["demo/basin-1.png", 4096],
  ["demo/clip-poster.jpg", 1024],
  ["demo/clip.mp4", 9000],
]);

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

let workspace;
let migratedTemplate;
let seededTemplate;

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "demo-store-export-"));
  migratedTemplate = path.join(workspace, "migrated.sqlite");
  migrateDatabase(migratedTemplate).close();
  seededTemplate = path.join(workspace, "seeded.sqlite");
  copyFileSync(migratedTemplate, seededTemplate);
  const seeded = new DatabaseSync(seededTemplate);
  seedDemoCatalog(seeded);
  seeded.close();
}, 120_000);

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllGlobals());

/** A private copy of the seeded fixture, plus an unused output path. */
function newExportCase() {
  const directory = mkdtempSync(path.join(workspace, "case-"));
  const sourceDb = path.join(directory, "source.sqlite");
  copyFileSync(seededTemplate, sourceDb);
  return {
    directory,
    sourceDb,
    exportDir: path.join(directory, "bundle"),
    mutate(apply) {
      const database = new DatabaseSync(sourceDb);
      database.exec("PRAGMA foreign_keys = ON");
      apply(database);
      database.close();
    },
    readBundleJson() {
      return JSON.parse(readFileSync(path.join(this.exportDir, "bundle.json"), "utf8"));
    },
    readMediaManifest() {
      return JSON.parse(readFileSync(path.join(this.exportDir, "media-manifest.json"), "utf8"));
    },
    readSeedSql() {
      return readFileSync(path.join(this.exportDir, "seed.sql"), "utf8");
    },
    writeMediaObjects(objects = FIXTURE_MEDIA_OBJECTS) {
      const mediaSourceDir = path.join(directory, "objects");
      for (const [objectKey, size] of objects) {
        const file = path.join(mediaSourceDir, objectKey);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, Buffer.alloc(size, objectKey.charCodeAt(0) % 251));
      }
      return mediaSourceDir;
    },
  };
}

describe("demo store export arguments", () => {
  it("parses the full export invocation without inventing defaults", () => {
    expect(parseDemoStoreArgs([
      "--export", "out", "--source-db", "local.sqlite", "--media-source-dir", "objects", "--json",
    ])).toEqual({
      help: false,
      plan: false,
      compile: false,
      diff: false,
      apply: false,
      json: true,
      exportDir: "out",
      sourceDb: "local.sqlite",
      mediaSourceDir: "objects",
    });
  });

  it("requires an explicit source database", () => {
    expect(() => parseDemoStoreArgs(["--export", "out"]))
      .toThrow("--export requires an explicit --source-db");
  });

  it("refuses to run export alongside another mode", () => {
    expect(() => parseDemoStoreArgs(["--plan", "--export", "out", "--source-db", "local.sqlite"]))
      .toThrow("Choose exactly one of --plan, --compile, --diff, --apply, or --export.");
    expect(() => parseDemoStoreArgs(["--apply", "--media-readiness", "r.json", "--export", "out", "--source-db", "db"]))
      .toThrow("Choose exactly one of --plan, --compile, --diff, --apply, or --export.");
  });

  it("refuses source and media options outside export mode", () => {
    expect(() => parseDemoStoreArgs(["--plan", "--source-db", "local.sqlite"]))
      .toThrow("Source database and media source options are valid only with --export.");
    expect(() => parseDemoStoreArgs(["--diff", "--media-source-dir", "objects"]))
      .toThrow("Source database and media source options are valid only with --export.");
  });

  it("refuses credential-shaped flags in export mode", () => {
    for (const flag of ["--email=a@b.c", "--password", "--cookie=x", "--token=x", "--secret=x"]) {
      expect(() => parseDemoStoreArgs(["--export", "out", "--source-db", "db", flag]))
        .toThrow("Admin credentials and session material are accepted only through the interactive terminal prompt.");
    }
  });

  it("names export mode in the usage text and in the no-mode error", async () => {
    const lines = [];
    await expect(main(["--help"], { log: (line) => lines.push(line) })).resolves.toBe(0);
    expect(lines.join("\n")).toContain("pnpm demo:store --export <dir> --source-db <sqlite file>");
    await expect(main([], { log: vi.fn() })).rejects.toThrow("read-only --export");
  });
});

describe("demo store export bundle", () => {
  it("derives the canonical schema revision from the migration files", () => {
    const revision = readCanonicalSchemaRevision();
    expect(revision.version).toBe(CURRENT_DATABASE_SCHEMA.version);
    expect(revision.name).toBe(CURRENT_DATABASE_SCHEMA.name);
    expect(revision.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("writes a complete bundle without touching the network or the source", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("Export mode attempted network access");
    });
    vi.stubGlobal("fetch", fetchMock);
    const testCase = newExportCase();
    const sourceDigestBefore = sha256File(testCase.sourceDb);
    let readOnlyRejection = null;
    const lines = [];

    await expect(main(
      ["--export", testCase.exportDir, "--source-db", testCase.sourceDb, "--json"],
      {
        log: (line) => lines.push(line),
        runExportImpl: (options) => runDemoStoreExport({
          ...options,
          openDatabaseImpl: (file) => {
            const database = openSourceDatabase(file);
            try {
              database.exec("UPDATE products SET name = 'tampered'");
            } catch (error) {
              readOnlyRejection = error;
            }
            return database;
          },
        }),
      },
    )).resolves.toBe(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readOnlyRejection).toBeInstanceOf(Error);
    expect(String(readOnlyRejection.message)).toMatch(/readonly/iu);
    expect(sha256File(testCase.sourceDb)).toBe(sourceDigestBefore);

    const summary = JSON.parse(lines.join("\n"));
    expect(summary.mode).toBe("export");
    expect(summary.writesEnabled).toBe(false);
    expect(summary.network).toBe("none");
    expect(summary.source.readOnly).toBe(true);

    const bundle = testCase.readBundleJson();
    expect(bundle.contract).toBe("scalius-demo-store-seed/v1");
    expect(bundle.schema).toEqual({
      version: CURRENT_DATABASE_SCHEMA.version,
      name: CURRENT_DATABASE_SCHEMA.name,
      sourceSha256: readCanonicalSchemaRevision().sourceSha256,
    });
    expect(bundle.tables.map((entry) => entry.table)).toEqual([...EXPORTED_TABLES]);
    expect(Object.fromEntries(bundle.tables.map((entry) => [entry.table, entry.rows]))).toEqual({
      media_folders: 1,
      media: 5,
      categories: 2,
      collections: 1,
      product_attributes: 1,
      products: 2,
      product_media: 4,
      product_option_definitions: 2,
      product_option_values: 4,
      product_variants: 3,
      product_variant_option_values: 4,
      product_attribute_values: 1,
      product_rich_content: 1,
      hero_sections: 1,
      hero_sliders: 1,
    });
    expect(bundle.rowTotal).toBe(33);
    expect(bundle.media).toMatchObject({ count: 5, bytesIncluded: false, directory: null });
    expect(bundle.demoStoreContract.matches).toBe(false);
    expect(bundle.artifacts.seedSql.sha256).toBe(sha256File(path.join(testCase.exportDir, "seed.sql")));
    expect(bundle.artifacts.mediaManifest.sha256)
      .toBe(sha256File(path.join(testCase.exportDir, "media-manifest.json")));
    expect(readdirSync(testCase.exportDir).sort()).toEqual(["bundle.json", "media-manifest.json", "seed.sql"]);

    const seedSql = testCase.readSeedSql();
    expect(seedSql).toContain("-- Contract: scalius-demo-store-seed/v1");
    expect(seedSql).toContain(`-- Schema revision: ${CURRENT_DATABASE_SCHEMA.version}/${CURRENT_DATABASE_SCHEMA.name}`);
    expect(seedSql).toContain("no orders, no customers, no admin users, no sessions, no settings");
    expect(seedSql).toContain("BEGIN;\nPRAGMA defer_foreign_keys = ON;");
    expect(seedSql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(seedSql).toContain("'A Halo Arc Table Lamp you''ll like'");
    expect(seedSql).not.toContain("med_trashed");
    expect(seedSql).not.toMatch(/INSERT INTO "(?:orders|customers|user|session|settings|[a-z_]*_fts)"/u);
  });

  it("describes every exported asset and the references that point at it", async () => {
    const testCase = newExportCase();
    await runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb });

    const manifest = testCase.readMediaManifest();
    expect(manifest.contract).toBe("scalius-demo-store-seed/v1");
    expect(manifest.mediaDirectory).toBeNull();
    expect(manifest.objects.map((object) => object.objectKey))
      .toEqual(FIXTURE_MEDIA_OBJECTS.map(([objectKey]) => objectKey));
    expect(manifest.objects.every((object) => object.sha256 === null)).toBe(true);

    const aurora = manifest.objects.find((object) => object.objectKey === "demo/aurora-1.jpg");
    expect(aurora).toMatchObject({
      id: "med_a1", filename: "aurora-1.jpg", kind: "image", mimeType: "image/jpeg",
      byteSize: 2048, width: 1200, height: 900, durationMs: null, bytesIncluded: false,
    });
    expect(aurora.references).toEqual({
      folderId: "mf_demo",
      posterMediaId: null,
      posterFor: [],
      productMedia: [{ productMediaId: "pmed_halo_1", productId: "prod_halo", isPrimary: true, sortOrder: 0 }],
      variantImages: [{ variantId: "var_halo_matte_eu", productId: "prod_halo", productMediaId: "pmed_halo_1" }],
    });

    const clip = manifest.objects.find((object) => object.objectKey === "demo/clip.mp4");
    expect(clip).toMatchObject({ id: "med_clip", kind: "video", mimeType: "video/mp4", durationMs: 4200 });
    expect(clip.references.posterMediaId).toBe("med_poster");
    const poster = manifest.objects.find((object) => object.objectKey === "demo/clip-poster.jpg");
    expect(poster.references.posterFor).toEqual(["med_clip"]);
  });

  it("re-exports the same database byte for byte", async () => {
    const testCase = newExportCase();
    await runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb });
    const first = {
      bundle: sha256File(path.join(testCase.exportDir, "bundle.json")),
      seed: sha256File(path.join(testCase.exportDir, "seed.sql")),
      media: sha256File(path.join(testCase.exportDir, "media-manifest.json")),
    };

    await runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb });

    expect({
      bundle: sha256File(path.join(testCase.exportDir, "bundle.json")),
      seed: sha256File(path.join(testCase.exportDir, "seed.sql")),
      media: sha256File(path.join(testCase.exportDir, "media-manifest.json")),
    }).toEqual(first);
  });

  it("loads into a freshly migrated database and lets the schema rebuild its search indexes", async () => {
    const testCase = newExportCase();
    await runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb });

    const targetFile = path.join(testCase.directory, "target.sqlite");
    copyFileSync(migratedTemplate, targetFile);
    const target = new DatabaseSync(targetFile);
    target.exec("PRAGMA foreign_keys = ON");
    target.exec(testCase.readSeedSql());

    const bundle = testCase.readBundleJson();
    for (const { table, rows } of bundle.tables) {
      expect({ table, rows: target.prepare(`SELECT count(*) AS total FROM "${table}"`).get().total })
        .toEqual({ table, rows });
    }
    expect(target.prepare("SELECT name, price_minor, category_id FROM products WHERE id = 'prod_halo'").get())
      .toEqual({ name: "Halo Arc Table Lamp", price_minor: 14_950, category_id: "cat_lighting" });
    expect(target.prepare("SELECT sku, stock, image_id FROM product_variants WHERE id = 'var_halo_matte_eu'").get())
      .toEqual({ sku: "HALO-MATTE-EU", stock: 18, image_id: "pmed_halo_1" });
    expect(target.prepare("SELECT description FROM categories WHERE id = 'cat_lighting'").get().description)
      .toBe("Lamps and it's fixtures");
    expect(target.prepare("SELECT count(*) AS total FROM media WHERE id = 'med_trashed'").get().total).toBe(0);

    // The AFTER INSERT triggers in the migrated schema repopulate the FTS
    // shadow tables as the seed loads, which is why the bundle never carries them.
    const matched = target
      .prepare("SELECT p.id AS id FROM products_fts f JOIN products p ON p.rowid = f.rowid WHERE products_fts MATCH 'Halo'")
      .all();
    expect(matched.map((row) => row.id)).toEqual(["prod_halo"]);
    const matchedCategories = target
      .prepare("SELECT c.slug AS slug FROM categories_fts f JOIN categories c ON c.rowid = f.rowid WHERE categories_fts MATCH 'Lighting'")
      .all();
    expect(matchedCategories.map((row) => row.slug)).toEqual(["lighting"]);
    target.close();
  });
});

describe("demo store export media objects", () => {
  it("copies, sizes and hashes every object the catalog names", async () => {
    const testCase = newExportCase();
    const mediaSourceDir = testCase.writeMediaObjects();

    const summary = await runDemoStoreExport({
      exportDir: testCase.exportDir,
      sourceDb: testCase.sourceDb,
      mediaSourceDir,
    });

    expect(summary.media).toMatchObject({ count: 5, bytesIncluded: true, directory: "media", objectsCopied: 5 });
    const manifest = testCase.readMediaManifest();
    expect(manifest.mediaDirectory).toBe("media");
    for (const object of manifest.objects) {
      const copied = path.join(testCase.exportDir, "media", object.objectKey);
      expect(existsSync(copied)).toBe(true);
      expect(object.sha256).toBe(sha256File(copied));
      expect(object.sha256).toBe(sha256File(path.join(mediaSourceDir, object.objectKey)));
      expect(object.bytesIncluded).toBe(true);
    }
    expect(testCase.readBundleJson().media.totalBytes).toBe(2048 + 3072 + 4096 + 1024 + 9000);
  });

  it("fails the whole export when an object is missing and writes no bundle at all", async () => {
    const testCase = newExportCase();
    const mediaSourceDir = testCase.writeMediaObjects(
      FIXTURE_MEDIA_OBJECTS.filter(([objectKey]) => objectKey !== "demo/clip.mp4"),
    );

    await expect(runDemoStoreExport({
      exportDir: testCase.exportDir,
      sourceDb: testCase.sourceDb,
      mediaSourceDir,
    })).rejects.toThrow(/1 exported media object\(s\) are missing .*demo\/clip\.mp4/su);

    expect(existsSync(testCase.exportDir)).toBe(false);
  });

  it("refuses an object whose bytes disagree with its media row", async () => {
    const testCase = newExportCase();
    const mediaSourceDir = testCase.writeMediaObjects();
    writeFileSync(path.join(mediaSourceDir, "demo/basin-1.png"), Buffer.alloc(11));

    await expect(runDemoStoreExport({
      exportDir: testCase.exportDir,
      sourceDb: testCase.sourceDb,
      mediaSourceDir,
    })).rejects.toThrow(/demo\/basin-1\.png \(media row med_b1 records 4096 bytes, file is 11\)/u);

    expect(existsSync(testCase.exportDir)).toBe(false);
  });

  it("drops a stale media tree when a later export carries no objects", async () => {
    const testCase = newExportCase();
    const mediaSourceDir = testCase.writeMediaObjects();
    await runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb, mediaSourceDir });
    expect(existsSync(path.join(testCase.exportDir, "media"))).toBe(true);

    await runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb });

    expect(existsSync(path.join(testCase.exportDir, "media"))).toBe(false);
    expect(testCase.readMediaManifest().objects.every((object) => object.sha256 === null)).toBe(true);
  });

  it("refuses an output directory holding anything it did not write", async () => {
    const testCase = newExportCase();
    mkdirSync(testCase.exportDir, { recursive: true });
    writeFileSync(path.join(testCase.exportDir, "notes.txt"), "mine\n");

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/already holds notes\.txt, which this exporter did not write/u);
  });

  it("refuses a source database that is not a file", async () => {
    const testCase = newExportCase();
    await expect(runDemoStoreExport({
      exportDir: testCase.exportDir,
      sourceDb: path.join(testCase.directory, "absent.sqlite"),
    })).rejects.toThrow(/No SQLite database exists at .*absent\.sqlite/u);
  });
});

describe("demo store export fail-closed preconditions", () => {
  it("refuses a source at a different schema revision", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => {
      database.exec("UPDATE scalius_schema_migrations SET name = '0089_something_else' WHERE version = 89");
    });

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/is at schema revision 89\/0089_something_else .* can only be exported at revision 89\/0089_wave_a_contract_columns/su);
  });

  it("refuses a source whose migration digest does not match the canonical migration", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => {
      database.exec(`UPDATE scalius_schema_migrations SET source_sha256 = '${"0".repeat(64)}' WHERE version = 89`);
    });

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/source_sha256 0{64}/u);
  });

  it("refuses a source with no release ledger at all", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => database.exec("DROP TABLE scalius_schema_migrations"));

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow("The source database has no scalius_schema_migrations table");
  });

  it("refuses a catalog carrying live reserved stock", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => {
      database.exec("UPDATE product_variants SET reserved_stock = 3 WHERE id = 'var_halo_matte_eu'");
    });

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/var_halo_matte_eu \(sku HALO-MATTE-EU, reserved 3\)/u);
  });

  it("refuses a catalog an order line still points at", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => {
      database.prepare(
        `INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, shipping_amount_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("ord_1", "Ada", "+8801700000000", "1 Road", "Dhaka", "Gulshan", 20_950, 6_000);
      database.prepare(
        "INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("oit_1", "ord_1", "prod_halo", "var_halo_matte_eu", 1, 14_950);
    });

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/order_items holds order line\(s\) that reference the exported catalog: oit_1/u);
  });

  it("refuses a product that still carries a tax class assignment", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => {
      database.prepare(
        "INSERT INTO tax_classes (id, name, is_exempt, version, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)",
      ).run("tc_standard", "Standard", FIXED_TIMESTAMP, FIXED_TIMESTAMP);
      database.exec("UPDATE products SET tax_class_id = 'tc_standard' WHERE id = 'prod_halo'");
    });

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/1 exported products row\(s\) reference tax_classes through tax_class_id, and tax_classes is not part of the portable catalog: prod_halo\. Clear the tax_class_id assignment on those rows before exporting a portable seed/u);
  });

  it("refuses a variant that still carries a tax class assignment", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => {
      database.prepare(
        "INSERT INTO tax_classes (id, name, is_exempt, version, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)",
      ).run("tc_standard", "Standard", FIXED_TIMESTAMP, FIXED_TIMESTAMP);
      database.exec("UPDATE product_variants SET tax_class_id = 'tc_standard' WHERE id = 'var_basin_default'");
    });

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/exported product_variants row\(s\) reference tax_classes through tax_class_id/u);
  });

  it("refuses a product whose category was soft-deleted out from under it", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => {
      database.exec(`UPDATE categories SET deleted_at = ${FIXED_TIMESTAMP} WHERE id = 'cat_bags'`);
    });

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/1 exported products row\(s\) reference a categories row that is not itself exported through category_id: prod_basin/u);
  });

  it("refuses a product_media row stranded by a soft-deleted media asset", async () => {
    const testCase = newExportCase();
    testCase.mutate((database) => {
      database.exec(`UPDATE media SET status = 'trashed', trashed_at = ${FIXED_TIMESTAMP} WHERE id = 'med_a1'`);
    });

    await expect(runDemoStoreExport({ exportDir: testCase.exportDir, sourceDb: testCase.sourceDb }))
      .rejects.toThrow(/1 exported product_media row\(s\) reference a media row that is not itself exported through media_id: pmed_halo_1/u);
  });

  it("refuses duplicate and empty media object keys", () => {
    // `media.object_key` is uniquely indexed, so these two shapes are
    // unreachable through the source database and the rule is proven directly
    // against the collected catalog it protects.
    const testCase = newExportCase();
    const database = openSourceDatabase(testCase.sourceDb);
    try {
      const duplicated = collectExportTables(database);
      duplicated.get("media").rows[1].object_key = duplicated.get("media").rows[0].object_key;
      expect(() => assertExportPreconditions(database, duplicated))
        .toThrow(/media object key\(s\) are claimed by more than one exported media row: demo\/aurora-1\.jpg \(med_a1, med_a2\)/u);

      const emptied = collectExportTables(database);
      emptied.get("media").rows[2].object_key = "   ";
      expect(() => assertExportPreconditions(database, emptied))
        .toThrow(/1 exported media row\(s\) carry an empty object_key: med_b1/u);
    } finally {
      database.close();
    }
  });
});
