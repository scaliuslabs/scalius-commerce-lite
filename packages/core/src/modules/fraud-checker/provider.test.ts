import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ECourierFraudCheckProvider,
  FraudBdCheckProvider,
  FraudGuardCheckProvider,
  getFraudCheckProviderDefinition,
  getFraudCheckProvider,
} from "./provider";

function mockJsonResponse(payload: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bangladesh fraud checker providers", () => {
  it("calls FraudBD with documented credentials and normalizes courier stats", async () => {
    const fetchMock = mockJsonResponse({
      data: {
        mobile_number: "01711111111",
        totalSummary: {
          total: 10,
          success: 8,
          cancel: 2,
        },
        Summaries: {
          Steadfast: {
            total: 6,
            success: 5,
            cancel: 1,
          },
        },
      },
    });

    const result = await new FraudBdCheckProvider().lookup("+8801711111111", {
      apiUrl: "https://api.fraudbd.com/api/check-courier-info",
      apiKey: "fraudbd-key",
      apiSecret: "fraudbd-password",
      userId: "fraudbd-user",
    });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [, init] = firstCall!;
    expect(init?.headers).toMatchObject({
      api_key: "fraudbd-key",
      user_name: "fraudbd-user",
      password: "fraudbd-password",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ phone_number: "01711111111" });
    expect(result.riskLevel).toBe("medium");
    expect(result.details).toMatchObject({
      total_parcels: 10,
      total_delivered: 8,
      total_cancel: 2,
      apis: {
        Steadfast: {
          total_parcels: 6,
          total_delivered_parcels: 5,
          total_cancelled_parcels: 1,
        },
      },
    });
  });

  it("calls FraudGuard with key and secret headers", async () => {
    const fetchMock = mockJsonResponse({
      data: {
        summary: {
          total_orders: 4,
          successful_delivery: 3,
          cancelled_delivery: 1,
        },
        courier_stats: [
          {
            courier: "Pathao",
            total_orders: 4,
            successful_delivery: 3,
            cancelled_delivery: 1,
          },
        ],
      },
    });

    const result = await new FraudGuardCheckProvider().lookup("+8801811111111", {
      apiUrl: "https://fraudguard.slope.com.bd/api/v1/fraud-check",
      apiKey: "guard-key",
      apiSecret: "guard-secret",
    });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [, init] = firstCall!;
    expect(init?.headers).toMatchObject({
      "X-API-KEY": "guard-key",
      "X-API-SECRET": "guard-secret",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ phone_number: "01811111111" });
    expect(result.details).toMatchObject({
      total_parcels: 4,
      total_delivered: 3,
      total_cancel: 1,
      apis: {
        Pathao: {
          total_parcels: 4,
          total_delivered_parcels: 3,
          total_cancelled_parcels: 1,
        },
      },
    });
  });

  it("calls eCourier with merchant credential headers", async () => {
    const fetchMock = mockJsonResponse({
      customer_status: "Warning!",
      customer_message: [
        "This customer has a risky delivery history. Please review before dispatch.",
      ],
    });

    const result = await new ECourierFraudCheckProvider().lookup("+8801911111111", {
      apiUrl: "https://backoffice.ecourier.com.bd/api/fraud-status-check",
      apiKey: "ecourier-key",
      apiSecret: "ecourier-secret",
      userId: "merchant-user-id",
    });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [, init] = firstCall!;
    expect(init?.headers).toMatchObject({
      "API-KEY": "ecourier-key",
      "API-SECRET": "ecourier-secret",
      "USER-ID": "merchant-user-id",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ number: "01911111111" });
    expect(result.riskLevel).toBe("high");
    expect(result.details).toMatchObject({
      mobile_number: "01911111111",
      total_parcels: 0,
      total_delivered: 0,
      total_cancel: 0,
      provider_status: "Warning!",
      message: "This customer has a risky delivery history. Please review before dispatch.",
    });
  });

  it("documents required credentials for admin configuration", () => {
    expect(getFraudCheckProviderDefinition("fraudbd").requiredFields).toEqual(["apiKey", "apiSecret", "userId"]);
    expect(getFraudCheckProviderDefinition("fraudguard").requiredFields).toEqual(["apiKey", "apiSecret"]);
    expect(getFraudCheckProviderDefinition("ecourier").requiredFields).toEqual(["apiKey", "apiSecret", "userId"]);
  });

  it("does not silently route unknown provider types to the default adapter", () => {
    expect(() => getFraudCheckProvider("missing-provider")).toThrow("Unsupported fraud checker provider type");
  });
});
