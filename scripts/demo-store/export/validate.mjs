/**
 * The fail-closed preconditions a portable seed bundle has to satisfy.
 *
 * Every rule here refuses an export outright rather than repairing, trimming or
 * warning about the catalog it was handed. A seed bundle is loaded unattended
 * into somebody else's deployment, so the only safe failure mode is to produce
 * no bundle at all and tell the operator exactly which rows are in the way.
 *
 * Rules 1 (schema revision) and 5 (soft-deleted rows) are enforced upstream, in
 * `collect.mjs` and in the row filter in `source.mjs`. This module carries:
 *
 *   3. No commerce entanglement: no reserved stock, no reservation lanes, no
 *      lane movements and no order lines may reach into the exported catalog.
 *   4. No dangling references: every non-null foreign key on an exported row
 *      must resolve to a row that is itself exported. The edges are read from
 *      `PRAGMA foreign_key_list`, never hard-coded, so a new reference added by
 *      a future migration is checked the day it lands.
 *   6. Media object keys are real: non-empty, and unique across the bundle.
 */

import { COMMERCE_ENTANGLEMENT_PROBES, EXPORTED_TABLES } from "./tables.mjs";
import { rowIdentity } from "./collect.mjs";
import { selectRowsMatchingAny, tableExists } from "./source.mjs";

const SAMPLE_LIMIT = 10;

function formatIdentities(identities) {
  const unique = [...new Set(identities.map((identity) => String(identity)))].sort();
  if (unique.length <= SAMPLE_LIMIT) return unique.join(", ");
  return `${unique.slice(0, SAMPLE_LIMIT).join(", ")} and ${unique.length - SAMPLE_LIMIT} more`;
}

/** Rule 3a: a demo seed never carries reservation counters from a live store. */
function assertNoReservedStock(tables) {
  const variants = tables.get("product_variants");
  const reserved = variants.rows.filter((row) => Number(row.reserved_stock) !== 0);
  if (reserved.length > 0) {
    throw new Error(
      `${reserved.length} exported product_variants row(s) carry non-zero reserved_stock: `
      + `${formatIdentities(reserved.map((row) => `${row.id} (sku ${row.sku}, reserved ${row.reserved_stock})`))}. `
      + "A portable demo-store seed must not carry live reservation state. Release or settle those reservations before exporting.",
    );
  }
}

/** Rule 3b: no live checkout or order row may reference an exported row. */
function assertNoLiveCommerceReferences(database, tables) {
  const productIds = tables.get("products").rows.map((row) => row.id);
  const variantIds = tables.get("product_variants").rows.map((row) => row.id);
  for (const probe of COMMERCE_ENTANGLEMENT_PROBES) {
    if (!tableExists(database, probe.table)) {
      throw new Error(
        `The source database has no ${probe.table} table, so the exporter cannot prove the exported catalog is free of live commerce state.`,
      );
    }
    const checks = [
      probe.variantColumn ? { column: probe.variantColumn, values: variantIds } : null,
      probe.productColumn ? { column: probe.productColumn, values: productIds } : null,
    ].filter(Boolean);
    const offenders = [];
    for (const check of checks) {
      offenders.push(
        ...selectRowsMatchingAny(database, {
          table: probe.table,
          identitySql: probe.identitySql,
          columns: [check.column],
          values: check.values,
        }),
      );
    }
    if (offenders.length > 0) {
      throw new Error(
        `${probe.table} holds ${probe.label}(s) that reference the exported catalog: `
        + `${formatIdentities(offenders.map((row) => row.identity))}. `
        + "A portable demo-store seed must not be taken from a store with live checkout or order state against its catalog.",
      );
    }
  }
}

function targetKeyColumns(edge, targetTable) {
  if (edge.columns.every((pair) => pair.to !== null)) {
    return edge.columns.map((pair) => pair.to);
  }
  return targetTable.primaryKey.map((column) => column.name);
}

function compositeKey(values) {
  return JSON.stringify(values.map((value) => (value === null ? null : String(value))));
}

/** Rule 4: every non-null reference on an exported row resolves inside the bundle. */
function assertNoDanglingReferences(tables) {
  const targetKeySets = new Map();
  for (const table of tables.values()) {
    for (const edge of table.foreignKeys) {
      const target = tables.get(edge.table);
      const fromColumns = edge.columns.map((pair) => pair.from);
      const referencing = table.rows.filter((row) => fromColumns.every((column) => row[column] !== null));
      if (referencing.length === 0) continue;
      if (!target) {
        throw new Error(
          `${referencing.length} exported ${table.name} row(s) reference ${edge.table} through `
          + `${fromColumns.join(", ")}, and ${edge.table} is not part of the portable catalog: `
          + `${formatIdentities(referencing.map((row) => rowIdentity(table, row)))}. `
          + `Clear the ${fromColumns.join(", ")} assignment on those rows before exporting a portable seed, `
          + `or the seed would load against a ${edge.table} row the receiving deployment does not have.`,
        );
      }
      const toColumns = targetKeyColumns(edge, target);
      const cacheKey = `${edge.table}::${toColumns.join(",")}`;
      let keys = targetKeySets.get(cacheKey);
      if (!keys) {
        keys = new Set(target.rows.map((row) => compositeKey(toColumns.map((column) => row[column]))));
        targetKeySets.set(cacheKey, keys);
      }
      const dangling = referencing.filter(
        (row) => !keys.has(compositeKey(fromColumns.map((column) => row[column]))),
      );
      if (dangling.length > 0) {
        throw new Error(
          `${dangling.length} exported ${table.name} row(s) reference a ${edge.table} row that is not itself `
          + `exported through ${fromColumns.join(", ")}: ${formatIdentities(dangling.map((row) => rowIdentity(table, row)))}. `
          + `The referenced ${edge.table} row is missing, soft-deleted, or otherwise excluded from the portable catalog; `
          + "repoint or remove those references before exporting a portable seed.",
        );
      }
    }
  }
}

/** Rule 6: the media manifest is keyed by object key, so it has to be a real key. */
function assertMediaObjectKeys(tables) {
  const media = tables.get("media");
  const empty = media.rows.filter(
    (row) => typeof row.object_key !== "string" || row.object_key.trim() === "",
  );
  if (empty.length > 0) {
    throw new Error(
      `${empty.length} exported media row(s) carry an empty object_key: `
      + `${formatIdentities(empty.map((row) => row.id))}. `
      + "Every exported asset must name the object a receiving deployment has to fetch.",
    );
  }
  const seen = new Map();
  const duplicates = new Map();
  for (const row of media.rows) {
    const existing = seen.get(row.object_key);
    if (existing) {
      const ids = duplicates.get(row.object_key) ?? [existing];
      ids.push(row.id);
      duplicates.set(row.object_key, ids);
    } else {
      seen.set(row.object_key, row.id);
    }
  }
  if (duplicates.size > 0) {
    throw new Error(
      `${duplicates.size} media object key(s) are claimed by more than one exported media row: `
      + `${formatIdentities([...duplicates].map(([key, ids]) => `${key} (${ids.join(", ")})`))}. `
      + "The media manifest is keyed by object key, so a portable seed cannot carry two rows for one object.",
    );
  }
}

/** Rule 2 is structural: assert nothing outside the allow-list was collected. */
function assertAllowListOnly(tables) {
  const collected = [...tables.keys()];
  const unexpected = collected.filter((table) => !EXPORTED_TABLES.includes(table));
  if (unexpected.length > 0 || collected.length !== EXPORTED_TABLES.length) {
    throw new Error(
      `The exporter collected ${collected.join(", ")}, which is not the catalog allow-list `
      + `${EXPORTED_TABLES.join(", ")}. A portable demo-store seed never reads any other table.`,
    );
  }
}

export function assertExportPreconditions(database, tables) {
  assertAllowListOnly(tables);
  assertNoReservedStock(tables);
  assertNoLiveCommerceReferences(database, tables);
  assertNoDanglingReferences(tables);
  assertMediaObjectKeys(tables);
}
