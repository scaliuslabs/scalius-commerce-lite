import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  decryptCredentialsGraceful: vi.fn(async (value: string) => value),
  getEncryptionKey: vi.fn(() => "test-key"),
}));

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@scalius/core/utils/credential-encryption", () => ({
  decryptCredentialsGraceful: mocks.decryptCredentialsGraceful,
}));

vi.mock("../utils/encryption-key", () => ({
  getEncryptionKey: mocks.getEncryptionKey,
}));

import { verifyDeliveryWebhook } from "./webhook-auth";

function createDb(
  provider: Record<string, unknown> | Record<string, unknown>[] | null,
  captures?: { where?: unknown[]; orderBy?: unknown[] },
) {
  const rows = Array.isArray(provider) ? provider : provider ? [provider] : [];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          captures?.where?.push(condition);
          return {
            orderBy: vi.fn((...orderBy: unknown[]) => {
              captures?.orderBy?.push(...orderBy);
              return {
                limit: vi.fn(async () => rows.slice(0, 2)),
              };
            }),
          };
        }),
      })),
    })),
  };
}

describe("delivery webhook auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects malformed provider credential JSON instead of throwing", async () => {
    mocks.getDb.mockReturnValue(createDb({
      id: "provider_pathao",
      type: "pathao",
      credentials: "{not-json",
      config: "{}",
    }));

    await expect(verifyDeliveryWebhook(
      {} as Env,
      "pathao",
      new Request("https://api.example.test/webhook", { method: "POST" }),
      "{}",
    )).resolves.toMatchObject({
      verified: false,
      reason: "Invalid provider credentials",
    });
  });

  it("rejects malformed provider config JSON instead of throwing", async () => {
    mocks.getDb.mockReturnValue(createDb({
      id: "provider_pathao",
      type: "pathao",
      credentials: JSON.stringify({ webhookSecret: "secret" }),
      config: "{not-json",
    }));

    await expect(verifyDeliveryWebhook(
      {} as Env,
      "pathao",
      new Request("https://api.example.test/webhook", { method: "POST" }),
      "{}",
    )).resolves.toMatchObject({
      verified: false,
      reason: "Invalid provider config",
    });
  });

  it("rejects unsigned Pathao requests with valid stored credentials", async () => {
    mocks.getDb.mockReturnValue(createDb({
      id: "provider_pathao",
      type: "pathao",
      credentials: JSON.stringify({ webhookSecret: "secret" }),
      config: "{}",
    }));

    await expect(verifyDeliveryWebhook(
      {} as Env,
      "pathao",
      new Request("https://api.example.test/webhook", { method: "POST" }),
      "{}",
    )).resolves.toMatchObject({
      verified: false,
      reason: "Missing X-PATHAO-Signature header",
    });
  });

  it("looks up only active providers when verifying webhook credentials", async () => {
    const captures: { where: unknown[]; orderBy: unknown[] } = { where: [], orderBy: [] };
    mocks.getDb.mockReturnValue(createDb(null, captures));

    const result = await verifyDeliveryWebhook(
      {} as Env,
      "pathao",
      new Request("https://api.example.test/webhook", { method: "POST" }),
      "{}",
    );

    expect(result).toMatchObject({
      verified: false,
      providerId: null,
      reason: "Provider not configured",
    });
    const dialect = new SQLiteSyncDialect();
    const query = dialect.sqlToQuery(captures.where[0] as never);
    expect(query.sql).toContain('"delivery_providers"."type" = ?');
    expect(query.sql).toContain('"delivery_providers"."is_active" = ?');
    expect(query.params).toEqual(["pathao", 1]);
    expect(captures.orderBy).toHaveLength(1);
  });

  it("fails closed when multiple active providers of the same type exist", async () => {
    mocks.getDb.mockReturnValue(createDb([
      {
        id: "provider_old",
        type: "pathao",
        credentials: JSON.stringify({ webhookSecret: "old-secret" }),
        config: "{}",
      },
      {
        id: "provider_new",
        type: "pathao",
        credentials: JSON.stringify({ webhookSecret: "new-secret" }),
        config: "{}",
      },
    ]));

    await expect(verifyDeliveryWebhook(
      {} as Env,
      "pathao",
      new Request("https://api.example.test/webhook", {
        method: "POST",
        headers: { "X-PATHAO-Signature": "new-secret" },
      }),
      "{}",
    )).resolves.toMatchObject({
      verified: false,
      providerId: null,
      reason: "Multiple active providers configured",
    });
  });

  it("returns the active provider id after successful Pathao verification", async () => {
    mocks.getDb.mockReturnValue(createDb({
      id: "provider_pathao",
      type: "pathao",
      credentials: JSON.stringify({ webhookSecret: "secret" }),
      config: "{}",
    }));

    await expect(verifyDeliveryWebhook(
      {} as Env,
      "pathao",
      new Request("https://api.example.test/webhook", {
        method: "POST",
        headers: { "X-PATHAO-Signature": "secret" },
      }),
      "{}",
    )).resolves.toMatchObject({
      verified: true,
      providerId: "provider_pathao",
    });
  });
});
