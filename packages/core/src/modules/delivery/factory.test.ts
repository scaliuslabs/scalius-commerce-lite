import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptCredentials } from "@scalius/core/utils/credential-encryption";
import type { DeliveryProviderRecord } from "@scalius/database/schema";
import { createProvider } from "./factory";

const credentialKey = Buffer.alloc(32, 23).toString("base64");
const otherCredentialKey = Buffer.alloc(32, 24).toString("base64");

const steadfastCredentials = JSON.stringify({
  baseUrl: "https://portal.packzy.com/api/v1",
  apiKey: "steadfast-key",
  secretKey: "steadfast-secret",
});

const steadfastConfig = JSON.stringify({});

function providerRecord(credentials: string): DeliveryProviderRecord {
  return {
    id: "provider_steadfast",
    name: "Steadfast",
    type: "steadfast",
    credentials,
    config: steadfastConfig,
    isActive: true,
    lastTestAttemptAt: null,
    lastTestSuccessAt: null,
    lastTestFailureAt: null,
    lastTestSuccessFingerprint: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as DeliveryProviderRecord;
}

describe("delivery provider factory credential reads", () => {
  it("keeps legacy plaintext credentials readable", async () => {
    const provider = await createProvider(providerRecord(steadfastCredentials));

    expect(provider.getType()).toBe("steadfast");
  });

  it("strict-reads encrypted credentials with CREDENTIAL_ENCRYPTION_KEY", async () => {
    const encryptedCredentials = await encryptCredentials(
      steadfastCredentials,
      credentialKey,
    );

    const provider = await createProvider(
      providerRecord(encryptedCredentials),
      credentialKey,
    );

    expect(provider.getType()).toBe("steadfast");
  });

  it("fails closed when encrypted credentials cannot be read with the dedicated key", async () => {
    const encryptedCredentials = await encryptCredentials(
      steadfastCredentials,
      credentialKey,
    );

    await expect(
      createProvider(providerRecord(encryptedCredentials), otherCredentialKey),
    ).rejects.toThrow("Delivery provider credentials could not be decrypted");
  });

  it("does not use JWT_SECRET as a fallback for encrypted credentials", async () => {
    const encryptedCredentials = await encryptCredentials(
      steadfastCredentials,
      credentialKey,
    );

    await expect(
      createProvider(providerRecord(encryptedCredentials)),
    ).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY");
  });

  describe("credentials that are not valid JSON", () => {
    // A V8 SyntaxError quotes the start of its input; for credentials that is the secret.
    const SECRET = "sk_live_TOPSECRETVALUE0123";
    const brokenPlaintext = '{"apiKey": ' + SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    afterEach(() => errorSpy.mockClear());

    async function failure(record: DeliveryProviderRecord, key?: string): Promise<Error> {
      return createProvider(record, key).then(
        () => { throw new Error("expected createProvider to fail"); },
        (caught: unknown) => caught as Error,
      );
    }

    it("neither returns nor logs the stored text (plaintext)", async () => {
      const error = await failure(providerRecord(brokenPlaintext));
      const logged = JSON.stringify(errorSpy.mock.calls);
      expect(error.message).toContain("not valid JSON");
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain("apiKey");
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("apiKey");
      // Masked metadata: the provider and the error's class.
      expect(logged).toContain("provider_steadfast");
      expect(logged).toContain("SyntaxError");
    });

    it("neither returns nor logs the decrypted text (encrypted)", async () => {
      const encrypted = await encryptCredentials(brokenPlaintext, credentialKey);
      const error = await failure(providerRecord(encrypted), credentialKey);
      expect(error.message).toContain("not valid JSON");
      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET);
    });

    it("does not quote an unreadable config either", async () => {
      const record = { ...providerRecord(steadfastCredentials), config: '{"webhook": ' + SECRET } as DeliveryProviderRecord;
      const error = await failure(record);
      expect(error.message).toContain("not valid JSON");
      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET);
    });

    it("does not quote an error that is not one of this module's typed errors", async () => {
      // Pathao needs a database instance: its typed refusal is fixed text, an unknown constructor error is never repeated.
      const record = { ...providerRecord(steadfastCredentials), type: "pathao" } as DeliveryProviderRecord;
      const error = await failure(record);
      expect(error.message).toBe("Failed to create provider: PathaoProvider requires a database instance");
      const unsupported = await failure({ ...providerRecord(steadfastCredentials), type: "carrier-pigeon" } as unknown as DeliveryProviderRecord);
      expect(unsupported.message).toBe("Failed to create provider: Unsupported provider type: carrier-pigeon");
    });
  });
});
