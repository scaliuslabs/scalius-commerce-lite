import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  FIREBASE_READINESS_CODES,
  getFirebaseServiceAccountReadiness,
  normalizeFirebaseServiceAccountJson,
  readFirebaseSettings,
} from "./settings";

import { encodeEncryptedCredential, encryptCredentials } from "../../utils/credential-encryption";

const credentialKey = Buffer.alloc(32, 17).toString("base64");

const serviceAccountJson = JSON.stringify({
  client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
  project_id: "scalius-test",
});

/** Stores the Firebase document with the service account exactly as given. */
function createReadinessDb(value: string | null) {
  const { db, sqlite } = createSqliteD1Database();
  if (value !== null) {
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('firebase', 'document', ?, 'json', 'firebase')")
      .run(JSON.stringify({ serviceAccount: value, publicConfig: {} }));
  }
  return db;
}

describe("Firebase credential settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads stored service accounts with the credential encryption key only", async () => {
    const storedValue = encodeEncryptedCredential(
      await encryptCredentials(serviceAccountJson, credentialKey),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(readFirebaseSettings(createReadinessDb(serviceAccountJson), credentialKey))
      .resolves.toMatchObject({ serviceAccountJson });
    await expect(readFirebaseSettings(createReadinessDb(storedValue), credentialKey))
      .resolves.toMatchObject({ serviceAccountStored: true, serviceAccountJson });
    await expect(readFirebaseSettings(createReadinessDb(storedValue), Buffer.alloc(32, 18).toString("base64")))
      .resolves.toMatchObject({ serviceAccountStored: true, serviceAccountJson: undefined });
    await expect(readFirebaseSettings(createReadinessDb(storedValue)))
      .resolves.toMatchObject({ serviceAccountStored: true, serviceAccountJson: undefined });
  });

  it("validates required Firebase service account fields", () => {
    expect(() => normalizeFirebaseServiceAccountJson("{\"project_id\":\"only\"}")).toThrow(
      "Firebase service account JSON is missing required fields",
    );
    expect(() => normalizeFirebaseServiceAccountJson("{not json")).toThrow(
      "Invalid Service Account JSON",
    );
    expect(normalizeFirebaseServiceAccountJson("")).toBe("");
  });

  it("reports stored encrypted service account readiness", async () => {
    const storedValue = encodeEncryptedCredential(await encryptCredentials(serviceAccountJson, credentialKey));

    await expect(
      getFirebaseServiceAccountReadiness(
        createReadinessDb(storedValue),
        credentialKey,
      ),
    ).resolves.toEqual({
      status: "ready",
      issues: [],
      source: "settings",
    });
  });

  it("fails readiness closed for unusable stored service accounts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      getFirebaseServiceAccountReadiness(
        createReadinessDb("enc:not-valid-aes-gcm"),
        credentialKey,
      ),
    ).resolves.toEqual({
      status: "incomplete",
      issues: [{
        code: FIREBASE_READINESS_CODES.unusable,
        message:
          "Saved Firebase service account is not usable. Save a valid service account or disable admin push notifications.",
      }],
      source: "settings",
    });
  });

  it("reports no source when nothing is stored, even if a legacy env value is present", async () => {
    const previous = process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON;
    process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON = serviceAccountJson;

    try {
      for (const stored of [null, "", "   "]) {
        await expect(
          getFirebaseServiceAccountReadiness(
            createReadinessDb(stored),
            credentialKey,
          ),
        ).resolves.toEqual({
          status: "incomplete",
          issues: [{
            code: FIREBASE_READINESS_CODES.missing,
            message: "Configure Firebase service account credentials before enabling admin push notifications.",
          }],
          source: "none",
        });
      }
    } finally {
      if (previous === undefined) {
        delete process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON;
      } else {
        process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON = previous;
      }
    }
  });
});
