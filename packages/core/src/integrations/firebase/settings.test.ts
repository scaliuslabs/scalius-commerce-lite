import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getFirebaseServiceAccountReadiness,
  normalizeFirebaseServiceAccountJson,
  readFirebaseServiceAccountJsonFromStoredValue,
} from "./settings";

import { encodeEncryptedCredential, encryptCredentials } from "../../utils/credential-encryption";

const credentialKey = Buffer.alloc(32, 17).toString("base64");

const serviceAccountJson = JSON.stringify({
  client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
  project_id: "scalius-test",
});

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps legacy plaintext service accounts readable", async () => {
    await expect(
      readFirebaseServiceAccountJsonFromStoredValue(serviceAccountJson, credentialKey),
    ).resolves.toBe(serviceAccountJson);
  });

  it("reads encrypted service accounts with the credential encryption key only", async () => {
    const storedValue = encodeEncryptedCredential(
      await encryptCredentials(serviceAccountJson, credentialKey),
    );
    const otherKey = Buffer.alloc(32, 18).toString("base64");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      readFirebaseServiceAccountJsonFromStoredValue(storedValue, credentialKey),
    ).resolves.toBe(serviceAccountJson);
    await expect(
      readFirebaseServiceAccountJsonFromStoredValue(storedValue, otherKey),
    ).resolves.toBeUndefined();
    await expect(
      readFirebaseServiceAccountJsonFromStoredValue(storedValue),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not return unreadable encrypted service account ciphertext", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(() => normalizeFirebaseServiceAccountJson("{not json")).toThrow(
      "Invalid Service Account JSON",
    );
    expect(normalizeFirebaseServiceAccountJson("")).toBe("");
  });

  it("reports stored encrypted service account readiness", async () => {
    const storedValue = encodeEncryptedCredential(await encryptCredentials(serviceAccountJson, credentialKey));

    await expect(
      getFirebaseServiceAccountReadiness(
        createReadinessDb(storedValue) as never,
        credentialKey,
      ),
    ).resolves.toEqual({
      configured: true,
      error: null,
      source: "settings",
    });
  });

  it("fails readiness closed for unusable stored service accounts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

  it("reports no source when nothing is stored, even if a legacy env value is present", async () => {
    const previous = process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON;
    process.env.FIREBASE_SERVICE_ACCOUNT_CRED_JSON = serviceAccountJson;

    try {
      for (const stored of [null, "", "   "]) {
        await expect(
          getFirebaseServiceAccountReadiness(
            createReadinessDb(stored) as never,
            credentialKey,
          ),
        ).resolves.toEqual({
          configured: false,
          error: "Configure Firebase service account credentials before enabling admin push notifications.",
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
