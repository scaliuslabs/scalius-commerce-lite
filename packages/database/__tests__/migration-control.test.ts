import { describe, expect, it } from "vitest";

import {
  advanceDatabaseMigrationCheckpoint,
  createDatabaseMigrationCheckpoint,
  isDatabaseMigrationReadyForCutover,
} from "../src/migration-control";

const digest = (character: string) => character.repeat(64);

describe("database migration checkpoint", () => {
  it("requires every durable proof before cutover", () => {
    let checkpoint = createDatabaseMigrationCheckpoint({
      migrationId: "migration_1",
      sourceProvider: "d1",
      targetProvider: "turso",
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "lock_source",
      writeFenceSha256: digest("1"),
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "record_export",
      exportArtifactSha256: digest("2"),
      sourceDataFingerprint: digest("a"),
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "record_import",
      importReceiptSha256: digest("3"),
      targetDatabaseRef: "turso-db-1",
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "verify_target",
      targetDataFingerprint: digest("a"),
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "install_secrets",
      secretVersionRef: "cloudflare-secret-version-1",
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "record_deployment",
      workerVersionRef: "worker-version-1",
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "record_smoke",
      smokeProofSha256: digest("4"),
    });

    expect(isDatabaseMigrationReadyForCutover(checkpoint)).toBe(true);
    expect(
      advanceDatabaseMigrationCheckpoint(checkpoint, {
        type: "complete_cutover",
      }).phase,
    ).toBe("complete");
  });

  it("refuses skipped phases and mismatched target data", () => {
    const planned = createDatabaseMigrationCheckpoint({
      migrationId: "migration_2",
      sourceProvider: "d1",
      targetProvider: "turso",
    });
    expect(() =>
      advanceDatabaseMigrationCheckpoint(planned, {
        type: "record_export",
        exportArtifactSha256: digest("2"),
        sourceDataFingerprint: digest("a"),
      }),
    ).toThrow(/expected source_write_locked/);

    let imported = advanceDatabaseMigrationCheckpoint(planned, {
      type: "lock_source",
      writeFenceSha256: digest("1"),
    });
    imported = advanceDatabaseMigrationCheckpoint(imported, {
      type: "record_export",
      exportArtifactSha256: digest("2"),
      sourceDataFingerprint: digest("a"),
    });
    imported = advanceDatabaseMigrationCheckpoint(imported, {
      type: "record_import",
      importReceiptSha256: digest("3"),
      targetDatabaseRef: "turso-db-2",
    });
    expect(() =>
      advanceDatabaseMigrationCheckpoint(imported, {
        type: "verify_target",
        targetDataFingerprint: digest("b"),
      }),
    ).toThrow(/does not match/);
  });

  it("records an explicit rollback instead of silently rewinding", () => {
    let checkpoint = createDatabaseMigrationCheckpoint({
      migrationId: "migration_3",
      sourceProvider: "d1",
      targetProvider: "turso",
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "lock_source",
      writeFenceSha256: digest("1"),
    });
    checkpoint = advanceDatabaseMigrationCheckpoint(checkpoint, {
      type: "rollback",
      rollbackProofSha256: digest("f"),
    });

    expect(checkpoint.phase).toBe("rolled_back");
    expect(checkpoint.evidence.rollbackProofSha256).toBe(digest("f"));
  });
});
