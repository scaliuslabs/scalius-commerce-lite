import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptCredentials } from "@scalius/core/utils/credential-encryption";
import type { CourierRow } from "./port";
import { BUILT_IN_COURIER_PROVIDERS } from "./registry";
import { steadfastCourier } from "./steadfast";

const credentialKey = Buffer.alloc(32, 23).toString("base64");
const otherCredentialKey = Buffer.alloc(32, 24).toString("base64");

const steadfastCredentials = JSON.stringify({
  baseUrl: "https://portal.packzy.com/api/v1",
  apiKey: "steadfast-key",
  secretKey: "steadfast-secret",
});

const steadfastConfig = JSON.stringify({});

function providerRecord(credentials: string): CourierRow {
  return {
    id: "provider_steadfast",
    type: "steadfast",
    credentials,
    config: steadfastConfig,
    isActive: true,
    lastTestAttemptAt: null,
    lastTestSuccessAt: null,
    lastTestFailureAt: null,
    lastTestSuccessFingerprint: null,
  };
}

describe("built-in courier setup credential reads", () => {
  it("keeps legacy plaintext credentials readable", async () => {
    const setup = await steadfastCourier.setup(providerRecord(steadfastCredentials), undefined);

    expect(setup.settings?.credentials.apiKey).toBe("steadfast-key");
    expect(setup.error).toBeUndefined();
  });

  it("strict-reads encrypted credentials with CREDENTIAL_ENCRYPTION_KEY", async () => {
    const encryptedCredentials = await encryptCredentials(steadfastCredentials, credentialKey);

    const setup = await steadfastCourier.setup(providerRecord(encryptedCredentials), credentialKey);

    expect(setup.settings?.credentials.secretKey).toBe("steadfast-secret");
    expect(setup.fingerprint).toMatch(/^hmac-sha256:/);
  });

  it("fails closed when encrypted credentials cannot be read with the dedicated key", async () => {
    const encryptedCredentials = await encryptCredentials(steadfastCredentials, credentialKey);

    const setup = await steadfastCourier.setup(providerRecord(encryptedCredentials), otherCredentialKey);

    expect(setup).toMatchObject({ settings: null, unreadable: true });
    expect(setup.error).toContain("Delivery provider credentials could not be decrypted");
    expect(setup.readiness).toMatchObject({ status: "error", active: false });
  });

  it("does not use JWT_SECRET as a fallback for encrypted credentials", async () => {
    const encryptedCredentials = await encryptCredentials(steadfastCredentials, credentialKey);

    const setup = await steadfastCourier.setup(providerRecord(encryptedCredentials), undefined);

    expect(setup.settings).toBeNull();
    expect(setup.error).toContain("CREDENTIAL_ENCRYPTION_KEY");
  });

  describe("credentials that are not valid JSON", () => {
    // A V8 SyntaxError quotes the start of its input; for credentials that is the secret.
    const SECRET = "sk_live_TOPSECRETVALUE0123";
    const brokenPlaintext = '{"apiKey": ' + SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    afterEach(() => errorSpy.mockClear());

    it("neither returns nor logs the stored text (plaintext)", async () => {
      const setup = await steadfastCourier.setup(providerRecord(brokenPlaintext), undefined);
      const logged = JSON.stringify(errorSpy.mock.calls);
      expect(setup.settings).toBeNull();
      expect(setup.error).toContain("not valid JSON");
      expect(JSON.stringify(setup)).not.toContain(SECRET);
      expect(JSON.stringify(setup)).not.toContain("apiKey");
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("apiKey");
      // Masked metadata: the provider and the error's class.
      expect(logged).toContain("provider_steadfast");
      expect(logged).toContain("SyntaxError");
    });

    it("neither returns nor logs the decrypted text (encrypted)", async () => {
      const encrypted = await encryptCredentials(brokenPlaintext, credentialKey);
      const setup = await steadfastCourier.setup(providerRecord(encrypted), credentialKey);
      expect(setup.error).toContain("not valid JSON");
      expect(JSON.stringify(setup)).not.toContain(SECRET);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET);
    });

    it("does not quote an unreadable config either", async () => {
      const record = { ...providerRecord(steadfastCredentials), config: '{"webhook": ' + SECRET };
      const setup = await steadfastCourier.setup(record, undefined);
      expect(setup.error).toContain("not valid JSON");
      expect(JSON.stringify(setup)).not.toContain(SECRET);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET);
    });

    it("never resolves a type it does not know to a courier", () => {
      expect(BUILT_IN_COURIER_PROVIDERS.get("carrier-pigeon")).toBeUndefined();
      expect(() => BUILT_IN_COURIER_PROVIDERS.require("carrier-pigeon")).toThrow("Unsupported provider type: carrier-pigeon");
    });
  });
});
