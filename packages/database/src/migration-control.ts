export const DATABASE_MIGRATION_CHECKPOINT_VERSION =
  "scalius-database-migration/v1" as const;

export type PortableDatabaseProvider = "d1" | "turso" | "postgresql";

export type DatabaseMigrationPhase =
  | "planned"
  | "source_write_locked"
  | "source_exported"
  | "target_imported"
  | "verified"
  | "secrets_installed"
  | "worker_deployed"
  | "smoke_passed"
  | "complete"
  | "rolled_back";

export interface DatabaseMigrationEvidence {
  writeFenceSha256?: string;
  exportArtifactSha256?: string;
  sourceDataFingerprint?: string;
  targetDataFingerprint?: string;
  importReceiptSha256?: string;
  targetDatabaseRef?: string;
  secretVersionRef?: string;
  workerVersionRef?: string;
  smokeProofSha256?: string;
  rollbackProofSha256?: string;
}

export interface DatabaseMigrationCheckpoint {
  version: typeof DATABASE_MIGRATION_CHECKPOINT_VERSION;
  migrationId: string;
  sourceProvider: PortableDatabaseProvider;
  targetProvider: PortableDatabaseProvider;
  phase: DatabaseMigrationPhase;
  evidence: DatabaseMigrationEvidence;
}

export type DatabaseMigrationEvent =
  | { type: "lock_source"; writeFenceSha256: string }
  | {
      type: "record_export";
      exportArtifactSha256: string;
      sourceDataFingerprint: string;
    }
  | {
      type: "record_import";
      importReceiptSha256: string;
      targetDatabaseRef: string;
    }
  | { type: "verify_target"; targetDataFingerprint: string }
  | { type: "install_secrets"; secretVersionRef: string }
  | { type: "record_deployment"; workerVersionRef: string }
  | { type: "record_smoke"; smokeProofSha256: string }
  | { type: "complete_cutover" }
  | { type: "rollback"; rollbackProofSha256: string };

function requireOpaqueReference(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 200 ||
    /[\r\n\0]/.test(normalized)
  ) {
    throw new Error(`${label} must be a non-empty opaque reference.`);
  }
  return normalized;
}

function requireSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 hex digest.`);
  }
  return normalized;
}

function requireFingerprint(value: string, label: string): string {
  return requireSha256(value, label);
}

export function createDatabaseMigrationCheckpoint(input: {
  migrationId: string;
  sourceProvider: PortableDatabaseProvider;
  targetProvider: PortableDatabaseProvider;
}): DatabaseMigrationCheckpoint {
  if (input.sourceProvider === input.targetProvider) {
    throw new Error("Database migration source and target providers must differ.");
  }
  return {
    version: DATABASE_MIGRATION_CHECKPOINT_VERSION,
    migrationId: requireOpaqueReference(input.migrationId, "migrationId"),
    sourceProvider: input.sourceProvider,
    targetProvider: input.targetProvider,
    phase: "planned",
    evidence: {},
  };
}

function requirePhase(
  checkpoint: DatabaseMigrationCheckpoint,
  expected: DatabaseMigrationPhase,
  event: DatabaseMigrationEvent["type"],
): void {
  if (checkpoint.phase !== expected) {
    throw new Error(
      `Cannot ${event} while migration is ${checkpoint.phase}; expected ${expected}.`,
    );
  }
}

export function advanceDatabaseMigrationCheckpoint(
  checkpoint: DatabaseMigrationCheckpoint,
  event: DatabaseMigrationEvent,
): DatabaseMigrationCheckpoint {
  if (checkpoint.version !== DATABASE_MIGRATION_CHECKPOINT_VERSION) {
    throw new Error(`Unsupported database migration checkpoint ${checkpoint.version}.`);
  }
  const evidence = { ...checkpoint.evidence };
  let phase: DatabaseMigrationPhase;

  switch (event.type) {
    case "lock_source":
      requirePhase(checkpoint, "planned", event.type);
      evidence.writeFenceSha256 = requireSha256(
        event.writeFenceSha256,
        "writeFenceSha256",
      );
      phase = "source_write_locked";
      break;
    case "record_export":
      requirePhase(checkpoint, "source_write_locked", event.type);
      evidence.exportArtifactSha256 = requireSha256(
        event.exportArtifactSha256,
        "exportArtifactSha256",
      );
      evidence.sourceDataFingerprint = requireFingerprint(
        event.sourceDataFingerprint,
        "sourceDataFingerprint",
      );
      phase = "source_exported";
      break;
    case "record_import":
      requirePhase(checkpoint, "source_exported", event.type);
      evidence.importReceiptSha256 = requireSha256(
        event.importReceiptSha256,
        "importReceiptSha256",
      );
      evidence.targetDatabaseRef = requireOpaqueReference(
        event.targetDatabaseRef,
        "targetDatabaseRef",
      );
      phase = "target_imported";
      break;
    case "verify_target": {
      requirePhase(checkpoint, "target_imported", event.type);
      const targetFingerprint = requireFingerprint(
        event.targetDataFingerprint,
        "targetDataFingerprint",
      );
      if (targetFingerprint !== evidence.sourceDataFingerprint) {
        throw new Error(
          "Target data fingerprint does not match the write-fenced source export.",
        );
      }
      evidence.targetDataFingerprint = targetFingerprint;
      phase = "verified";
      break;
    }
    case "install_secrets":
      requirePhase(checkpoint, "verified", event.type);
      evidence.secretVersionRef = requireOpaqueReference(
        event.secretVersionRef,
        "secretVersionRef",
      );
      phase = "secrets_installed";
      break;
    case "record_deployment":
      requirePhase(checkpoint, "secrets_installed", event.type);
      evidence.workerVersionRef = requireOpaqueReference(
        event.workerVersionRef,
        "workerVersionRef",
      );
      phase = "worker_deployed";
      break;
    case "record_smoke":
      requirePhase(checkpoint, "worker_deployed", event.type);
      evidence.smokeProofSha256 = requireSha256(
        event.smokeProofSha256,
        "smokeProofSha256",
      );
      phase = "smoke_passed";
      break;
    case "complete_cutover":
      requirePhase(checkpoint, "smoke_passed", event.type);
      phase = "complete";
      break;
    case "rollback":
      if (
        checkpoint.phase === "planned" ||
        checkpoint.phase === "complete" ||
        checkpoint.phase === "rolled_back"
      ) {
        throw new Error(`Cannot rollback migration while it is ${checkpoint.phase}.`);
      }
      evidence.rollbackProofSha256 = requireSha256(
        event.rollbackProofSha256,
        "rollbackProofSha256",
      );
      phase = "rolled_back";
      break;
  }

  return { ...checkpoint, phase, evidence };
}

export function isDatabaseMigrationReadyForCutover(
  checkpoint: DatabaseMigrationCheckpoint,
): boolean {
  return checkpoint.phase === "smoke_passed" || checkpoint.phase === "complete";
}
