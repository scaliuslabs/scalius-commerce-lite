import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "../../errors";
import type { AppProviders } from "../provider-port";
import {
  getActiveSmsProvider,
  getSmsProviderReadiness,
  SMS_READINESS_CODE,
  getSmsSettings,
  saveSmsSettings,
} from "./sms-settings";

/** Stores the SMS document exactly as given. */
function createSmsSettingsDb(document: Record<string, string> | null) {
  const harness = createSqliteD1Database();
  if (document) {
    harness.sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('sms', 'document', ?, 'json', 'sms')")
      .run(JSON.stringify(document));
  }
  return Object.assign(harness.db, { sqlite: harness.sqlite });
}

const APP_ID = "acme.texts:texts";
const appSend = vi.fn(async () => ({ success: true, providerRef: "app-1" }));
const appProvider = { id: APP_ID, label: "Acme Texts", send: appSend };

function apps(choice: { provider: typeof appProvider; issue: null } | { provider: null; issue: string }): AppProviders & { resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn(async () => choice) } as never;
}

afterEach(() => vi.restoreAllMocks());

describe("SMS settings", () => {
  it("reports no chosen gateway as not configured", async () => {
    await expect(getSmsProviderReadiness(createSmsSettingsDb(null))).resolves.toEqual({
      status: "incomplete",
      issues: [{ code: SMS_READINESS_CODE, message: "No active SMS provider selected" }],
      activeProvider: null,
    });
  });

  it("sends through the app provider the saved choice names, read again for every dispatch", async () => {
    const db = createSmsSettingsDb({ activeProvider: APP_ID });
    const lookup = apps({ provider: appProvider, issue: null });

    const provider = await getActiveSmsProvider(db, undefined, lookup);
    expect(lookup.resolve).toHaveBeenCalledWith("sms", APP_ID);
    await expect(provider!.send({ to: "+8801700000000", message: "Hi" }, {})).resolves.toEqual({ success: true, providerRef: "app-1" });
    await expect(getSmsProviderReadiness(db, undefined, lookup)).resolves.toEqual({ status: "ready", issues: [], activeProvider: APP_ID });
    await expect(getSmsSettings(db, undefined, lookup)).resolves.toEqual({ activeProvider: APP_ID, activeProviderConfigured: true, activeProviderError: null, revision: 1 });

    db.sqlite.exec("UPDATE settings SET value = json_set(value, '$.activeProvider', '') WHERE category = 'sms'");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(getActiveSmsProvider(db, undefined, lookup)).resolves.toBeNull();
  });

  it("fails closed when the chosen app is not ready, or no app can run here", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createSmsSettingsDb({ activeProvider: APP_ID });
    const notReady = apps({ provider: null, issue: "Acme Texts credentials could not be opened. Save them again in the app's settings." });

    await expect(getActiveSmsProvider(db, undefined, notReady)).resolves.toBeNull();
    await expect(getSmsProviderReadiness(db, undefined, notReady)).resolves.toEqual({
      status: "incomplete",
      issues: [{ code: SMS_READINESS_CODE, message: "Acme Texts credentials could not be opened. Save them again in the app's settings." }],
      activeProvider: APP_ID,
    });
    await expect(getActiveSmsProvider(db)).resolves.toBeNull();
    await expect(getSmsProviderReadiness(db)).resolves.toMatchObject({ status: "incomplete", activeProvider: APP_ID });
  });

  it("saves an app provider id as the choice and refuses anything else", async () => {
    const db = createSmsSettingsDb({ activeProvider: "" });
    await saveSmsSettings(db, { activeProvider: APP_ID }, undefined, { expectedRevision: 1 });
    await expect(getSmsSettings(db)).resolves.toMatchObject({ activeProvider: APP_ID, activeProviderConfigured: false, revision: 2 });
    const stored = db.sqlite.prepare("SELECT value FROM settings WHERE category = 'sms'").get() as { value: string };
    expect(JSON.parse(stored.value)).toEqual({ activeProvider: APP_ID });
    await expect(saveSmsSettings(db, { activeProvider: "acme.texts" })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveSmsSettings(db, { activeProvider: "bdbulksms" })).rejects.toBeInstanceOf(ValidationError);
  });
});
