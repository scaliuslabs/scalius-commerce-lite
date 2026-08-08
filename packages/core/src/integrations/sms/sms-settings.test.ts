import { describe, expect, it, vi } from "vitest";

import { encryptCredentials } from "../../utils/credential-encryption";
import { ValidationError } from "../../errors";
import {
  getActiveSmsProvider,
  getSmsProviderReadiness,
  getSmsSettings,
  saveSmsSettings,
} from "./sms-settings";

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
      { key: "gennet_base_url", value: "https://merchant.gennet.com.bd" },
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
      gennetBaseUrl: "https://merchant.gennet.com.bd",
      gennetSid: "SCALIUS",
    });
  });

  it("does not treat obvious placeholder SMS credentials as ready", async () => {
    await expect(getSmsProviderReadiness(createSmsSettingsDb([
      { key: "active_provider", value: "smsnetbd" },
      { key: "smsnetbd_api_key", value: "dummy" },
      { key: "smsnetbd_sender_id", value: "SCALIUS" },
    ]) as never)).resolves.toEqual({
      activeProvider: "smsnetbd",
      configured: false,
      error: "SMS.net.bd API key looks like a placeholder. Save a real provider value before enabling SMS.",
    });

    await expect(getSmsProviderReadiness(createSmsSettingsDb([
      { key: "active_provider", value: "gennet" },
      { key: "gennet_api_token", value: "realish-token-789" },
      { key: "gennet_base_url", value: "https://example.gennet.com.bd" },
      { key: "gennet_sid", value: "SCALIUS" },
    ]) as never)).resolves.toEqual({
      activeProvider: "gennet",
      configured: false,
      error: "GenNet base URL looks like a placeholder. Save a real provider value before enabling SMS.",
    });
  });

  it("rejects new placeholder SMS credentials before saving", async () => {
    await expect(saveSmsSettings({} as never, {
      activeProvider: "bdbulksms",
      bdbulksmsToken: "your-token-here",
    }, "credential-key")).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails before writes when changed secrets have no encryption key", async () => {
    const db = {
      insert: vi.fn(),
      batch: vi.fn(),
    };

    await expect(saveSmsSettings(db as never, {
      activeProvider: "bdbulksms",
      bdbulksmsToken: "merchant-token-4821",
    })).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY is required");
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("commits plaintext settings and encrypted secrets in one D1 batch", async () => {
    const statements: unknown[] = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => ({
          onConflictDoUpdate: vi.fn(() => {
            const statement = { values };
            statements.push(statement);
            return statement;
          }),
        })),
      })),
      batch: vi.fn(async (batch: unknown[]) => batch),
    };
    const key = Buffer.alloc(32, 11).toString("base64");

    await saveSmsSettings(db as never, {
      activeProvider: "gennet",
      gennetBaseUrl: "https://merchant.gennet.com.bd",
      gennetSid: "SCALIUS",
      gennetApiToken: "merchant-token-4821",
    }, key);

    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.batch).toHaveBeenCalledWith(statements);
    expect(statements).toHaveLength(4);
    const tokenWrite = statements
      .map((statement) => (statement as { values: Record<string, unknown> }).values)
      .find((values) => values.key === "gennet_api_token");
    expect(tokenWrite?.value).toEqual(expect.stringMatching(/^enc:/));
    expect(String(tokenWrite?.value)).not.toContain("merchant-token-4821");
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

  it("reads authoritative provider settings for every dispatch", async () => {
    const all = vi.fn().mockResolvedValue([
      { key: "active_provider", value: "bdbulksms" },
      { key: "bdbulksms_token", value: "live-token-123" },
    ]);
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ all }),
        }),
      }),
    };

    await expect(getActiveSmsProvider(db as never)).resolves.not.toBeNull();
    await expect(getActiveSmsProvider(db as never)).resolves.not.toBeNull();
    expect(all).toHaveBeenCalledTimes(2);
  });
});
