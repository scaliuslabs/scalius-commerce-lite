import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors";
import {
  assertDeliveryProviderReadyForActivation,
  getDeliveryProviderActivationBlockers,
  getDeliveryProviderReadinessSummary,
  getDeliveryProviderSetupFingerprint,
} from "./provider-readiness";

describe("delivery provider activation readiness", () => {
  it("requires Pathao API credentials and store configuration before activation", () => {
    const blockers = getDeliveryProviderActivationBlockers({
      type: "pathao",
      credentials: {
        baseUrl: "https://api-hermes.pathao.com",
        clientSecret: "secret",
        password: "pass",
      },
      config: {},
    });

    expect(blockers.map((blocker) => blocker.key)).toEqual([
      "clientId",
      "username",
      "storeId",
    ]);
  });

  it("accepts complete Pathao setup from JSON strings", () => {
    expect(getDeliveryProviderActivationBlockers({
      type: "pathao",
      credentials: JSON.stringify({
        baseUrl: "https://api-hermes.pathao.com",
        clientId: "client",
        clientSecret: "secret",
        username: "merchant",
        password: "pass",
      }),
      config: JSON.stringify({ storeId: "store_1" }),
    })).toEqual([]);
  });

  it("requires Steadfast base URL, API key, and secret key before activation", () => {
    const blockers = getDeliveryProviderActivationBlockers({
      type: "steadfast",
      credentials: { baseUrl: "https://portal.steadfast.com.bd/api/v1" },
      config: {},
    });

    expect(blockers.map((blocker) => blocker.key)).toEqual(["apiKey", "secretKey"]);
  });

  it("fails closed for unsupported provider types", () => {
    expect(() => assertDeliveryProviderReadyForActivation({
      type: "unknown",
      credentials: {},
      config: {},
    })).toThrow(ValidationError);
  });

  it("throws a typed validation error with blocker details", () => {
    expect(() => assertDeliveryProviderReadyForActivation({
      type: "steadfast",
      credentials: "{}",
      config: "{}",
    })).toThrow(ValidationError);

    try {
      assertDeliveryProviderReadyForActivation({
        type: "steadfast",
        credentials: "{}",
        config: "{}",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({
        blockers: [
          { key: "baseUrl" },
          { key: "apiKey" },
          { key: "secretKey" },
        ],
      });
    }
  });
});

describe("delivery provider durable readiness summary", () => {
  const completeSteadfastCredentials = {
    baseUrl: "https://portal.steadfast.com.bd/api/v1",
    apiKey: "api",
    secretKey: "secret",
  };

  it("does not count a successful test unless the fingerprint matches the current setup", async () => {
    const fingerprint = await getDeliveryProviderSetupFingerprint({
      type: "steadfast",
      credentials: completeSteadfastCredentials,
      config: {},
    }, "fingerprint-key");

    expect(getDeliveryProviderReadinessSummary({
      type: "steadfast",
      credentials: { ...completeSteadfastCredentials, apiKey: "changed" },
      config: {},
      isActive: true,
      currentFingerprint: await getDeliveryProviderSetupFingerprint({
        type: "steadfast",
        credentials: { ...completeSteadfastCredentials, apiKey: "changed" },
        config: {},
      }, "fingerprint-key"),
      lastTestSuccessAt: 100,
      lastTestSuccessFingerprint: fingerprint,
    })).toMatchObject({
      status: "blocked",
      configured: true,
      tested: false,
      active: false,
      blockers: [{ code: "untested" }],
    });
  });

  it("reports active only when the provider is configured, enabled, and successfully tested", async () => {
    const fingerprint = await getDeliveryProviderSetupFingerprint({
      type: "steadfast",
      credentials: completeSteadfastCredentials,
      config: {},
    }, "fingerprint-key");

    expect(getDeliveryProviderReadinessSummary({
      type: "steadfast",
      credentials: completeSteadfastCredentials,
      config: {},
      isActive: true,
      currentFingerprint: fingerprint,
      lastTestSuccessAt: 100,
      lastTestSuccessFingerprint: fingerprint,
    })).toMatchObject({
      status: "active",
      configured: true,
      tested: true,
      active: true,
      blockers: [],
    });
  });

  it("blocks a provider when the latest test failed after a matching success", async () => {
    const fingerprint = await getDeliveryProviderSetupFingerprint({
      type: "steadfast",
      credentials: completeSteadfastCredentials,
      config: {},
    }, "fingerprint-key");

    expect(getDeliveryProviderReadinessSummary({
      type: "steadfast",
      credentials: completeSteadfastCredentials,
      config: {},
      isActive: true,
      currentFingerprint: fingerprint,
      lastTestSuccessAt: 100,
      lastTestFailureAt: 200,
      lastTestSuccessFingerprint: fingerprint,
    })).toMatchObject({
      status: "blocked",
      tested: false,
      active: false,
      blockers: [{ code: "test_failed" }],
    });
  });
});
