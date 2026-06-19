import { beforeEach, describe, expect, it, vi } from "vitest";

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

function createDb(provider: Record<string, unknown> | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => provider),
        })),
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
});
