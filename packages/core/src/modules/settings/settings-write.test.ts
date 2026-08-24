import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  safeBatch: vi.fn(),
  encryptCredentials: vi.fn(async (value: string) => `encrypted:${value}`),
}));

vi.mock("@scalius/database/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/database/client")>()),
  safeBatch: mocks.safeBatch,
}));

vi.mock("@scalius/core/utils/credential-encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/utils/credential-encryption")>()),
  encryptCredentials: mocks.encryptCredentials,
}));

import { saveSettingAggregate } from "./settings-write";

function createDatabase() {
  const statements: Array<Record<string, unknown>> = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn((conflict: Record<string, unknown>) => {
          const statement = { values, conflict };
          statements.push(statement);
          return statement;
        }),
      })),
    })),
  };
  return { db, statements };
}

describe("saveSettingAggregate", () => {
  beforeEach(() => {
    mocks.safeBatch.mockReset().mockResolvedValue([]);
    mocks.encryptCredentials.mockClear();
  });

  it("encrypts all secrets before submitting one atomic batch", async () => {
    const { db, statements } = createDatabase();

    await saveSettingAggregate(db as never, [
      { category: "stripe", key: "publishable_key", value: "pk_test_value" },
      { category: "stripe", key: "secret_key", value: "sk_test_value", encrypted: true },
      { category: "stripe", key: "enabled", value: "true" },
    ], "encryption-key");

    expect(mocks.encryptCredentials).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(3);
    expect(statements[1]?.values).toMatchObject({
      category: "stripe",
      key: "secret_key",
      value: "enc:encrypted:sk_test_value",
    });
    expect(mocks.safeBatch).toHaveBeenCalledOnce();
    expect(mocks.safeBatch).toHaveBeenCalledWith(db, statements);
  });

  it("fails before constructing database statements when encryption authority is missing", async () => {
    const { db } = createDatabase();

    await expect(saveSettingAggregate(db as never, [
      { category: "polar", key: "access_token", value: "secret", encrypted: true },
    ])).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY");

    expect(db.insert).not.toHaveBeenCalled();
    expect(mocks.safeBatch).not.toHaveBeenCalled();
  });

  it("rejects duplicate keys instead of relying on statement ordering", async () => {
    const { db } = createDatabase();

    await expect(saveSettingAggregate(db as never, [
      { category: "email", key: "provider", value: "resend" },
      { category: "email", key: "provider", value: "cloudflare" },
    ])).rejects.toThrow("Duplicate setting write");

    expect(mocks.safeBatch).not.toHaveBeenCalled();
  });
});
