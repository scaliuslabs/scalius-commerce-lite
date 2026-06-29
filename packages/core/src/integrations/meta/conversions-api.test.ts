import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCapiSettings: vi.fn(),
  logCapiEvent: vi.fn(),
}));

vi.mock("../../modules/analytics/meta.service", () => ({
  getCapiSettings: mocks.getCapiSettings,
  logCapiEvent: mocks.logCapiEvent,
}));

import { redactCapiPayloadForLog, sendCapiEvent } from "./conversions-api";
import { sha256 } from "./crypto-utils";

describe("Meta Conversions API log redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("redacts user data, test event codes, and event source URL queries", () => {
    const redacted = redactCapiPayloadForLog({
      test_event_code: "TEST123",
      data: [
        {
          event_name: "Purchase",
          event_time: 1_800_000_000,
          event_source_url:
            "https://store.example/order-success?orderId=order_1&token=receipt_secret",
          event_id: "Purchase:order_1",
          action_source: "website",
          user_data: {
            em: ["hashed-email"],
            client_ip_address: "203.0.113.10",
            client_user_agent: "Browser",
            fbp: "fb.1.123",
          },
          custom_data: {
            order_id: "order_1",
            currency: "BDT",
            value: 1000,
          },
        },
      ],
    });

    expect(redacted).toMatchObject({
      test_event_code: "[redacted]",
      data: [
        {
          event_source_url: "https://store.example/order-success",
          user_data: {
            em: "[redacted]",
            client_ip_address: "[redacted]",
            client_user_agent: "[redacted]",
            fbp: "[redacted]",
          },
        },
      ],
    });
  });

  it("hashes external_id before sending user data to Meta", async () => {
    mocks.getCapiSettings.mockResolvedValue({
      isEnabled: true,
      pixelId: "pixel_123",
      accessToken: "access_token",
      testEventCode: null,
      logRetentionDays: 30,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      events_received: 1,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await sendCapiEvent({} as never, {
      event_name: "Purchase",
      event_time: 1_800_000_000,
      event_source_url: "https://store.example/order-success",
      event_id: "Purchase:order_1",
      action_source: "website",
      user_data: {
        external_id: [" Customer_123 ", ""],
        em: "BUYER@EXAMPLE.COM",
      },
      custom_data: {
        order_id: "order_1",
        currency: "BDT",
        value: 1000,
      },
    });

    const fetchMock = vi.mocked(fetch);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      data: Array<{ user_data: { external_id?: string[]; em?: string[] } }>;
    };
    const sentEvent = payload.data[0];

    if (!sentEvent) {
      throw new Error("Expected Meta request payload to include one event.");
    }
    expect(sentEvent.user_data.external_id).toEqual([
      await sha256("customer_123"),
    ]);
    expect(sentEvent.user_data.external_id).not.toContain(" Customer_123 ");
    expect(sentEvent.user_data.em).toEqual([
      await sha256("buyer@example.com"),
    ]);
  });

  it("marks disabled or missing CAPI settings as non-retryable", async () => {
    mocks.getCapiSettings.mockResolvedValue(null);

    const result = await sendCapiEvent({} as never, {
      event_name: "Purchase",
      event_time: 1_800_000_000,
      event_source_url: "https://store.example/order-success",
      event_id: "Purchase:order_1",
      action_source: "website",
      user_data: {},
      custom_data: {
        order_id: "order_1",
        currency: "BDT",
        value: 1000,
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: "CAPI not configured",
      retryable: false,
      skipped: true,
    });
    expect(mocks.logCapiEvent).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        eventId: "Purchase:order_1",
        status: "failed",
      }),
      30 * 24,
    );
  });

  it("treats Meta credential/configuration HTTP failures as non-retryable", async () => {
    mocks.getCapiSettings.mockResolvedValue({
      isEnabled: true,
      pixelId: "pixel_123",
      accessToken: "bad_token",
      testEventCode: null,
      logRetentionDays: 30,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Invalid OAuth access token." },
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })));

    const result = await sendCapiEvent({} as never, {
      event_name: "Purchase",
      event_time: 1_800_000_000,
      event_source_url: "https://store.example/order-success",
      event_id: "Purchase:order_1",
      action_source: "website",
      user_data: {},
      custom_data: {
        order_id: "order_1",
        currency: "BDT",
        value: 1000,
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: "Invalid OAuth access token.",
      retryable: false,
    });
    expect(mocks.logCapiEvent).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        eventId: "Purchase:order_1",
        status: "failed",
        responsePayload: JSON.stringify({
          error: { message: "Invalid OAuth access token." },
        }, null, 2),
      }),
      30 * 24,
    );
  });
});
