import { describe, expect, it, vi } from "vitest";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { encryptCredentials } from "../../utils/credential-encryption";
import { ValidationError } from "../../errors";
import {
  getActiveSmsProvider,
  getSmsProviderReadiness,
  SMS_READINESS_CODE,
  getSmsSettings,
  saveSmsSettings,
} from "./sms-settings";

/** Stores the SMS document exactly as given (bypassing save-time validation). */
function createSmsSettingsDb(rows: Array<{ key: string; value: string }>) {
  const harness = createSqliteD1Database();
  if (rows.length > 0) {
    const document = Object.fromEntries(rows.map(({ key, value }) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]));
    harness.sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('sms', 'document', ?, 'json', 'sms')")
      .run(JSON.stringify(document));
  }
  return Object.assign(harness.db, { sqlite: harness.sqlite });
}

describe("SMS settings readiness", () => {
  it("reports no active provider as not configured", async () => {
    const result = await getSmsProviderReadiness(createSmsSettingsDb([]));

    expect(result).toEqual({
      status: "incomplete",
      issues: [{ code: SMS_READINESS_CODE, message: "No active SMS provider selected" }],
      activeProvider: null,
    });
  });

  it("reports missing active provider credentials", async () => {
    const result = await getSmsProviderReadiness(createSmsSettingsDb([
      { key: "active_provider", value: "bdbulksms" },
    ]));

    expect(result).toEqual({
      status: "incomplete",
      issues: [{ code: SMS_READINESS_CODE, message: "BDBulkSMS token is required" }],
      activeProvider: "bdbulksms",
    });
  });

  it("reports ready provider settings and masks configured secrets", async () => {
    const db = createSmsSettingsDb([
      { key: "active_provider", value: "gennet" },
      { key: "gennet_api_token", value: "token_123" },
      { key: "gennet_base_url", value: "https://merchant.gennet.com.bd" },
      { key: "gennet_sid", value: "SCALIUS" },
    ]);

    await expect(getSmsProviderReadiness(db)).resolves.toEqual({
      status: "ready",
      issues: [],
      activeProvider: "gennet",
    });
    await expect(getSmsSettings(db)).resolves.toMatchObject({
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
    ]))).resolves.toMatchObject({
      status: "incomplete",
      activeProvider: "smsnetbd",
      issues: [{ code: SMS_READINESS_CODE, message: "SMS.net.bd API key looks like a placeholder. Save a real provider value before enabling SMS." }],
    });

    await expect(getSmsProviderReadiness(createSmsSettingsDb([
      { key: "active_provider", value: "gennet" },
      { key: "gennet_api_token", value: "realish-token-789" },
      { key: "gennet_base_url", value: "https://example.gennet.com.bd" },
      { key: "gennet_sid", value: "SCALIUS" },
    ]))).resolves.toMatchObject({
      status: "incomplete",
      activeProvider: "gennet",
      issues: [{ code: SMS_READINESS_CODE, message: "GenNet base URL looks like a placeholder. Save a real provider value before enabling SMS." }],
    });
  });

  it("rejects new placeholder SMS credentials before saving", async () => {
    await expect(saveSmsSettings({} as never, {
      activeProvider: "bdbulksms",
      bdbulksmsToken: "your-token-here",
    }, "credential-key")).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails before writes when changed secrets have no encryption key", async () => {
    const db = createSmsSettingsDb([]);

    await expect(saveSmsSettings(db, {
      activeProvider: "bdbulksms",
      bdbulksmsToken: "merchant-token-4821",
    })).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY is required");
    expect(db.sqlite.prepare("SELECT count(*) AS count FROM settings").get()).toEqual({ count: 0 });
  });

  it("saves plaintext settings with encrypted secrets and keeps masked secrets unchanged", async () => {
    const db = createSmsSettingsDb([]);
    const key = Buffer.alloc(32, 11).toString("base64");

    await saveSmsSettings(db, {
      activeProvider: "gennet",
      gennetBaseUrl: "https://merchant.gennet.com.bd",
      gennetSid: "SCALIUS",
      gennetApiToken: "merchant-token-4821",
    }, key);
    const stored = () => JSON.parse(
      (db.sqlite.prepare("SELECT value FROM settings WHERE category = 'sms'").get() as { value: string }).value,
    ) as Record<string, string>;
    const token = stored().gennetApiToken;
    expect(token).toMatch(/^enc:/);
    expect(token).not.toContain("merchant-token-4821");

    await saveSmsSettings(db, { gennetApiToken: "••••••••••••", gennetSid: "SHOP" }, key);
    expect(stored()).toMatchObject({ gennetApiToken: token, gennetSid: "SHOP" });
    await expect(getSmsProviderReadiness(db, key)).resolves.toMatchObject({ status: "ready" });
  });

  it("does not treat encrypted secrets as ready when the credential key is unavailable", async () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encryptedToken = `enc:${await encryptCredentials("token_123", key)}`;
    const db = createSmsSettingsDb([
      { key: "active_provider", value: "bdbulksms" },
      { key: "bdbulksms_token", value: encryptedToken },
    ]);

    await expect(getSmsProviderReadiness(db)).resolves.toMatchObject({
      status: "incomplete",
      activeProvider: "bdbulksms",
      issues: [{ code: SMS_READINESS_CODE, message: "BDBulkSMS token is encrypted but CREDENTIAL_ENCRYPTION_KEY is not configured." }],
    });
    await expect(getSmsProviderReadiness(db, key)).resolves.toEqual({
      status: "ready",
      issues: [],
      activeProvider: "bdbulksms",
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

    await expect(getSmsProviderReadiness(db, wrongKey)).resolves.toMatchObject({
      status: "incomplete",
      activeProvider: "smsnetbd",
      issues: [{ code: SMS_READINESS_CODE, message: "SMS.net.bd API key could not be decrypted with the configured credential key." }],
    });
  });

  it("reads authoritative provider settings for every dispatch", async () => {
    const db = createSmsSettingsDb([
      { key: "active_provider", value: "bdbulksms" },
      { key: "bdbulksms_token", value: "live-token-123" },
    ]);

    await expect(getActiveSmsProvider(db)).resolves.not.toBeNull();
    db.sqlite.exec("UPDATE settings SET value = json_set(value, '$.activeProvider', '') WHERE category = 'sms'");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(getActiveSmsProvider(db)).resolves.toBeNull();
  });
});
