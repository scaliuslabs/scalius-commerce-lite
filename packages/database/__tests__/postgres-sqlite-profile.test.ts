import { describe, expect, it } from "vitest";

import {
  compileSqliteStatementForPostgres,
  normalizePostgresParameters,
  normalizePostgresResultObjects,
  normalizePostgresResultRows,
  POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL,
} from "../src/postgres-sqlite-profile";

describe("PostgreSQL SQLite-profile compiler", () => {
  it("numbers only real placeholders and preserves literals/comments", () => {
    const compiled = compileSqliteStatementForPostgres(
      "select ?, '?', `odd``name` from [items] -- ?\nwhere id = ? /* ? */",
      2,
    );

    expect(compiled.sql).toBe(
      "select $1, '?', \"odd`name\" from \"items\" -- ?\nwhere id = $2 /* ? */",
    );
    expect(compiled.parameterCount).toBe(2);
    expect(compiled.readOnly).toBe(true);
  });

  it("preserves indexed SQLite placeholders and rejects mixed styles", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT ?2, ?1, ?2, '?3' -- ?4\n",
      2,
    );

    expect(compiled.sql).toBe("SELECT $2, $1, $2, '?3' -- ?4\n");
    expect(compiled.parameterCount).toBe(2);
    expect(() => compileSqliteStatementForPostgres("SELECT ?, ?1", 1))
      .toThrow(/cannot mix/i);
    expect(() => compileSqliteStatementForPostgres("SELECT ?0", 0))
      .toThrow(/invalid/i);
  });

  it("maps binary SQLite IS operators without changing predicates or text", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT a IS b, a IS NOT 1, a IS ?1, a IS NOT max(b, 0), "
        + "a IS NULL, a IS NOT NULL, a IS DISTINCT FROM b, "
        + "'a IS b', \"IS\" -- a IS b\nFROM values_table",
      1,
    );

    expect(compiled.sql).toContain("a IS NOT DISTINCT FROM b");
    expect(compiled.sql).toContain("a IS DISTINCT FROM 1");
    expect(compiled.sql).toContain("a IS NOT DISTINCT FROM $1");
    expect(compiled.sql).toContain("a IS DISTINCT FROM max(b, 0)");
    expect(compiled.sql).toContain("a IS NULL");
    expect(compiled.sql).toContain("a IS NOT NULL");
    expect(compiled.sql).toContain("a IS DISTINCT FROM b");
    expect(compiled.sql).toContain("'a IS b', \"IS\" -- a IS b");
  });

  it("maps the intentional SQLite semantics used by application queries", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT group_concat(label, ' / ') FROM labels "
        + "WHERE active = true AND name LIKE ? AND CAST(json_extract(doc, '$.id') AS INTEGER) = ?",
      2,
    );

    expect(compiled.sql).toContain("string_agg(label, ' / ')");
    expect(compiled.sql).toContain("active = 1");
    expect(compiled.sql).toContain("name ILIKE $1");
    expect(compiled.sql).toContain("AS bigint) = $2");
  });

  it("keeps merchant epoch-day bucketing portable and timezone-independent", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT CAST((created_at + ?) / 86400 AS INTEGER) AS day FROM orders "
        + "GROUP BY CAST((created_at + ?) / 86400 AS INTEGER)",
      2,
    );

    expect(compiled.sql).toBe(
      "SELECT CAST((created_at + $1) / 86400 AS bigint) AS day FROM orders "
        + "GROUP BY CAST((created_at + $2) / 86400 AS bigint)",
    );
    expect(compiled.sql).not.toMatch(/time zone|strftime|datetime/i);
  });

  it("preserves mixed-case raw aliases and reconstructs named transport rows", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT value AS variantId, CAST(value AS INTEGER) AS stockVersion FROM source",
    );
    expect(compiled.sql).toBe(
      "SELECT value AS \"variantId\", CAST(value AS bigint) AS \"stockVersion\" FROM source",
    );
    expect(compileSqliteStatementForPostgres(
      "WITH source AS MATERIALIZED (SELECT CAST(value AS TEXT) AS label) SELECT label FROM source",
    ).sql).toContain("AS MATERIALIZED (SELECT CAST(value AS TEXT) AS label)");
    expect(normalizePostgresResultObjects(
      [["variant_1", "42"]],
      [
        { name: "variantId", dataTypeID: 25 },
        { name: "stockVersion", dataTypeID: 20 },
      ],
    )).toEqual([{ variantId: "variant_1", stockVersion: 42 }]);
  });

  it("namespaces SQLite json() so PostgreSQL cannot parse it as a type cast", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT json(config) = '{}' FROM promotions WHERE id = ?",
      1,
    );

    expect(compiled.sql).toBe(
      "SELECT scalius_compat.json_text(config) = '{}' FROM promotions WHERE id = $1",
    );
    expect(POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL).toContain(
      "FUNCTION scalius_compat.json_text",
    );
  });

  it("keeps checkout failure sentinels typed without rewriting literals", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT CASE WHEN ?1 = 1 THEN 1 ELSE json_extract('{}', 'CHECKOUT_FAILED') END, "
        + "'json_extract(''{}'', ''QUOTED'')'",
      1,
    );
    expect(compiled.sql).toContain(
      "ELSE scalius_compat.fail_bigint('CHECKOUT_FAILED') END",
    );
    expect(compiled.sql).toContain("'json_extract(''{}'', ''QUOTED'')'");
    expect(POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL).toContain(
      "FUNCTION scalius_compat.fail_bigint",
    );
    expect(POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL).toContain(
      "FUNCTION public.json_array_length(input_text text, json_path text)",
    );
  });

  it("preserves SQLite json_object value kinds through PostgreSQL jsonb", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT json_object('name', customer_name, 'quote', json_extract(payload, '$.quote'))",
    );
    expect(compiled.sql).toBe(
      "SELECT (jsonb_build_object('name', customer_name, 'quote', "
        + "scalius_compat.json_extract_jsonb(payload, '$.quote'))::text)",
    );
    expect(POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL).toContain(
      "FUNCTION scalius_compat.json_extract_jsonb",
    );
  });

  it("uses the explicit JSONB row fast path without changing SQLite SQL", () => {
    const compiled = compileSqliteStatementForPostgres(
      "SELECT json_extract(item.value, '$.id') FROM "
        + "json_each(?1, '$.items' /* scalius:postgres-jsonb */) AS item",
      1,
    );
    expect(compiled.sql).toContain(
      "scalius_compat.json_each_jsonb($1, '$.items' ) AS item",
    );
    expect(compiled.sql).toContain(
      "scalius_compat.json_scalar_text(jsonb_extract_path((item.value)::jsonb, 'id'))",
    );
    expect(POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL).toContain(
      "FUNCTION scalius_compat.json_each_jsonb",
    );
  });

  it("keeps portable table-valued cross-join predicates boolean on PostgreSQL", () => {
    const compiled = compileSqliteStatementForPostgres(
      `SELECT edge.value
         FROM orders AS checkout_order
         JOIN json_each(checkout_order.checkout_inventory_edges) AS edge ON 1 = 1
        WHERE checkout_order.notes = ?`,
      1,
    );

    expect(compiled.sql).toContain(
      "json_each(checkout_order.checkout_inventory_edges) AS edge ON 1 = 1",
    );
  });

  it("fails closed for malformed SQL and parameter drift", () => {
    expect(() => compileSqliteStatementForPostgres("select '?'", 1))
      .toThrow(/parameter count/i);
    expect(() => compileSqliteStatementForPostgres("select 'unterminated"))
      .toThrow(/unterminated/i);
    expect(() => compileSqliteStatementForPostgres("   "))
      .toThrow(/must not be empty/i);
  });

  it("normalizes only transport representations, never arbitrary text", () => {
    expect(normalizePostgresParameters([true, false, "1", 1])).toEqual([1, 0, "1", 1]);
    expect(normalizePostgresResultRows(
      [["42", "19.95", "0042"]],
      [{ dataTypeID: 20 }, { dataTypeID: 1700 }, { dataTypeID: 25 }],
    )).toEqual([[42, 19.95, "0042"]]);
    expect(() => normalizePostgresResultRows(
      [["9007199254740992"]],
      [{ dataTypeID: 20 }],
    )).toThrow(/safe range/i);
  });

  it("ships the exact JSON/time/changes compatibility surface", () => {
    for (const functionName of [
      "unixepoch",
      "instr",
      "json_valid",
      "json_extract",
      "json_type",
      "json_array_length",
      "json_each",
      "json_object",
      "datetime",
      "strftime",
      "changes",
      "max",
      "min",
    ]) {
      expect(POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL).toContain(
        `FUNCTION public.${functionName}`,
      );
    }
  });
});
