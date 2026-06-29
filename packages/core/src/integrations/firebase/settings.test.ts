import { describe, expect, it, vi } from "vitest";

import {
  getFirebaseServiceAccountReadiness,
  normalizeFirebaseServiceAccountJson,
  readFirebaseServiceAccountJsonFromStoredValue,
  saveFirebaseServiceAccountJson,
} from "./settings";

const credentialKey = Buffer.alloc(32, 17).toString("base64");

const serviceAccountJson = JSON.stringify({
  client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
  project_id: "scalius-test",
});

function createDb() {
  let storedValue = "";
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((row: { value: string }) => ({
        onConflictDoUpdate: vi.fn(async () => {
          storedValue = row.value;
        }),
      })),
    })),
  };

  return {
    db,
    getStoredValue: () => storedValue,
  };
}

function createReadinessDb(value: string | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => value === null ? undefined : { value }),
        })),
      })),
    })),
  };
}

describe("Firebase credential settings", () => {
  it("stores service account JSON with an encrypted sentinel", async () => {
    const { db, getStoredValue } = createDb();

    await saveFirebaseServiceAccountJson(db as never, serviceAccountJson, credentialKey);

    const storedValue = getStoredValue();
    expect(storedValue).toMatch(/^enc:/);
    expect(storedValue).not.toContain("private_key");
    await expect(
      readFirebaseServiceAccountJsonFromStoredValue(storedValue, credentialKey),
    ).resolves.toBe(serviceAccountJson);
  });

  it("fails closed when saving a non-empty service account without an encryption key", async () => {
    const { db } = createDb();

    await expect(
      saveFirebaseServiceAccountJson(db as never, serviceAccountJson),
    ).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY is required");
  });

  it("keeps legacy plaintext service accounts readable", async () => {
    await expect(
      readFirebaseServiceAccountJsonFromStoredValue(serviceAccountJson, credentialKey),
    ).resolves.toBe(serviceAccountJson);
  });

  it("does not return unreadable encrypted service account ciphertext", async () => {
    await expect(
      readFirebaseServiceAccountJsonFromStoredValue("enc:not-valid-aes-gcm", credentialKey),
    ).resolves.toBeUndefined();
    await expect(
      readFirebaseServiceAccountJsonFromStoredValue("enc:not-decrypted-without-key"),
    ).resolves.toBeUndefined();
  });

  it("validates required Firebase service account fields", () => {
    expect(() => normalizeFirebaseServiceAccountJson("{\"project_id\":\"only\"}")).toThrow(
      "Firebase service account JSON is missing required fields",
    );
  });

  it("reports stored encrypted service account readiness", async () => {
    const { db, getStoredValue } = createDb();
    await saveFirebaseServiceAccountJson(db as never, serviceAccountJson, credentialKey);

    await expect(
      getFirebaseServiceAccountReadiness(
        createReadinessDb(getStoredValue()) as never,
        credentialKey,
      ),
    ).resolves.toEqual({
      configured: true,
      error: null,
      source: "settings",
    });
  });

  it("fails readiness closed for unusable stored service accounts", async () => {
    await expect(
      getFirebaseServiceAccountReadiness(
        createReadinessDb("enc:not-valid-aes-gcm") as never,
        credentialKey,
      ),
    ).resolves.toEqual({
      configured: false,
      error:
        "Saved Firebase service account is not usable. Save a valid service account or disable admin push notifications.",
      source: "settings",
    });
  });

  it("falls back to a valid environment service account when no stored value exists", async () => {
    await expect(
      getFirebaseServiceAccountReadiness(
        createReadinessDb(null) as never,
        credentialKey,
        { FIREBASE_SERVICE_ACCOUNT_CRED_JSON: serviceAccountJson },
      ),
    ).resolves.toEqual({
      configured: true,
      error: null,
      source: "env",
    });
  });
});
