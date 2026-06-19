import { describe, expect, it, vi } from "vitest";
import {
  getFraudProvider,
  getFraudProviders,
  saveFraudProvider,
} from "./fraud-checker.service";

function selectableRows(rows: Array<Record<string, unknown>>) {
  return {
    get: vi.fn(async () => rows[0] ?? null),
    then: (
      resolve: (value: Array<Record<string, unknown>>) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
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
});
