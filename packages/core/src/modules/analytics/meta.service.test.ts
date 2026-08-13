import { describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "../../utils/credential-encryption";
import { getCapiSettings, logCapiEvent } from "./meta.service";

const baseSettings = {
  id: "singleton",
  pixelId: "1234567890",
  accessToken: "legacy-token",
  testEventCode: null,
  isEnabled: true,
  logRetentionDays: 30,
  createdAt: 1,
  updatedAt: 1,
};

function createDb(row: typeof baseSettings | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => row),
        })),
      })),
    })),
  };
}

describe("getCapiSettings", () => {
  it("keeps legacy plaintext access tokens readable", async () => {
    const settings = await getCapiSettings(createDb(baseSettings) as never);

    expect(settings?.accessToken).toBe("legacy-token");
  });

  it("fails closed when an encrypted access token cannot be decrypted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = Buffer.alloc(32, 7).toString("base64");
    const wrongKey = Buffer.alloc(32, 8).toString("base64");
    const encryptedToken = await encryptCredentials("live-meta-token", key);

    try {
      const settings = await getCapiSettings(
        createDb({ ...baseSettings, accessToken: encryptedToken }) as never,
        wrongKey,
      );

      expect(settings?.accessToken).toBeNull();
      expect(JSON.stringify(settings)).not.toContain(encryptedToken);
      expect(warnSpy).toHaveBeenCalledWith(
        "[Meta CAPI] Access token is not ready:",
        "Meta Conversions API access token could not be decrypted with the configured credential key.",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("logCapiEvent", () => {
  it("stores bounded summaries instead of raw provider payloads or errors", async () => {
    const values = vi.fn(async () => undefined);
    const db = {
      insert: vi.fn(() => ({ values })),
      delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    };

    await logCapiEvent(db as never, {
      eventId: "Purchase:event_1",
      eventName: "Purchase",
      status: "failed",
      requestPayload: JSON.stringify({
        data: [{
          event_name: "Purchase",
          action_source: "website",
          user_data: { em: ["hashed-email"], ph: ["hashed-phone"] },
          custom_data: { order_id: "order-secret" },
        }],
        test_event_code: "TEST-secret",
      }),
      responsePayload: JSON.stringify({
        error: {
          type: "OAuthException",
          code: 190,
          message: "Invalid token secret-provider-token",
        },
      }),
      errorMessage: "owner@example.com token secret-provider-token",
      eventTime: 1_800_000_000,
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      requestPayload: JSON.stringify({
        eventCount: 1,
        events: [{ eventName: "Purchase", actionSource: "website" }],
        truncated: false,
      }),
      responsePayload: JSON.stringify({
        eventsReceived: null,
        hasError: true,
        errorType: "OAuthException",
        errorCode: 190,
      }),
      errorMessage: "Meta delivery failed. Review provider configuration.",
    }));
    expect(JSON.stringify(values.mock.calls)).not.toContain("hashed-email");
    expect(JSON.stringify(values.mock.calls)).not.toContain("order-secret");
    expect(JSON.stringify(values.mock.calls)).not.toContain("secret-provider-token");
    expect(JSON.stringify(values.mock.calls)).not.toContain("owner@example.com");
  });
});
