import { describe, expect, it, vi } from "vitest";
import {
  getFraudProvider,
  getFraudProviders,
  fraudLookup,
  saveFraudProvider,
} from "./fraud-checker.service";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";
import { ServiceUnavailableError } from "@scalius/core/errors";
import { ProviderError } from "@scalius/shared/plugins/providers";

function selectableRows(rows: Array<Record<string, unknown>>) {
  const selection = {
    get: vi.fn(async () => rows[0] ?? null),
    orderBy: vi.fn(() => selection),
    limit: vi.fn(() => selection),
    offset: vi.fn(() => selection),
    then: (
      resolve: (value: Array<Record<string, unknown>>) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
  return selection;
}

function createFraudDb(rows: Array<Record<string, unknown>> = []) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => selectableRows(rows)),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        writes.push(values);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        writes.push(values);
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
  };

  return { db, writes };
}

function credentialKey() {
  return Buffer.alloc(32, 11).toString("base64");
}

describe("fraud checker provider credential storage", () => {
  it("fails closed before writing provider secrets without an encryption key", async () => {
    const { db, writes } = createFraudDb();

    await expect(saveFraudProvider(db as never, {
      name: "FraudBD",
      apiUrl: "https://fraudbd.example/api",
      apiKey: "fraudbd-key",
      apiSecret: "fraudbd-password",
      userId: "merchant-user",
      isActive: true,
      providerType: "fraudbd",
    }, "")).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY is required");

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("encrypts provider JSON before insert and decrypts it for reads", async () => {
    const key = credentialKey();
    const { db, writes } = createFraudDb();

    const saved = await saveFraudProvider(db as never, {
      id: "provider_fraudbd",
      name: "FraudBD",
      apiUrl: "https://fraudbd.example/api",
      apiKey: "fraudbd-key",
      apiSecret: "fraudbd-password",
      userId: "merchant-user",
      isActive: true,
      providerType: "fraudbd",
    }, key);

    expect(saved.apiKey).toBe("fraudbd-key");
    expect(writes).toHaveLength(1);
    const storedValue = writes[0]?.value;
    expect(storedValue).toEqual(expect.any(String));
    expect(storedValue).not.toContain("fraudbd-key");
    expect(storedValue).not.toContain("fraudbd-password");
    expect(storedValue).toContain(":");

    const readDb = createFraudDb([{ key: "provider_fraudbd", value: storedValue }]).db;
    await expect(getFraudProvider(readDb as never, "provider_fraudbd", key)).resolves.toMatchObject({
      id: "provider_fraudbd",
      apiKey: "fraudbd-key",
      apiSecret: "fraudbd-password",
      userId: "merchant-user",
      providerType: "fraudbd",
    });
    await expect(getFraudProviders(readDb as never, key)).resolves.toHaveLength(1);
  });

  it("keeps legacy plaintext provider rows readable for migration", async () => {
    const legacyValue = JSON.stringify({
      name: "Legacy",
      apiUrl: "https://legacy.example/api",
      apiKey: "legacy-key",
      isActive: true,
      providerType: "default",
    });
    const { db } = createFraudDb([{ key: "provider_legacy", value: legacyValue }]);

    await expect(getFraudProvider(db as never, "provider_legacy", credentialKey())).resolves.toMatchObject({
      id: "provider_legacy",
      apiKey: "legacy-key",
    });
  });

  it("does not return encrypted providers without CREDENTIAL_ENCRYPTION_KEY", async () => {
    const key = credentialKey();
    const storedValue = await encryptCredentials(JSON.stringify({
      name: "FraudBD",
      apiUrl: "https://fraudbd.example/api",
      apiKey: "fraudbd-key",
      isActive: true,
      providerType: "fraudbd",
    }), key);
    const { db } = createFraudDb([{ key: "provider_fraudbd", value: storedValue }]);

    await expect(getFraudProvider(db as never, "provider_fraudbd")).resolves.toBeNull();
    await expect(getFraudProviders(db as never)).resolves.toEqual([]);
  });

  it("does not return encrypted providers when the credential key is wrong", async () => {
    const storedValue = await encryptCredentials(JSON.stringify({
      name: "FraudBD",
      apiUrl: "https://fraudbd.example/api",
      apiKey: "fraudbd-key",
      isActive: true,
      providerType: "fraudbd",
    }), credentialKey());
    const { db } = createFraudDb([{ key: "provider_fraudbd", value: storedValue }]);
    const wrongKey = Buffer.alloc(32, 12).toString("base64");

    await expect(getFraudProvider(db as never, "provider_fraudbd", wrongKey)).resolves.toBeNull();
    await expect(getFraudProviders(db as never, wrongKey)).resolves.toEqual([]);
  });

  it("rejects non-public provider URLs before storage or lookup dispatch", async () => {
    const { db, writes } = createFraudDb();

    await expect(saveFraudProvider(db as never, {
      name: "Unsafe",
      apiUrl: "https://127.0.0.1/check",
      apiKey: "merchant-key",
      isActive: false,
      providerType: "default",
    }, credentialKey())).rejects.toThrow("public HTTPS hostname");
    expect(writes).toHaveLength(0);

    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(fraudLookup({
      id: "legacy_unsafe",
      name: "Unsafe legacy row",
      apiUrl: "https://fraud.internal/check",
      apiKey: "merchant-key",
      isActive: true,
      providerType: "default",
    }, "+8801700000000")).rejects.toThrow("public HTTPS hostname");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

describe("app fraud checkers", () => {
  const APP_ID = "acme.radar:radar";
  const appRow = { id: "row_app", name: "Acme Radar", apiUrl: "", apiKey: "", isActive: true, providerType: APP_ID };
  const answer = { riskLevel: "low" as const, phone: "+8801700000000", totalParcels: 3, delivered: 3, cancelled: 0 };

  it("saves a row that names the app and no credentials", async () => {
    const { db, writes } = createFraudDb();
    const saved = await saveFraudProvider(db as never, {
      name: "Acme Radar",
      apiUrl: "https://ignored.example/api",
      apiKey: "ignored-key",
      isActive: true,
      providerType: APP_ID,
    }, credentialKey());

    expect(saved).toMatchObject({ name: "Acme Radar", apiUrl: "", apiKey: "", providerType: APP_ID, isActive: true });
    expect(String(writes[0]?.value)).not.toContain("ignored-key");
    await expect(saveFraudProvider(db as never, { ...appRow, providerType: "acme.radar" }, credentialKey()))
      .rejects.toThrow("public HTTPS");
  });

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
    // The order ships to India: not asked, and the reason says so.
    await expect(fraudLookup(appRow, "+8801700000000", bdOnly as never, { countryCode: "IN" }))
      .resolves.toEqual({ status: "country_unsupported", provider: "Acme Radar", countryCode: "IN" });
    // No order country: the phone's country decides.
    await expect(fraudLookup(appRow, "+14155552671", bdOnly as never))
      .resolves.toEqual({ status: "country_unsupported", provider: "Acme Radar", countryCode: "US" });
    expect(check).not.toHaveBeenCalled();
    await expect(fraudLookup(appRow, "+8801700000000", bdOnly as never, { countryCode: "BD" }))
      .resolves.toEqual({ status: "checked", check: answer });
  });

  it("fails closed when the app is not ready or cannot run here, and keeps the app's own error", async () => {
    const notReady = { resolve: async () => ({ provider: null, issue: "Activate Acme Radar in Apps to use it." }) };
    await expect(fraudLookup(appRow, "+8801700000000", notReady as never)).rejects.toThrow("Activate Acme Radar in Apps to use it.");
    await expect(fraudLookup(appRow, "+8801700000000")).rejects.toBeInstanceOf(ServiceUnavailableError);

    const declined = new ProviderError("declined", "Acme Radar has no history for this number.");
    const failing = { resolve: async () => ({ provider: { id: APP_ID, label: "Acme Radar", check: async () => { throw declined; } }, issue: null }) };
    await expect(fraudLookup(appRow, "+8801700000000", failing as never)).rejects.toThrow("Acme Radar has no history for this number.");
  });
});
