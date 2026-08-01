export const DATABASE_MIGRATION_CHECKPOINT_VERSION =
  "scalius-database-migration/v2" as const;

export type PortableDatabaseProvider = "d1" | "turso" | "postgresql";

export type DatabaseMigrationPhase =
  | "planned"
  | "source_write_locked"
  | "source_exported"
  | "artifact_prepared"
  | "target_imported"
  | "verified"
  | "secrets_installed"
  | "worker_deployed"
  | "smoke_passed"
  | "complete"
  | "rolled_back";

export interface DatabaseMigrationEvidence {
  writeFenceSha256?: string;
  sourceBookmark?: string;
  exportArtifactSha256?: string;
  exportArtifactBytes?: number;
  preparedArtifactSha256?: string;
  preparedArtifactBytes?: number;
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
  | {
      type: "lock_source";
      writeFenceSha256: string;
      sourceBookmark: string;
    }
  | {
      type: "record_export";
      exportArtifactSha256: string;
      exportArtifactBytes: number;
      exportBookmark: string;
    }
  | {
      type: "prepare_artifact";
      preparedArtifactSha256: string;
      preparedArtifactBytes: number;
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

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireMatchingEvidence(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(`Replayed migration event has different ${label}.`);
  }
}

function replayAlreadyAppliedEvent(
  checkpoint: DatabaseMigrationCheckpoint,
  event: DatabaseMigrationEvent,
): boolean {
  const evidence = checkpoint.evidence;
  switch (event.type) {
    case "lock_source":
      if (evidence.writeFenceSha256 === undefined) return false;
      requireMatchingEvidence(
        evidence.writeFenceSha256,
        requireSha256(event.writeFenceSha256, "writeFenceSha256"),
        "writeFenceSha256",
      );
      requireMatchingEvidence(
        evidence.sourceBookmark,
        requireOpaqueReference(event.sourceBookmark, "sourceBookmark"),
        "sourceBookmark",
      );
      return true;
    case "record_export":
      if (evidence.exportArtifactSha256 === undefined) return false;
      requireMatchingEvidence(
        evidence.exportArtifactSha256,
        requireSha256(event.exportArtifactSha256, "exportArtifactSha256"),
        "exportArtifactSha256",
      );
      requireMatchingEvidence(
        evidence.exportArtifactBytes,
        requireNonNegativeSafeInteger(
          event.exportArtifactBytes,
          "exportArtifactBytes",
        ),
        "exportArtifactBytes",
      );
      requireMatchingEvidence(
        evidence.sourceBookmark,
        requireOpaqueReference(event.exportBookmark, "exportBookmark"),
        "exportBookmark",
      );
      return true;
    case "prepare_artifact":
      if (evidence.preparedArtifactSha256 === undefined) return false;
      requireMatchingEvidence(
        evidence.preparedArtifactSha256,
        requireSha256(event.preparedArtifactSha256, "preparedArtifactSha256"),
        "preparedArtifactSha256",
      );
      requireMatchingEvidence(
        evidence.preparedArtifactBytes,
        requireNonNegativeSafeInteger(
          event.preparedArtifactBytes,
          "preparedArtifactBytes",
        ),
        "preparedArtifactBytes",
      );
      requireMatchingEvidence(
        evidence.sourceDataFingerprint,
        requireFingerprint(event.sourceDataFingerprint, "sourceDataFingerprint"),
        "sourceDataFingerprint",
      );
      return true;
    case "record_import":
      if (evidence.importReceiptSha256 === undefined) return false;
      requireMatchingEvidence(
        evidence.importReceiptSha256,
        requireSha256(event.importReceiptSha256, "importReceiptSha256"),
        "importReceiptSha256",
      );
      requireMatchingEvidence(
        evidence.targetDatabaseRef,
        requireOpaqueReference(event.targetDatabaseRef, "targetDatabaseRef"),
        "targetDatabaseRef",
      );
      return true;
    case "verify_target":
      if (evidence.targetDataFingerprint === undefined) return false;
      requireMatchingEvidence(
        evidence.targetDataFingerprint,
        requireFingerprint(event.targetDataFingerprint, "targetDataFingerprint"),
        "targetDataFingerprint",
      );
      return true;
    case "install_secrets":
      if (evidence.secretVersionRef === undefined) return false;
      requireMatchingEvidence(
        evidence.secretVersionRef,
        requireOpaqueReference(event.secretVersionRef, "secretVersionRef"),
        "secretVersionRef",
      );
      return true;
    case "record_deployment":
      if (evidence.workerVersionRef === undefined) return false;
      requireMatchingEvidence(
        evidence.workerVersionRef,
        requireOpaqueReference(event.workerVersionRef, "workerVersionRef"),
        "workerVersionRef",
      );
      return true;
    case "record_smoke":
      if (evidence.smokeProofSha256 === undefined) return false;
      requireMatchingEvidence(
        evidence.smokeProofSha256,
        requireSha256(event.smokeProofSha256, "smokeProofSha256"),
        "smokeProofSha256",
      );
      return true;
    case "complete_cutover":
      return checkpoint.phase === "complete";
    case "rollback":
      if (evidence.rollbackProofSha256 === undefined) return false;
      requireMatchingEvidence(
        evidence.rollbackProofSha256,
        requireSha256(event.rollbackProofSha256, "rollbackProofSha256"),
        "rollbackProofSha256",
      );
      return true;
  }
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
  if (replayAlreadyAppliedEvent(checkpoint, event)) return checkpoint;
  const evidence = { ...checkpoint.evidence };
  let phase: DatabaseMigrationPhase;

  switch (event.type) {
    case "lock_source":
      requirePhase(checkpoint, "planned", event.type);
      evidence.writeFenceSha256 = requireSha256(
        event.writeFenceSha256,
        "writeFenceSha256",
      );
      evidence.sourceBookmark = requireOpaqueReference(
        event.sourceBookmark,
        "sourceBookmark",
      );
      phase = "source_write_locked";
      break;
    case "record_export": {
      requirePhase(checkpoint, "source_write_locked", event.type);
      evidence.exportArtifactSha256 = requireSha256(
        event.exportArtifactSha256,
        "exportArtifactSha256",
      );
      evidence.exportArtifactBytes = requireNonNegativeSafeInteger(
        event.exportArtifactBytes,
        "exportArtifactBytes",
      );
      const exportBookmark = requireOpaqueReference(
        event.exportBookmark,
        "exportBookmark",
      );
      if (exportBookmark !== evidence.sourceBookmark) {
        throw new Error(
          "D1 export bookmark does not match the frozen source bookmark.",
        );
      }
      phase = "source_exported";
      break;
    }
    case "prepare_artifact":
      requirePhase(checkpoint, "source_exported", event.type);
      evidence.preparedArtifactSha256 = requireSha256(
        event.preparedArtifactSha256,
        "preparedArtifactSha256",
      );
      evidence.preparedArtifactBytes = requireNonNegativeSafeInteger(
        event.preparedArtifactBytes,
        "preparedArtifactBytes",
      );
      evidence.sourceDataFingerprint = requireFingerprint(
        event.sourceDataFingerprint,
        "sourceDataFingerprint",
      );
      phase = "artifact_prepared";
      break;
    case "record_import":
      requirePhase(checkpoint, "artifact_prepared", event.type);
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
