import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyD1ExportTables,
  D1_PORTABLE_EXPORT_EVIDENCE_FILENAME,
  D1_PORTABLE_EXPORT_FILENAME,
  D1_PORTABLE_EXPORT_VERSION,
  parseD1ExecuteTableNames,
  verifyD1PortableExportBundle,
} from "../scripts/export-d1-portable";
import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
} from "../scripts/sqlite-provider-schema";

describe("portable D1 export table boundary", () => {
  it("exports canonical and known retired tables while excluding provider objects", () => {
    const classified = classifyD1ExportTables([
      "products_fts_data",
      "plugin_routes",
      "products",
      "_cf_KV",
      "orders",
      "d1_migrations",
      "plugin_state",
    ], ["orders", "products"]);

    expect(classified).toEqual({
      tables: ["orders", "plugin_routes", "plugin_state", "products"],
      retiredTables: ["plugin_routes", "plugin_state"],
    });
  });

  it("fails before export when canonical tables are missing or unknown data exists", () => {
    expect(() => classifyD1ExportTables(["orders"], ["orders", "products"]))
      .toThrow(/missing canonical tables: products/i);
    expect(() => classifyD1ExportTables(
      ["orders", "merchant_private_extension"],
      ["orders"],
    )).toThrow(/unexpected noncanonical tables: merchant_private_extension/i);
  });

  it("strictly parses one successful Wrangler schema response", () => {
    expect(parseD1ExecuteTableNames(JSON.stringify([{
      success: true,
      results: [{ name: "products" }, { name: "orders" }],
    }]))).toEqual(["orders", "products"]);
    expect(() => parseD1ExecuteTableNames("[]"))
      .toThrow(/invalid D1 schema result/i);
    expect(() => parseD1ExecuteTableNames(JSON.stringify([{
      success: true,
      results: [{ name: "orders" }, { name: "orders" }],
    }]))).toThrow(/duplicate D1 table names/i);
  });

  it("binds a canonical export artifact to strict bookmark and table evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-d1-export-proof-"));
    try {
      const database = await createProviderSchemaDatabase("d1");
      const canonicalTables = readApplicationTableNames(database);
      database.close();
      const tables = [...canonicalTables, "plugin_routes"].sort();
      const source = Buffer.from("-- deterministic test export\n");
      const sourceSha256 = createHash("sha256").update(source).digest("hex");
      await writeFile(join(directory, D1_PORTABLE_EXPORT_FILENAME), source, {
        mode: 0o600,
      });
      await writeFile(
        join(directory, D1_PORTABLE_EXPORT_EVIDENCE_FILENAME),
        `${JSON.stringify({
          version: D1_PORTABLE_EXPORT_VERSION,
          database: "merchant-d1",
          bookmark: "opaque-bookmark",
          tables,
          retiredTables: ["plugin_routes"],
          tableSetSha256: createHash("sha256")
            .update(tables.join("\n"))
            .digest("hex"),
          artifact: {
            filename: D1_PORTABLE_EXPORT_FILENAME,
            bytes: source.byteLength,
            sha256: sourceSha256,
          },
        }, null, 2)}\n`,
        { mode: 0o600 },
      );

      const verified = await verifyD1PortableExportBundle(directory);
      expect(verified.evidence).toMatchObject({
        database: "merchant-d1",
        bookmark: "opaque-bookmark",
        retiredTables: ["plugin_routes"],
      });
      expect(verified.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);

      await writeFile(
        join(directory, D1_PORTABLE_EXPORT_FILENAME),
        Buffer.from("tampered"),
      );
      await expect(verifyD1PortableExportBundle(directory))
        .rejects.toThrow(/source artifact does not match/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
