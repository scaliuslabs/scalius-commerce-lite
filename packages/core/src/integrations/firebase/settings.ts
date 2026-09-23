import type { Database } from "@scalius/database/client";

import { ValidationError } from "@scalius/core/errors";
import {
  readiness,
  readinessIssue,
  type Readiness,
  type ReadinessIssue,
} from "@scalius/shared/readiness";
import { firebaseDocument } from "@scalius/core/modules/settings/documents";

interface FirebaseServiceAccount {
  client_email?: unknown;
  private_key?: unknown;
  project_id?: unknown;
}

/** Stable issue codes for the dashboard-managed Firebase service account. */
export const FIREBASE_READINESS_CODES = {
  unusable: "unusable_firebase_service_account",
  missing: "missing_firebase_service_account",
} as const;

/**
 * The shared readiness vocabulary plus the typed extra callers need: whether
 * a service account row exists at all.
 */
export interface FirebaseServiceAccountReadiness extends Readiness {
  /** The service account is dashboard-managed only; there is no env source. */
  source: "settings" | "none";
}

function firebaseReadiness(
  source: "settings" | "none",
  issue: ReadinessIssue | null,
): FirebaseServiceAccountReadiness {
  const value = issue ? readiness.incomplete([issue]) : readiness.ready();
  return { ...value, source };
}

function parseFirebaseServiceAccountJson(value: string): FirebaseServiceAccount {
  try {
    return JSON.parse(value) as FirebaseServiceAccount;
  } catch (error: unknown) {
    try {
      return JSON.parse(value.replace(/\n/g, "\\n")) as FirebaseServiceAccount;
    } catch {
      throw error;
    }
  }
}

export function normalizeFirebaseServiceAccountJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  let parsed: FirebaseServiceAccount;
  try {
    parsed = parseFirebaseServiceAccountJson(trimmed);
  } catch {
    throw new ValidationError("Invalid Service Account JSON");
  }

  if (
    typeof parsed.client_email !== "string" ||
    typeof parsed.private_key !== "string" ||
    typeof parsed.project_id !== "string" ||
    !parsed.client_email.trim() ||
    !parsed.private_key.trim() ||
    !parsed.project_id.trim()
  ) {
    throw new ValidationError(
      "Firebase service account JSON is missing required fields",
    );
  }

  return trimmed;
}

export interface StoredFirebaseSettings {
  /** Whether a service account is stored at all, readable or not. */
  serviceAccountStored: boolean;
  /** The usable, normalized service account JSON, if there is one. */
  serviceAccountJson: string | undefined;
  publicConfig: Record<string, unknown>;
}

/** One read for every Firebase caller: delivery, readiness, and the dashboard. */
export async function readFirebaseSettings(
  db: Database,
  encryptionKey?: string,
): Promise<StoredFirebaseSettings> {
  const stored = await firebaseDocument.readDetailed(db, { encryptionKey });
  const serviceAccountStored = Boolean(stored.value.serviceAccount)
    || Boolean(stored.secretErrors.serviceAccount);

  let serviceAccountJson: string | undefined;
  if (stored.value.serviceAccount) {
    try {
      serviceAccountJson =
        normalizeFirebaseServiceAccountJson(stored.value.serviceAccount) || undefined;
    } catch (error: unknown) {
      console.warn(
        "[Firebase] Stored service account is not usable:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return {
    serviceAccountStored,
    serviceAccountJson,
    publicConfig: stored.value.publicConfig,
  };
}

export async function readFirebaseServiceAccountJson(
  db: Database,
  encryptionKey?: string,
): Promise<string | undefined> {
  return (await readFirebaseSettings(db, encryptionKey)).serviceAccountJson;
}

export async function getFirebaseServiceAccountReadiness(
  db: Database,
  encryptionKey?: string,
): Promise<FirebaseServiceAccountReadiness> {
  const stored = await readFirebaseSettings(db, encryptionKey);

  if (stored.serviceAccountStored) {
    const serviceAccountJson = stored.serviceAccountJson;
    return serviceAccountJson
      ? firebaseReadiness("settings", null)
      : firebaseReadiness("settings", readinessIssue(
          FIREBASE_READINESS_CODES.unusable,
          "Saved Firebase service account is not usable. Save a valid service account or disable admin push notifications.",
        ));
  }

  return firebaseReadiness("none", readinessIssue(
    FIREBASE_READINESS_CODES.missing,
    "Configure Firebase service account credentials before enabling admin push notifications.",
  ));
}
