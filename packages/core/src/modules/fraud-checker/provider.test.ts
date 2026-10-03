// The built-in fraud checkers behind the fraud port: each provider's request,
// and its response normalized into the port's answer (validated against the
// port's output schema, the one app providers answer with). HTTP is mocked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_PORTS } from "@scalius/shared/plugins/providers";
import { bindProvider } from "../../integrations/provider-port";
import {
  builtInFraudChecker,
  eCourierFraudChecker,
  fraudBdChecker,
  fraudGuardChecker,
} from "./provider";
import { getFraudCheckProviderDefinition } from "./provider-definitions";

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

    const result = await fraudBdChecker.check({ phone: "+8801711111111" }, {
      settings: {
        apiUrl: "https://api.fraudbd.com/api/check-courier-info",
        apiKey: "fraudbd-key",
        apiSecret: "fraudbd-password",
        userId: "fraudbd-user",
      },
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
    expect(PROVIDER_PORTS.fraud.check.output.parse(result)).toMatchObject({
      totalParcels: 10,
      delivered: 8,
      cancelled: 2,
      couriers: {
        Steadfast: {
          totalParcels: 6,
          delivered: 5,
          cancelled: 1,
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

    const result = await fraudGuardChecker.check({ phone: "+8801811111111" }, {
      settings: {
        apiUrl: "https://fraudguard.slope.com.bd/api/v1/fraud-check",
        apiKey: "guard-key",
        apiSecret: "guard-secret",
      },
    });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [, init] = firstCall!;
    expect(init?.headers).toMatchObject({
      "X-API-KEY": "guard-key",
      "X-API-SECRET": "guard-secret",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ phone_number: "01811111111" });
    expect(PROVIDER_PORTS.fraud.check.output.parse(result)).toMatchObject({
      totalParcels: 4,
      delivered: 3,
      cancelled: 1,
      couriers: {
        Pathao: {
          totalParcels: 4,
          delivered: 3,
          cancelled: 1,
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

    // Bound to its settings, as lookups call it.
    const result = await bindProvider("fraud", eCourierFraudChecker, {
      apiUrl: "https://backoffice.ecourier.com.bd/api/fraud-status-check",
      apiKey: "ecourier-key",
      apiSecret: "ecourier-secret",
      userId: "merchant-user-id",
    }).check({ phone: "+8801911111111" }, {});

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
    expect(PROVIDER_PORTS.fraud.check.output.parse(result)).toMatchObject({
      phone: "01911111111",
      totalParcels: 0,
      delivered: 0,
      cancelled: 0,
      providerStatus: "Warning!",
      message: "This customer has a risky delivery history. Please review before dispatch.",
    });
  });

  it("documents required credentials for admin configuration", () => {
    expect(getFraudCheckProviderDefinition("fraudbd").requiredFields).toEqual(["apiKey", "apiSecret", "userId"]);
    expect(getFraudCheckProviderDefinition("fraudguard").requiredFields).toEqual(["apiKey", "apiSecret"]);
    expect(getFraudCheckProviderDefinition("ecourier").requiredFields).toEqual(["apiKey", "apiSecret", "userId"]);
  });

  it("does not silently route unknown provider types to the default adapter", () => {
    expect(() => builtInFraudChecker("missing-provider")).toThrow("Unsupported fraud checker provider type");
    expect(builtInFraudChecker(undefined).id).toBe("default");
  });
});
