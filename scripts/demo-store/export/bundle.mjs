/**
 * Assembles a portable seed bundle in memory.
 *
 * Everything that can fail is resolved here, before `write.mjs` touches the
 * output directory: the schema revision is proven, the catalog is collected and
 * validated, the SQL is rendered, and the media objects are located, sized and
 * hashed. By the time a byte is written the bundle is known to be complete, so
 * a failed export never leaves a directory that looks like a finished one.
 *
 * `bundle.json` is the manifest a loader reads first. It records the exact
 * schema revision the seed belongs to, the per-table row counts it will
 * restore, and the sha256 of both `seed.sql` and `media-manifest.json` so a
 * transfer can be verified before it is applied. It carries no timestamps and
 * no local paths, because two exports of the same database must be
 * byte-identical.
 */

import { createHash } from "node:crypto";

import { DEMO_STORE_CONTRACT } from "../manifest.mjs";
import {
  assertSchemaRevisionMatches,
  collectExportTables,
  tableRowCounts,
} from "./collect.mjs";
import { assertExportPreconditions } from "./validate.mjs";
import { buildMediaManifest, resolveMediaObjects } from "./media.mjs";
import { buildSeedSql } from "./seed-sql.mjs";
import { readCanonicalSchemaRevision } from "./schema-revision.mjs";
import { readSourceSchemaRevision } from "./source.mjs";
import {
  BUNDLE_MANIFEST_FILENAME,
  DEMO_STORE_SEED_CONTRACT,
  MEDIA_DIRECTORY_NAME,
  MEDIA_MANIFEST_FILENAME,
  SEED_SQL_FILENAME,
} from "./tables.mjs";

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Cross-checks the exported catalog against the shape the demo-store manifest
 * describes. This is reported, never enforced: the exporter is equally valid on
 * a trimmed fixture, and a bundle that silently differs from the published
 * contract is exactly what an operator wants to see recorded.
 */
function demoStoreContractComparison(tables) {
  const observed = {
    categories: tables.get("categories").rows.length,
    products: tables.get("products").rows.length,
    skus: tables.get("product_variants").rows.length,
    collections: tables.get("collections").rows.length,
  };
  const expected = {
    categories: DEMO_STORE_CONTRACT.categories,
    products: DEMO_STORE_CONTRACT.products,
    skus: DEMO_STORE_CONTRACT.skus,
    collections: DEMO_STORE_CONTRACT.collections,
  };
  const matches = Object.keys(expected).every((key) => expected[key] === observed[key]);
  return { expected, observed, matches };
}

export async function buildDemoStoreSeedBundle({ database, mediaSourceDirectory = null }) {
  const revision = assertSchemaRevisionMatches(
    readSourceSchemaRevision(database),
    readCanonicalSchemaRevision(),
  );
  const tables = collectExportTables(database);
  assertExportPreconditions(database, tables);

  const mediaRows = tables.get("media").rows;
  const media = mediaSourceDirectory === null
    ? { planned: [], digestsByObjectKey: null }
    : await resolveMediaObjects({ mediaSourceDirectory, mediaRows });

  const seedSql = buildSeedSql({ revision, tables });
  const mediaManifest = buildMediaManifest({
    revision,
    tables,
    digestsByObjectKey: media.digestsByObjectKey,
  });
  const mediaManifestJson = serializeJson(mediaManifest);
  const counts = tableRowCounts(tables);
  const bundleManifest = {
    contract: DEMO_STORE_SEED_CONTRACT,
    schema: { version: revision.version, name: revision.name, sourceSha256: revision.sourceSha256 },
    source: { readOnly: true, network: "none" },
    tables: counts,
    rowTotal: counts.reduce((total, entry) => total + entry.rows, 0),
    demoStoreContract: demoStoreContractComparison(tables),
    media: {
      count: mediaRows.length,
      bytesIncluded: media.digestsByObjectKey !== null,
      directory: media.digestsByObjectKey === null ? null : MEDIA_DIRECTORY_NAME,
      totalBytes: mediaRows.reduce((total, row) => total + Number(row.size), 0),
    },
    artifacts: {
      seedSql: {
        filename: SEED_SQL_FILENAME,
        bytes: Buffer.byteLength(seedSql, "utf8"),
        sha256: sha256Text(seedSql),
      },
      mediaManifest: {
        filename: MEDIA_MANIFEST_FILENAME,
        bytes: Buffer.byteLength(mediaManifestJson, "utf8"),
        sha256: sha256Text(mediaManifestJson),
      },
    },
  };

  return {
    revision,
    manifestFilename: BUNDLE_MANIFEST_FILENAME,
    bundleManifest,
    bundleManifestJson: serializeJson(bundleManifest),
    seedSql,
    mediaManifest,
    mediaManifestJson,
    mediaObjects: media.planned,
  };
}
