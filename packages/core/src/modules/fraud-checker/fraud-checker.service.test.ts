import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  getFraudProvider,
  getFraudProviders,
  fraudLookup,
  fraudLookupWithActiveProvider,
  readRetiredFraudCheckers,
  replaceRetiredFraudChecker,
  saveFraudProvider,
  testFraudProvider,
} from "./fraud-checker.service";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { ProviderError } from "@scalius/shared/plugins/providers";

const KEY = Buffer.alloc(32, 11).toString("base64");
const APP_ID = "acme.radar:radar";

function fraudDb() {
  const harness = createSqliteD1Database();
  const insert = async (key: string, value: unknown, options: { plaintext?: boolean; updatedAt?: number } = {}) => {
    const json = JSON.stringify(value);
    harness.sqlite.prepare("INSERT INTO settings (id, key, value, type, category, updated_at) VALUES (?, ?, ?, 'json', 'fraud-checker', ?)")
      .run(`set_${key}`, key, options.plaintext ? json : await encryptCredentials(json, KEY), options.updatedAt ?? 1_700_000_000);
  };
  return { db: harness.db, sqlite: harness.sqlite, insert };
}

const answer = { riskLevel: "low" as const, phone: "+8801700000000", totalParcels: 3, delivered: 3, cancelled: 0 };

describe("fraud checker rows", () => {
  it("fails closed before writing without an encryption key", async () => {
    const { db } = fraudDb();
    await expect(saveFraudProvider(db, { name: "Acme Radar", isActive: true, providerType: APP_ID }, "")).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY is required");
    await expect(getFraudProviders(db, KEY)).resolves.toEqual([]);
  });

  it("saves a row that names an app provider, encrypted, and refuses anything else", async () => {
    const { db, sqlite } = fraudDb();
    const saved = await saveFraudProvider(db, { name: "Acme Radar", isActive: true, providerType: APP_ID }, KEY);
    expect(saved).toMatchObject({ name: "Acme Radar", isActive: true, providerType: APP_ID, retired: false });
    const stored = sqlite.prepare("SELECT value FROM settings WHERE category = 'fraud-checker'").get() as { value: string };
    expect(stored.value).not.toContain("Acme Radar");
    await expect(getFraudProvider(db, saved.id, KEY)).resolves.toEqual(saved);
    await expect(getFraudProvider(db, saved.id)).resolves.toBeNull();
    await expect(saveFraudProvider(db, { name: "Old", isActive: true, providerType: "fraudbd" }, KEY)).rejects.toBeInstanceOf(ValidationError);
    await expect(saveFraudProvider(db, { name: "Old", isActive: true, providerType: "acme.radar" }, KEY)).rejects.toBeInstanceOf(ValidationError);
  });

  it("reads a checker saved before the move as the Bangladesh pack's, and keeps its keys until the pack takes them", async () => {
    const { db, insert } = fraudDb();
    await insert("row_bd", { name: "FraudBD", apiUrl: "https://fraudbd.com/api/check-courier-info", apiKey: "fraudbd-key", apiSecret: "pw", userId: "user", isActive: true, providerType: "fraudbd" }, { updatedAt: 1_700_000_100 });
    await insert("row_custom", { name: "Legacy", apiUrl: "https://fraudchecker.link/api/v1/qc/", apiKey: "legacy-key", isActive: false }, { plaintext: true });
    await insert("row_gone", { name: "Gone", apiUrl: "https://x.example", apiKey: "k", isActive: false, providerType: "unknown" });

    await expect(getFraudProviders(db, KEY)).resolves.toEqual([
      { id: "row_bd", name: "FraudBD", isActive: true, providerType: "scalius.bangladesh:fraudbd", retired: true },
      { id: "row_custom", name: "Legacy", isActive: false, providerType: "scalius.bangladesh:fraudchecker", retired: true },
    ]);
    // Saving over it would lose its keys: activate the pack first.
    await expect(saveFraudProvider(db, { id: "row_bd", name: "FraudBD", isActive: false, providerType: "scalius.bangladesh:fraudbd" }, KEY))
      .rejects.toThrow("Activate it in Apps first");

    const inactive = { resolve: vi.fn(async () => ({ provider: null, issue: "Activate Bangladesh pack in Apps to use it." })) };
    await expect(fraudLookupWithActiveProvider(db, "+8801700000000", KEY, inactive as never)).resolves.toEqual({
      status: "unavailable", provider: "FraudBD", reason: "Activate Bangladesh pack in Apps to use it.",
    });
    expect(inactive.resolve).toHaveBeenCalledWith("fraud", "scalius.bangladesh:fraudbd");
    await expect(testFraudProvider(db, "row_bd", KEY, inactive as never)).resolves.toEqual({ success: false, message: "Activate Bangladesh pack in Apps to use it." });
  });

  it("hands a retired row's credentials over once, then rewrites it as the app's row", async () => {
    const { db, insert } = fraudDb();
    await insert("row_bd", { name: "FraudBD", apiUrl: "https://fraudbd.com/api/check-courier-info", apiKey: "fraudbd-key", apiSecret: "pw", userId: "user", isActive: true, providerType: "fraudbd" });
    await saveFraudProvider(db, { id: "row_app", name: "Acme Radar", isActive: false, providerType: APP_ID }, KEY);

    const [retired, ...others] = await readRetiredFraudCheckers(db, KEY);
    expect(others).toEqual([]);
    expect(retired).toMatchObject({
      id: "row_bd", type: "fraudbd", replacement: "scalius.bangladesh:fraudbd", isActive: true,
      values: { apiUrl: "https://fraudbd.com/api/check-courier-info", apiKey: "fraudbd-key", apiSecret: "pw", userId: "user" },
    });
    await expect(readRetiredFraudCheckers(db, Buffer.alloc(32, 12).toString("base64"))).resolves.toEqual([]);

    await expect(replaceRetiredFraudChecker(db, retired!, KEY)).resolves.toBe(true);
    await expect(replaceRetiredFraudChecker(db, retired!, KEY)).resolves.toBe(false);
    await expect(readRetiredFraudCheckers(db, KEY)).resolves.toEqual([]);
    await expect(getFraudProvider(db, "row_bd", KEY)).resolves.toEqual({ id: "row_bd", name: "FraudBD", isActive: true, providerType: "scalius.bangladesh:fraudbd", retired: false });
  });
});

describe("app fraud checkers", () => {
  const appRow = { id: "row_app", name: "Acme Radar", isActive: true, providerType: APP_ID, retired: false };

  it("looks up through the app the active row names", async () => {
    const check = vi.fn(async () => answer);
    const resolve = vi.fn(async () => ({ provider: { id: APP_ID, label: "Acme Radar", check }, issue: null }));

    await expect(fraudLookup(appRow, "+8801700000000", { resolve } as never)).resolves.toEqual({ status: "checked", check: answer });
    expect(resolve).toHaveBeenCalledWith("fraud", APP_ID);
    expect(check).toHaveBeenCalledWith({ phone: "+8801700000000" }, {});
  });

  it("never asks a checker about a buyer outside its countries (MARKETS-DESIGN step 3a)", async () => {
    const check = vi.fn(async () => answer);
    const bdOnly = { resolve: vi.fn(async () => ({ provider: { id: APP_ID, label: "Acme Radar", countries: ["BD"], check }, issue: null })) };
    await expect(fraudLookup(appRow, "+8801700000000", bdOnly as never, { countryCode: "IN" }))
      .resolves.toEqual({ status: "country_unsupported", provider: "Acme Radar", countryCode: "IN" });
    await expect(fraudLookup(appRow, "+14155552671", bdOnly as never))
      .resolves.toEqual({ status: "country_unsupported", provider: "Acme Radar", countryCode: "US" });
    expect(check).not.toHaveBeenCalled();
    await expect(fraudLookup(appRow, "+8801700000000", bdOnly as never, { countryCode: "BD" }))
      .resolves.toEqual({ status: "checked", check: answer });
  });

  it("says why when the app is not ready or cannot run here, and keeps the app's own error", async () => {
    const notReady = { resolve: async () => ({ provider: null, issue: "Activate Acme Radar in Apps to use it." }) };
    await expect(fraudLookup(appRow, "+8801700000000", notReady as never)).resolves.toEqual({ status: "unavailable", provider: "Acme Radar", reason: "Activate Acme Radar in Apps to use it." });
    await expect(fraudLookup(appRow, "+8801700000000")).resolves.toMatchObject({ status: "unavailable" });

    const declined = new ProviderError("declined", "Acme Radar has no history for this number.");
    const failing = { resolve: async () => ({ provider: { id: APP_ID, label: "Acme Radar", check: async () => { throw declined; } }, issue: null }) };
    await expect(fraudLookup(appRow, "+8801700000000", failing as never)).rejects.toThrow("Acme Radar has no history for this number.");
    await expect(fraudLookup(appRow, "+8801700000000", failing as never)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});
