import { describe, expect, it, vi } from "vitest";

import {
  createD1PortabilityExecutor,
  createSqlitePortabilityManifest,
  createTursoPortabilityExecutor,
  type SqlitePortabilityExecutor,
  verifySqlitePortabilityManifests,
} from "../src/portability";

type Row = Record<string, unknown>;

const applicationSchema = [
  {
    type: "table",
    name: "products",
    tbl_name: "products",
    sql: "CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, image BLOB)",
  },
  {
    type: "index",
    name: "products_name_idx",
    tbl_name: "products",
    sql: "CREATE INDEX products_name_idx ON products (name)",
  },
  {
    type: "table",
    name: "memberships",
    tbl_name: "memberships",
    sql: "CREATE TABLE memberships (group_id TEXT, item_id TEXT, value INTEGER, PRIMARY KEY (group_id, item_id))",
  },
  {
    type: "table",
    name: "d1_migrations",
    tbl_name: "d1_migrations",
    sql: "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)",
  },
  {
    type: "table",
    name: "products_fts_data",
    tbl_name: "products_fts_data",
    sql: "CREATE TABLE products_fts_data (id INTEGER PRIMARY KEY, block BLOB)",
  },
  {
    type: "table",
    name: "__turso_internal_mvcc_meta",
    tbl_name: "__turso_internal_mvcc_meta",
    sql: "CREATE TABLE __turso_internal_mvcc_meta (key TEXT, value TEXT)",
  },
] as const;

const tableColumns: Record<string, Row[]> = {
  products: [
    { cid: 0, name: "id", pk: 1 },
    { cid: 1, name: "name", pk: 0 },
    { cid: 2, name: "image", pk: 0 },
  ],
  memberships: [
    { cid: 0, name: "group_id", pk: 1 },
    { cid: 1, name: "item_id", pk: 2 },
    { cid: 2, name: "value", pk: 0 },
  ],
};

function compareKey(left: readonly unknown[], right: readonly unknown[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    return String(left[index]).localeCompare(String(right[index]));
  }
  return 0;
}

function fakeExecutor(options: {
  schema?: readonly Row[];
  products?: Row[];
  memberships?: Row[];
} = {}): SqlitePortabilityExecutor {
  const rowsByTable: Record<string, Row[]> = {
    products: options.products ?? [
      { id: "prod_3", name: "Three", image: new Uint8Array([3]) },
      { id: "prod_1", name: "One", image: new Uint8Array([1]) },
      { id: "prod_2", name: "Two", image: new Uint8Array([2]) },
    ],
    memberships: options.memberships ?? [
      { group_id: "g2", item_id: "i1", value: 3 },
      { group_id: "g1", item_id: "i2", value: 2 },
      { group_id: "g1", item_id: "i1", value: 1 },
    ],
  };

  return {
    async query(sql, params = []) {
      if (sql.includes("FROM sqlite_schema")) {
        return options.schema ?? applicationSchema;
      }
      if (sql.startsWith("PRAGMA table_info")) {
        const table = /\("([^"]+)"\)/.exec(sql)?.[1];
        return table ? tableColumns[table] ?? [] : [];
      }
      if (
        sql.startsWith("PRAGMA foreign_key_list") ||
        sql.startsWith("PRAGMA index_list") ||
        sql.startsWith("PRAGMA index_xinfo")
      ) {
        return [];
      }

      const table = /FROM "([^"]+)"/.exec(sql)?.[1];
      if (!table) throw new Error(`Unexpected query: ${sql}`);
      const primaryKey = table === "memberships"
        ? ["group_id", "item_id"]
        : ["id"];
      const limit = Number(params.at(-1));
      const cursor = params.slice(0, -1);
      return [...(rowsByTable[table] ?? [])]
        .sort((left, right) =>
          compareKey(
            primaryKey.map((column) => left[column]),
            primaryKey.map((column) => right[column]),
          ),
        )
        .filter((row) =>
          cursor.length === 0 ||
          compareKey(primaryKey.map((column) => row[column]), cursor) > 0,
        )
        .slice(0, limit);
    },
  };
}

describe("SQLite portability manifests", () => {
  it("fingerprints schema and every row in deterministic primary-key order", async () => {
    const source = await createSqlitePortabilityManifest(fakeExecutor(), {
      chunkSize: 2,
    });
    const target = await createSqlitePortabilityManifest(
      fakeExecutor({
        schema: applicationSchema.map((object) => ({
          ...object,
          sql: `  ${object.sql.replaceAll(" ", "   ")}  `,
        })),
      }),
      { chunkSize: 2 },
    );

    expect(source.tables.map((table) => table.name)).toEqual([
      "memberships",
      "products",
    ]);
    expect(source.tables.map((table) => table.rowCount)).toEqual([3, 3]);
    expect(source.tables.map((table) => table.chunkCount)).toEqual([2, 2]);
    expect(source.fingerprint).toBe(target.fingerprint);
    expect(verifySqlitePortabilityManifests(source, target)).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("fails closed on a same-count content mismatch", async () => {
    const source = await createSqlitePortabilityManifest(fakeExecutor(), {
      chunkSize: 2,
    });
    const target = await createSqlitePortabilityManifest(
      fakeExecutor({
        products: [
          { id: "prod_1", name: "One", image: new Uint8Array([1]) },
          { id: "prod_2", name: "Changed", image: new Uint8Array([2]) },
          { id: "prod_3", name: "Three", image: new Uint8Array([3]) },
        ],
      }),
      { chunkSize: 2 },
    );

    const verification = verifySqlitePortabilityManifests(source, target);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toContain(
      "Content digest differs for table products.",
    );
    expect(verification.issues).not.toContain(
      expect.stringContaining("Row count differs"),
    );
  });

  it("treats WITHOUT ROWID as a provider-specific storage detail", async () => {
    const sourceSchema = applicationSchema.map((object) =>
      object.name === "memberships"
        ? { ...object, sql: `${object.sql} WITHOUT ROWID` }
        : object,
    );
    const source = await createSqlitePortabilityManifest(
      fakeExecutor({ schema: sourceSchema }),
      { chunkSize: 2 },
    );
    const target = await createSqlitePortabilityManifest(fakeExecutor(), {
      chunkSize: 2,
    });

    expect(source.schemaDigest).toBe(target.schemaDigest);
    expect(verifySqlitePortabilityManifests(source, target).ok).toBe(true);
  });
});

describe("SQLite portability executors", () => {
  it("adapts D1 without exposing provider metadata", async () => {
    const all = vi.fn(async () => ({ results: [{ answer: 42 }] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const executor = createD1PortabilityExecutor({ prepare } as unknown as D1Database);

    await expect(executor.query("SELECT ? AS answer", [42])).resolves.toEqual([
      { answer: 42 },
    ]);
    expect(bind).toHaveBeenCalledWith(42);
  });

  it("adapts and closes a Turso connection", async () => {
    const all = vi.fn(async () => [{ answer: 42 }]);
    const prepare = vi.fn(async () => ({ all }));
    const close = vi.fn(async () => undefined);
    const executor = createTursoPortabilityExecutor(
      { url: "https://merchant.turso.io", authToken: "token" },
      () => ({ prepare, close }) as never,
    );

    await expect(executor.query("SELECT ? AS answer", [42])).resolves.toEqual([
      { answer: 42 },
    ]);
    await executor.close?.();
    expect(all).toHaveBeenCalledWith([42]);
    expect(close).toHaveBeenCalledOnce();
  });
});
