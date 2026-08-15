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
          event_source_url: "https://store.example/order-success?orderId=order-secret",
          user_data: {
            em: ["hashed-email"],
            ph: ["hashed-phone"],
            client_ip_address: "203.0.113.10",
            client_user_agent: "Private Browser Signature",
            fbp: "fb.1.private",
          },
          custom_data: {
            order_id: "order-secret",
            currency: "BDT",
            value: 1_000,
            content_ids: ["sku-secret"],
            contents: [{ id: "sku-secret", quantity: 2 }],
            num_items: 2,
            search_string: "private search",
          },
        }],
        test_event_code: "TEST-secret",
      }),
      responsePayload: JSON.stringify({
        error: {
          type: "OAuthException",
          code: 190,
          message: "Invalid token secret-provider-token",
        },
        messages: [{ code: "warning" }],
        fbtrace_id: "trace-safe-1",
      }),
      errorMessage: "owner@example.com token secret-provider-token",
      eventTime: 1_800_000_000,
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      requestPayload: JSON.stringify({
        eventCount: 1,
        events: [{
          eventName: "Purchase",
          actionSource: "website",
          source: { origin: "https://store.example", path: "/order-success" },
          matchSignals: {
            count: 5,
            fields: ["client_ip_address", "client_user_agent", "em", "fbp", "ph"],
            hashedFields: ["em", "ph"],
            ipAddressSupplied: true,
            userAgentSupplied: true,
          },
          commerce: {
            fields: ["content_ids", "contents", "currency", "num_items", "order_id", "search_string", "value"],
            currency: "BDT",
            value: 1_000,
            contentType: null,
            contentCount: 1,
            lineCount: 1,
            quantity: 2,
            itemCount: 2,
            orderIdSupplied: true,
            searchStringSupplied: true,
          },
        }],
        testMode: true,
        truncated: false,
      }),
      responsePayload: JSON.stringify({
        eventsReceived: null,
        hasError: true,
        errorType: "OAuthException",
        errorCode: 190,
        messageCount: 1,
        providerTraceId: "trace-safe-1",
      }),
      errorMessage: "Meta delivery failed. Review provider configuration.",
    }));
    expect(JSON.stringify(values.mock.calls)).not.toContain("hashed-email");
    expect(JSON.stringify(values.mock.calls)).not.toContain("203.0.113.10");
    expect(JSON.stringify(values.mock.calls)).not.toContain("Private Browser Signature");
    expect(JSON.stringify(values.mock.calls)).not.toContain("fb.1.private");
    expect(JSON.stringify(values.mock.calls)).not.toContain("order-secret");
    expect(JSON.stringify(values.mock.calls)).not.toContain("sku-secret");
    expect(JSON.stringify(values.mock.calls)).not.toContain("private search");
    expect(JSON.stringify(values.mock.calls)).not.toContain("secret-provider-token");
    expect(JSON.stringify(values.mock.calls)).not.toContain("owner@example.com");
  });
});
