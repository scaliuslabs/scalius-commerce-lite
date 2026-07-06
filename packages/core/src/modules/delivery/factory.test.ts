import { describe, expect, it } from "vitest";

import { encryptCredentials } from "@scalius/core/utils/credential-encryption";
import type { DeliveryProviderRecord } from "@scalius/database/schema";
import { createProvider } from "./factory";

const credentialKey = Buffer.alloc(32, 23).toString("base64");
const otherCredentialKey = Buffer.alloc(32, 24).toString("base64");

const steadfastCredentials = JSON.stringify({
  baseUrl: "https://portal.steadfast.com.bd/api/v1",
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
});
