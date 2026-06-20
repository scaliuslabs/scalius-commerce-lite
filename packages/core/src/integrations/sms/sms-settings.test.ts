import { describe, expect, it } from "vitest";

import { encryptCredentials } from "../../utils/credential-encryption";
import { getSmsProviderReadiness, getSmsSettings } from "./sms-settings";

function createSmsSettingsDb(rows: Array<{ key: string; value: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          all: async () => rows,
        }),
      }),
    }),
  };
}

describe("SMS settings readiness", () => {
  it("reports no active provider as not configured", async () => {
    const result = await getSmsProviderReadiness(createSmsSettingsDb([]) as never);

    expect(result).toEqual({
      activeProvider: null,
      configured: false,
      error: "No active SMS provider selected",
    });
  });

  it("reports missing active provider credentials", async () => {
    const result = await getSmsProviderReadiness(createSmsSettingsDb([
      { key: "active_provider", value: "bdbulksms" },
    ]) as never);

    expect(result).toEqual({
      activeProvider: "bdbulksms",
      configured: false,
      error: "BDBulkSMS token is required",
    });
  });

  it("reports ready provider settings and masks configured secrets", async () => {
    const db = createSmsSettingsDb([
      { key: "active_provider", value: "gennet" },
      { key: "gennet_api_token", value: "token_123" },
      { key: "gennet_base_url", value: "https://example.gennet.com.bd" },
      { key: "gennet_sid", value: "SCALIUS" },
    ]);

    await expect(getSmsProviderReadiness(db as never)).resolves.toEqual({
      activeProvider: "gennet",
      configured: true,
      error: null,
    });
    await expect(getSmsSettings(db as never)).resolves.toMatchObject({
      activeProvider: "gennet",
      activeProviderConfigured: true,
      activeProviderError: null,
      gennetApiToken: "••••••••••••",
      gennetBaseUrl: "https://example.gennet.com.bd",
      gennetSid: "SCALIUS",
    });
  });

  it("does not treat encrypted secrets as ready when the credential key is unavailable", async () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encryptedToken = `enc:${await encryptCredentials("token_123", key)}`;
    const db = createSmsSettingsDb([
      { key: "active_provider", value: "bdbulksms" },
      { key: "bdbulksms_token", value: encryptedToken },
    ]);

    await expect(getSmsProviderReadiness(db as never)).resolves.toEqual({
      activeProvider: "bdbulksms",
      configured: false,
      error: "BDBulkSMS token is encrypted but CREDENTIAL_ENCRYPTION_KEY is not configured.",
    });
    await expect(getSmsProviderReadiness(db as never, key)).resolves.toEqual({
      activeProvider: "bdbulksms",
      configured: true,
      error: null,
    });
  });

  it("does not treat encrypted secrets as ready when the credential key is wrong", async () => {
    const key = Buffer.alloc(32, 8).toString("base64");
    const wrongKey = Buffer.alloc(32, 9).toString("base64");
    const db = createSmsSettingsDb([
      { key: "active_provider", value: "smsnetbd" },
      { key: "smsnetbd_api_key", value: `enc:${await encryptCredentials("api_key_123", key)}` },
      { key: "smsnetbd_sender_id", value: "SCALIUS" },
    ]);

    await expect(getSmsProviderReadiness(db as never, wrongKey)).resolves.toEqual({
      activeProvider: "smsnetbd",
      configured: false,
      error: "SMS.net.bd API key could not be decrypted with the configured credential key.",
    });
  });
});
