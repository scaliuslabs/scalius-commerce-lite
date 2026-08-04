import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  assertPostgresMigrationLockResult,
  assertSourceArtifactUnchanged,
  assertStandaloneSqliteArtifact,
  buildAtomicTableCopySuffix,
  buildPostgresTableCopySql,
  buildPostgresFingerprintCopySql,
  buildInitialPostgresTargetSql,
  buildPostDataCompletionSql,
  buildPostgresMigrationControlSql,
  checkpointFromPostgresTargetState,
  derivePostgresMigrationId,
  encodePostgresCsvField,
  encodePostgresCsvRow,
  fingerprintCanonicalDatabase,
  fingerprintCanonicalRows,
  fingerprintPostgresFieldLines,
  readCanonicalPostgresTableNames,
  revalidateMigrationCheckpointTarget,
  SQLITE_TO_POSTGRES_CHECKPOINT_VERSION,
  validateCheckpoint,
  writePostgresCsvRows,
  type MigrationCheckpoint,
  type ExpectedMigration,
  type PostgresMigrationTargetReader,
  type PostgresTargetMigrationState,
  type SourceTable,
} from "../scripts/migrate-sqlite-to-postgres";
import {
  compileCanonicalPostgresSchema,
  POSTGRES_SCHEMA_BUNDLE_VERSION,
} from "../scripts/postgres-schema";

const sourceTables: readonly SourceTable[] = [
  {
    name: "parents",
    columns: [{ name: "id", type: "text" }],
    primaryKey: ["id"],
    rows: 1,
  },
  {
    name: "children",
    columns: [
      { name: "id", type: "text" },
      { name: "parent_id", type: "text" },
    ],
    primaryKey: ["id"],
    rows: 2,
  },
];

const sourceRows: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = {
  parents: [{ id: "parent" }],
  children: [
    { id: "child-a", parent_id: "parent" },
    { id: "child-b", parent_id: "parent" },
  ],
};

const sourceContent = fingerprintCanonicalDatabase(sourceTables.map((table) =>
  fingerprintCanonicalRows(table, sourceRows[table.name] ?? [])));
const sourceFingerprintByName = new Map(
  sourceContent.tables.map((table) => [table.name, table]),
);
const migrationId = "c".repeat(64);

function checkpoint(
  overrides: Partial<MigrationCheckpoint> = {},
): MigrationCheckpoint {
  return {
    version: SQLITE_TO_POSTGRES_CHECKPOINT_VERSION,
    migrationId,
    schemaVersion: POSTGRES_SCHEMA_BUNDLE_VERSION,
    schemaSha256: "a".repeat(64),
    sourceSha256: "b".repeat(64),
    sourceBytes: 123,
    databaseContentSha256: sourceContent.contentSha256,
    target: {
      host: "ep-example.ap-southeast-1.aws.neon.tech",
      port: "5432",
      database: "merchant_a",
      user: "neondb_owner",
    },
    phase: "complete",
    tables: sourceTables.map((table) => sourceFingerprintByName.get(table.name)!),
    ...overrides,
  };
}

function targetReader(
  rows: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = sourceRows,
): PostgresMigrationTargetReader {
  return {
    tableFingerprint: vi.fn(async (table: SourceTable) =>
      fingerprintCanonicalRows(table, rows[table.name] ?? [])),
    publicTables: vi.fn(() => 2),
    triggers: vi.fn(() => 3),
  };
}

function expectedMigration(): ExpectedMigration {
  const value = checkpoint();
  const { phase: _phase, tables: _tables, ...expected } = value;
  return expected;
}

function targetState(
  overrides: Partial<PostgresTargetMigrationState> = {},
): PostgresTargetMigrationState {
  return { ...checkpoint(), ...overrides };
}

describe("SQLite-to-PostgreSQL migration checkpoints", () => {
  it("rejects mutable SQLite sidecars instead of migrating an incomplete snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-migration-test-"));
    const source = join(directory, "source.sqlite3");
    try {
      await writeFile(source, "sqlite artifact", { mode: 0o600 });
      await writeFile(`${source}-wal`, "pending transaction", { mode: 0o600 });
      await expect(assertStandaloneSqliteArtifact(source)).rejects.toThrow(/wal sidecar/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detects same-size source mutation before declaring migration complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-migration-test-"));
    const source = join(directory, "source.sqlite3");
    try {
      await writeFile(source, "original", { mode: 0o600 });
      await expect(assertSourceArtifactUnchanged(
        source,
        8,
        "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5",
      )).resolves.toBeUndefined();
      await writeFile(`${source}-wal`, "", { mode: 0o600 });
      await writeFile(`${source}-shm`, "read-only sqlite state", { mode: 0o600 });
      await expect(assertSourceArtifactUnchanged(
        source,
        8,
        "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5",
      )).resolves.toBeUndefined();
      await writeFile(source, "mutation", { mode: 0o600 });
      await expect(assertSourceArtifactUnchanged(
        source,
        8,
        "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5",
      )).rejects.toThrow(/content changed/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds a checkpoint to the database even when the target host is unchanged", () => {
    const existing = checkpoint();
    const expected = {
      version: SQLITE_TO_POSTGRES_CHECKPOINT_VERSION,
      migrationId: existing.migrationId,
      schemaVersion: POSTGRES_SCHEMA_BUNDLE_VERSION,
      schemaSha256: existing.schemaSha256,
      sourceSha256: existing.sourceSha256,
      sourceBytes: existing.sourceBytes,
      databaseContentSha256: existing.databaseContentSha256,
      target: { ...existing.target, database: "merchant_b" },
    };

    expect(() => validateCheckpoint(existing, expected)).toThrow(
      /does not match this source\/schema\/target/i,
    );
  });

  it("revalidates every receipt and final catalog count for a completed checkpoint", async () => {
    const target = targetReader();

    await revalidateMigrationCheckpointTarget(
      checkpoint(),
      sourceTables,
      sourceContent,
      { applicationTables: 2, triggers: 3 },
      target,
    );

    expect(target.tableFingerprint).toHaveBeenCalledTimes(2);
    expect(target.tableFingerprint).toHaveBeenNthCalledWith(1, sourceTables[0]);
    expect(target.tableFingerprint).toHaveBeenNthCalledWith(2, sourceTables[1]);
    expect(target.publicTables).toHaveBeenCalledOnce();
    expect(target.triggers).toHaveBeenCalledOnce();
  });

  it("rejects a tampered receipt before accepting resumed work", async () => {
    const target = targetReader();
    const tampered = checkpoint({
      phase: "data",
      tables: [{ ...sourceFingerprintByName.get("parents")!, rows: 999 }],
    });

    await expect(revalidateMigrationCheckpointTarget(
      tampered,
      sourceTables,
      sourceContent,
      { applicationTables: 2, triggers: 3 },
      target,
    )).rejects.toThrow(/checkpoint content receipt differs for parents/i);
    expect(target.tableFingerprint).not.toHaveBeenCalled();
  });

  it("rejects a receipt when its target table data is missing", async () => {
    const target = targetReader({ ...sourceRows, parents: [] });

    await expect(revalidateMigrationCheckpointTarget(
      checkpoint(),
      sourceTables,
      sourceContent,
      { applicationTables: 2, triggers: 3 },
      target,
    )).rejects.toThrow(/postgresql content fingerprint differs for parents/i);
  });

  it("rejects a completed checkpoint with a missing table receipt", async () => {
    const target = targetReader();
    const incomplete = checkpoint({
      tables: [sourceFingerprintByName.get("parents")!],
    });

    await expect(revalidateMigrationCheckpointTarget(
      incomplete,
      sourceTables,
      sourceContent,
      { applicationTables: 2, triggers: 3 },
      target,
    )).rejects.toThrow(/completed postgresql checkpoint is missing table receipts/i);
  });

  it("rejects same-row-count target tampering", async () => {
    const target = targetReader({
      ...sourceRows,
      parents: [{ id: "tampered" }],
    });

    await expect(revalidateMigrationCheckpointTarget(
      checkpoint(),
      sourceTables,
      sourceContent,
      { applicationTables: 2, triggers: 3 },
      target,
    )).rejects.toThrow(/postgresql content fingerprint differs for parents/i);
  });
});

describe("SQLite-to-PostgreSQL crash-safe target control", () => {
  it("stores the complete migration identity in a dedicated non-public schema", () => {
    const expected = expectedMigration();
    const sql = buildPostgresMigrationControlSql(expected);
    const { migrationId: _migrationId, ...identity } = expected;
    const changedTarget = {
      ...identity,
      target: { ...identity.target, database: "merchant_b" },
    };

    expect(sql).toContain('CREATE SCHEMA "_scalius_migration"');
    expect(sql).toContain('REVOKE ALL ON SCHEMA "_scalius_migration" FROM PUBLIC');
    expect(sql).toContain(expected.migrationId);
    expect(sql).toContain(expected.sourceSha256);
    expect(sql).toContain(expected.schemaSha256);
    expect(derivePostgresMigrationId(identity)).not.toBe(
      derivePostgresMigrationId(changedTarget),
    );
  });

  it("rebuilds schema phase from the target after pre-data commit but before file checkpoint", () => {
    const staleExternal = checkpoint({ phase: "planned", tables: [] });
    const committedTarget = targetState({ phase: "schema", tables: [] });

    const rebuilt = checkpointFromPostgresTargetState(
      committedTarget,
      expectedMigration(),
    );

    expect(staleExternal.phase).toBe("planned");
    expect(rebuilt.phase).toBe("schema");
    expect(rebuilt.tables).toEqual([]);
  });

  it("leaves no target receipt when a crash interrupts COPY before its transaction suffix", () => {
    const receipt = sourceFingerprintByName.get("parents")!;
    const copySql = buildPostgresTableCopySql(sourceTables[0]!);
    const receiptSql = buildAtomicTableCopySuffix(receipt, migrationId);
    const rolledBackTarget = targetState({ phase: "schema", tables: [] });
    const rebuilt = checkpointFromPostgresTargetState(
      rolledBackTarget,
      expectedMigration(),
    );

    expect(copySql).toMatch(/^COPY /);
    expect(copySql).not.toContain("sqlite_to_postgres_receipts");
    expect(receiptSql.indexOf("sqlite_to_postgres_receipts"))
      .toBeLessThan(receiptSql.lastIndexOf("COMMIT;"));
    expect(rebuilt.phase).toBe("schema");
    expect(rebuilt.tables).toEqual([]);
  });

  it("recovers a committed COPY receipt after crash before file checkpoint", () => {
    const staleExternal = checkpoint({ phase: "schema", tables: [] });
    const receipt = sourceFingerprintByName.get("parents")!;
    const committedTarget = targetState({ phase: "data", tables: [receipt] });

    const rebuilt = checkpointFromPostgresTargetState(
      committedTarget,
      expectedMigration(),
    );

    expect(staleExternal.tables).toEqual([]);
    expect(rebuilt.phase).toBe("data");
    expect(rebuilt.tables).toEqual([receipt]);
  });

  it("recovers completion after post-data commit but before file checkpoint", () => {
    const staleExternal = checkpoint({ phase: "data" });
    const committedTarget = targetState({ phase: "complete" });
    const postData = ["BEGIN;", "CREATE INDEX sample_index ON parents (id);", "COMMIT;"]
      .join("\n");
    const sql = buildPostDataCompletionSql(postData, migrationId, sourceTables.length);

    const rebuilt = checkpointFromPostgresTargetState(
      committedTarget,
      expectedMigration(),
    );

    expect(staleExternal.phase).toBe("data");
    expect(rebuilt.phase).toBe("complete");
    expect(sql.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(sql).toContain("SET phase = 'complete'");
    expect(sql).toContain(") = 2");
  });

  it("refuses a same-target competing migration instead of waiting", () => {
    expect(() => assertPostgresMigrationLockResult("SCALIUS_BUSY"))
      .toThrow(/another sqlite-to-postgresql migration owns this target/i);
    expect(() => assertPostgresMigrationLockResult("SCALIUS_LOCKED")).not.toThrow();
  });

  it("rejects target-side receipt tampering even when the external file is stale", async () => {
    const target = targetReader();
    const tamperedTarget = targetState({
      phase: "data",
      tables: [{
        ...sourceFingerprintByName.get("parents")!,
        contentSha256: "d".repeat(64),
      }],
    });
    const rebuilt = checkpointFromPostgresTargetState(
      tamperedTarget,
      expectedMigration(),
    );

    await expect(revalidateMigrationCheckpointTarget(
      rebuilt,
      sourceTables,
      sourceContent,
      { applicationTables: 2, triggers: 3 },
      target,
    )).rejects.toThrow(/checkpoint content receipt differs for parents/i);
    expect(target.tableFingerprint).not.toHaveBeenCalled();
  });
});

describe("SQLite-to-PostgreSQL initial target SQL", () => {
  it("creates the schema before one FK-safe transaction truncates the full table set", () => {
    const preDataSql = [
      "BEGIN;",
      'CREATE TABLE "parents" ("id" text PRIMARY KEY);',
      'CREATE TABLE "children" (',
      '  "id" text PRIMARY KEY,',
      '  "parent_id" text REFERENCES "parents" ("id")',
      ");",
      "COMMIT;",
      "",
    ].join("\n");

    const sql = buildInitialPostgresTargetSql(
      preDataSql,
      ["parents", "children"],
      migrationId,
    );
    const truncate = 'TRUNCATE TABLE "children", "parents";';

    expect(sql.indexOf('CREATE TABLE "children"')).toBeLessThan(sql.indexOf(truncate));
    expect(sql.match(/\bTRUNCATE\s+TABLE\b/g)).toHaveLength(1);
    expect(sql.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(sql).toContain(truncate);
    expect(sql).toContain("SET phase = 'schema'");
    expect(sql).not.toContain('TRUNCATE TABLE "parents";');
    expect(sql).not.toContain('TRUNCATE TABLE "children";');
  });

  it("discovers and truncates every table in the current canonical bundle", async () => {
    const schema = await compileCanonicalPostgresSchema();
    const tableNames = readCanonicalPostgresTableNames(schema.preDataSql);
    const sql = buildInitialPostgresTargetSql(schema.preDataSql, tableNames, migrationId);
    const truncate = sql.match(/TRUNCATE TABLE ([^;]+);/)?.[1] ?? "";

    expect(tableNames).toHaveLength(schema.applicationTables);
    expect(truncate.split(", ")).toHaveLength(schema.applicationTables);
    expect(sql.match(/\bTRUNCATE\s+TABLE\b/g)).toHaveLength(1);
  });
});

describe("SQLite-to-PostgreSQL content fingerprints", () => {
  const typedTable: SourceTable = {
    name: "typed_values",
    columns: [
      { name: "id", type: "text" },
      { name: "null_text", type: "text" },
      { name: "empty_text", type: "text" },
      { name: "sentinel_text", type: "text" },
      { name: "rich_text", type: "text" },
      { name: "minimum", type: "integer" },
      { name: "maximum", type: "integer" },
      { name: "precise", type: "real" },
    ],
    primaryKey: ["id"],
    rows: 1,
  };

  function base64(value: string): string {
    return Buffer.from(value, "utf8").toString("base64");
  }

  function float8Hex(value: number): string {
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    return bytes.toString("hex");
  }

  it("matches PostgreSQL for null, empty, literal \\N, Unicode/newlines, int64, and REAL", async () => {
    const richText = "বাংলা 🛒\r\nsecond line\nthird line";
    const precise = 1.2345678901234567;
    const source = fingerprintCanonicalRows(typedTable, [{
      id: "row-1",
      null_text: null,
      empty_text: "",
      sentinel_text: "\\N",
      rich_text: richText,
      minimum: -9_223_372_036_854_775_808n,
      maximum: 9_223_372_036_854_775_807n,
      precise,
    }]);
    const target = await fingerprintPostgresFieldLines(typedTable, [
      `0\tS\t${base64("row-1")}`,
      "1\tN\t",
      "2\tS\t",
      `3\tS\t${base64("\\N")}`,
      `4\tS\t${base64(richText)}`,
      "5\tI\t-9223372036854775808",
      "6\tI\t9223372036854775807",
      `7\tR\t${float8Hex(precise)}`,
    ]);

    expect(target).toEqual(source);
  });

  it("matches SQLite primary-key null ordering in the PostgreSQL fingerprint stream", () => {
    const sql = buildPostgresFingerprintCopySql(typedTable);

    expect(sql).toContain('scalius_row."id" COLLATE "C" NULLS FIRST');
  });

  it("keeps null, empty text, and literal backslash-N distinct", () => {
    const table: SourceTable = {
      name: "framed_values",
      columns: [
        { name: "id", type: "text" },
        { name: "value", type: "text" },
      ],
      primaryKey: ["id"],
      rows: 1,
    };
    const hashes = [null, "", "\\N"].map((value) =>
      fingerprintCanonicalRows(table, [{ id: "same", value }]).contentSha256);

    expect(new Set(hashes).size).toBe(3);
  });

  it("frames table, column, row, and field boundaries against concatenation collisions", () => {
    const leftColumns: SourceTable = {
      name: "same_table",
      columns: [
        { name: "ab", type: "text" },
        { name: "c", type: "text" },
      ],
      primaryKey: ["ab"],
      rows: 1,
    };
    const rightColumns: SourceTable = {
      ...leftColumns,
      columns: [
        { name: "a", type: "text" },
        { name: "bc", type: "text" },
      ],
      primaryKey: ["a"],
    };
    const left = fingerprintCanonicalRows(leftColumns, [{ ab: "x", c: "yz" }]);
    const right = fingerprintCanonicalRows(rightColumns, [{ a: "xy", bc: "z" }]);
    const sameColumnsDifferentValueBoundary = fingerprintCanonicalRows(
      leftColumns,
      [{ ab: "xy", c: "z" }],
    );
    const digest = "11".repeat(32);
    const databaseLeft = fingerprintCanonicalDatabase([
      { name: "ab", rows: 0, contentSha256: digest },
      { name: "c", rows: 0, contentSha256: digest },
    ]);
    const databaseRight = fingerprintCanonicalDatabase([
      { name: "a", rows: 0, contentSha256: digest },
      { name: "bc", rows: 0, contentSha256: digest },
    ]);

    expect(right.contentSha256).not.toBe(left.contentSha256);
    expect(sameColumnsDifferentValueBoundary.contentSha256).not.toBe(left.contentSha256);
    expect(databaseRight.contentSha256).not.toBe(databaseLeft.contentSha256);
  });

  it("generates explicit typed fields and bytewise text-primary-key ordering", () => {
    const sql = buildPostgresFingerprintCopySql(typedTable);

    expect(sql).toContain('scalius_row."id" COLLATE "C"');
    expect(sql).toContain("replace(encode(convert_to(scalius_row.\"id\", 'UTF8'), 'base64')");
    expect(sql).toContain('scalius_row."minimum"::text');
    expect(sql).toContain('float8send(scalius_row."precise")');
    expect(sql).toContain("scalius_field.ordinal");
  });

  it("fingerprints large source and target streams without retaining row objects", async () => {
    const table: SourceTable = {
      name: "streamed",
      columns: [{ name: "id", type: "integer" }],
      primaryKey: ["id"],
      rows: 20_000,
    };
    function* reusedRows(): Iterable<Record<string, unknown>> {
      const row: Record<string, unknown> = { id: 0n };
      for (let id = 0n; id < 20_000n; id += 1n) {
        row.id = id;
        yield row;
      }
    }
    function* distinctRows(): Iterable<Record<string, unknown>> {
      for (let id = 0n; id < 20_000n; id += 1n) yield { id };
    }
    async function* targetLines(): AsyncIterable<string> {
      for (let id = 0n; id < 20_000n; id += 1n) yield `0\tI\t${id}`;
    }

    const expected = fingerprintCanonicalRows(table, distinctRows());
    expect(fingerprintCanonicalRows(table, reusedRows())).toEqual(expected);
    await expect(fingerprintPostgresFieldLines(table, targetLines()))
      .resolves.toEqual(expected);
  });
});

describe("SQLite-to-PostgreSQL COPY codec", () => {
  it("distinguishes null from literal backslash-N and quotes arbitrary text safely", () => {
    const columns = [
      "null_value",
      "null_sentinel_text",
      "empty",
      "quotes",
      "lines",
      "unicode",
      "backslashes",
    ];
    const encoded = encodePostgresCsvRow({
      null_value: null,
      null_sentinel_text: "\\N",
      empty: "",
      quotes: 'say "hello"',
      lines: "line 1\r\nline 2\nline 3",
      unicode: "বাংলা 🛒",
      backslashes: "C:\\catalog\\item",
    }, columns);

    expect(encoded).toBe([
      "",
      '"\\N"',
      '""',
      '"say ""hello"""',
      '"line 1\r\nline 2\nline 3"',
      '"বাংলা 🛒"',
      '"C:\\catalog\\item"',
    ].join(",") + "\n");
  });

  it("preserves signed 64-bit integers and round-trip-safe REAL text", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE values_to_copy (minimum INTEGER, maximum INTEGER, precise REAL)");
      database.prepare(
        "INSERT INTO values_to_copy (minimum, maximum, precise) VALUES (?, ?, ?)",
      ).run(
        -9_223_372_036_854_775_808n,
        9_223_372_036_854_775_807n,
        1.2345678901234567,
      );
      const statement = database.prepare(
        "SELECT minimum, maximum, precise FROM values_to_copy",
      );
      statement.setReadBigInts(true);
      const chunks: Buffer[] = [];
      const output = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });

      await writePostgresCsvRows(
        statement.iterate() as Iterable<Record<string, unknown>>,
        ["minimum", "maximum", "precise"],
        output,
      );

      expect(Buffer.concat(chunks).toString("utf8")).toBe(
        "-9223372036854775808,9223372036854775807,1.2345678901234567\n",
      );
      expect(encodePostgresCsvField(-0, "precise")).toBe("-0");
    } finally {
      database.close();
    }
  });

  it("rejects values PostgreSQL text COPY cannot preserve safely", () => {
    expect(() => encodePostgresCsvField("before\0after", "description"))
      .toThrow(/embedded NUL/i);
    expect(() => encodePostgresCsvField(new Uint8Array([1, 2]), "payload"))
      .toThrow(/unsupported BLOB/i);
    expect(() => encodePostgresCsvField(Number.POSITIVE_INFINITY, "weight"))
      .toThrow(/non-finite/i);
    expect(() => encodePostgresCsvField(Number.NaN, "weight"))
      .toThrow(/non-finite/i);
  });

  it("does not advance the SQLite row iterator while COPY applies backpressure", async () => {
    let iterated = 0;
    const pendingWrites: Array<() => void> = [];
    function* rows(): Iterable<Record<string, unknown>> {
      for (const id of [1n, 2n, 3n]) {
        iterated += 1;
        yield { id };
      }
    }
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        pendingWrites.push(callback);
      },
    });

    const writing = writePostgresCsvRows(rows(), ["id"], output);
    await vi.waitFor(() => expect(pendingWrites).toHaveLength(1));
    expect(iterated).toBe(1);

    pendingWrites.shift()!();
    await vi.waitFor(() => expect(pendingWrites).toHaveLength(1));
    expect(iterated).toBe(2);

    pendingWrites.shift()!();
    await vi.waitFor(() => expect(pendingWrites).toHaveLength(1));
    expect(iterated).toBe(3);

    pendingWrites.shift()!();
    await writing;
    expect(iterated).toBe(3);
  });
});
