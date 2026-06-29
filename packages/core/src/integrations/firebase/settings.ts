import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";

import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import {
  decryptCredentials,
  decryptCredentialsGraceful,
  encryptCredentials,
} from "../../utils/credential-encryption";

const FIREBASE_SETTINGS_CATEGORY = "firebase";
const FIREBASE_SERVICE_ACCOUNT_KEY = "service_account";
const ENCRYPTED_VALUE_PREFIX = "enc:";

interface FirebaseServiceAccount {
  client_email?: unknown;
  private_key?: unknown;
  project_id?: unknown;
}

export interface FirebaseServiceAccountReadiness {
  configured: boolean;
  error: string | null;
  source: "settings" | "env" | "none";
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

export async function readFirebaseServiceAccountJsonFromStoredValue(
  storedValue: string | null | undefined,
  encryptionKey?: string,
): Promise<string | undefined> {
  const trimmed = storedValue?.trim();
  if (!trimmed) return undefined;

  let plaintext: string | undefined;
  if (trimmed.startsWith(ENCRYPTED_VALUE_PREFIX)) {
    if (!encryptionKey) return undefined;
    try {
      plaintext = await decryptCredentials(
        trimmed.slice(ENCRYPTED_VALUE_PREFIX.length),
        encryptionKey,
      );
    } catch (error: unknown) {
      console.warn(
        "[Firebase] Failed to decrypt encrypted service account:",
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  } else {
    plaintext = await decryptCredentialsGraceful(trimmed, encryptionKey);
  }

  try {
    return normalizeFirebaseServiceAccountJson(plaintext);
  } catch (error: unknown) {
    console.warn(
      "[Firebase] Stored service account is not usable:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

export async function readFirebaseServiceAccountJson(
  db: Database,
  encryptionKey?: string,
): Promise<string | undefined> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, FIREBASE_SERVICE_ACCOUNT_KEY),
        eq(settings.category, FIREBASE_SETTINGS_CATEGORY),
      ),
    )
    .get();

  return readFirebaseServiceAccountJsonFromStoredValue(row?.value, encryptionKey);
}

export async function getFirebaseServiceAccountReadiness(
  db: Database,
  encryptionKey?: string,
  env?: Record<string, unknown>,
): Promise<FirebaseServiceAccountReadiness> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, FIREBASE_SERVICE_ACCOUNT_KEY),
        eq(settings.category, FIREBASE_SETTINGS_CATEGORY),
      ),
    )
    .get();
  const storedValue = row?.value?.trim();

  if (storedValue) {
    const serviceAccountJson = await readFirebaseServiceAccountJsonFromStoredValue(
      storedValue,
      encryptionKey,
    );
    return serviceAccountJson
      ? { configured: true, error: null, source: "settings" }
      : {
          configured: false,
          error:
            "Saved Firebase service account is not usable. Save a valid service account or disable admin push notifications.",
          source: "settings",
        };
  }

  const envValue = typeof env?.FIREBASE_SERVICE_ACCOUNT_CRED_JSON === "string"
    ? env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON.trim()
    : "";
  if (envValue) {
    try {
      normalizeFirebaseServiceAccountJson(envValue);
      return { configured: true, error: null, source: "env" };
    } catch {
      return {
        configured: false,
        error:
          "Firebase service account environment variable is not valid. Fix it or disable admin push notifications.",
        source: "env",
      };
    }
  }

  return {
    configured: false,
    error: "Configure Firebase service account credentials before enabling admin push notifications.",
    source: "none",
  };
}

export async function saveFirebaseServiceAccountJson(
  db: Database,
  value: string,
  encryptionKey?: string,
): Promise<void> {
  const normalized = normalizeFirebaseServiceAccountJson(value);
  if (!normalized) {
    await upsertFirebaseServiceAccountValue(db, "");
    return;
  }

  if (!encryptionKey) {
    throw new ServiceUnavailableError(
      "CREDENTIAL_ENCRYPTION_KEY is required to store Firebase credentials.",
    );
  }

  const encrypted = `${ENCRYPTED_VALUE_PREFIX}${await encryptCredentials(
    normalized,
    encryptionKey,
  )}`;
  await upsertFirebaseServiceAccountValue(db, encrypted);
}

async function upsertFirebaseServiceAccountValue(
  db: Database,
  value: string,
): Promise<void> {
  await db
    .insert(settings)
    .values({
      id: crypto.randomUUID(),
      category: FIREBASE_SETTINGS_CATEGORY,
      key: FIREBASE_SERVICE_ACCOUNT_KEY,
      value,
      type: "string",
    })
    .onConflictDoUpdate({
      target: [settings.key, settings.category],
      set: { value, updatedAt: sql`unixepoch()` },
    });
}
