import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { ValidationError } from "../../errors";
import {
  assertDeliveryProviderReadyForActivation,
  getDeliveryProviderActivationBlockers,
  getDeliveryProviderReadinessSummary,
  getDeliveryProviderSetupFingerprint,
} from "./provider-readiness";

function legacyStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyStableJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = legacyStableJson((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

function legacySetupFingerprint(
  input: { type: string; credentials: Record<string, unknown>; config: Record<string, unknown> },
  key: string,
): string {
  const material = JSON.stringify(legacyStableJson(input));
  const digest = createHmac("sha256", Buffer.from(key, "base64"))
    .update(material)
    .digest("hex");
  return `hmac-sha256:${digest}`;
}

describe("delivery provider activation readiness", () => {
  it("requires Pathao API credentials and store configuration before activation", () => {
    const blockers = getDeliveryProviderActivationBlockers({
      type: "pathao",
      credentials: {
        baseUrl: "https://api-hermes.pathao.com",
        clientSecret: "pathao-secret-9417",
        password: "merchant-password-7813",
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
        clientId: "pathao-client-4821",
        clientSecret: "pathao-secret-9417",
        username: "merchant",
        password: "merchant-password-7813",
      }),
      config: JSON.stringify({ storeId: "store_1" }),
    })).toEqual([]);
  });

  it("requires Steadfast base URL, API key, and secret key before activation", () => {
    const blockers = getDeliveryProviderActivationBlockers({
      type: "steadfast",
      credentials: { baseUrl: "https://portal.packzy.com/api/v1" },
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

  it("blocks obvious placeholders and unsafe provider base URLs", () => {
    expect(getDeliveryProviderActivationBlockers({
      type: "steadfast",
      credentials: {
        baseUrl: "http://localhost:8787/api/v1?token=secret",
        apiKey: "dummy",
        secretKey: "your-secret-here",
      },
      config: {},
    }).map((blocker) => blocker.key)).toEqual([
      "baseUrl",
      "apiKey",
      "secretKey",
    ]);
  });

  it.each([
    "https://127.0.0.1/api/v1",
    "https://localhost/api/v1",
    "https://courier.internal/api/v1",
    "https://portal.packzy.com:8443/api/v1",
  ])("blocks non-public provider base URL %s", (baseUrl) => {
    expect(getDeliveryProviderActivationBlockers({
      type: "steadfast",
      credentials: {
        baseUrl,
        apiKey: "steadfast-api-4821",
        secretKey: "steadfast-secret-9417",
      },
      config: {},
    })).toEqual(expect.arrayContaining([expect.objectContaining({ key: "baseUrl" })]));
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
    baseUrl: "https://portal.packzy.com/api/v1",
    apiKey: "steadfast-api-4821",
    secretKey: "steadfast-secret-9417",
  };

  it.each([
    {
      type: "steadfast",
      credentials: completeSteadfastCredentials,
      config: {},
    },
    {
      type: "pathao",
      credentials: {
        baseUrl: "https://api-hermes.pathao.com",
        clientId: "pathao-client-4821",
        clientSecret: "pathao-secret-9417",
        username: "merchant",
        password: "merchant-password-7813",
      },
      config: { storeId: "232926" },
    },
  ])("invalidates permissive $type connection proofs", async (setup) => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const legacyFingerprint = legacySetupFingerprint(setup, key);
    const currentFingerprint = await getDeliveryProviderSetupFingerprint(setup, key);
    expect(currentFingerprint).not.toBe(legacyFingerprint);
    expect(getDeliveryProviderReadinessSummary({
      ...setup,
      isActive: true,
      currentFingerprint,
      lastTestSuccessAt: 100,
      lastTestSuccessFingerprint: legacyFingerprint,
    })).toMatchObject({
      status: "blocked",
      tested: false,
      active: false,
      blockers: [{ code: "untested" }],
    });
  });

  it("reports encrypted credentials that cannot be read as unreadable, not unconfigured", () => {
    expect(getDeliveryProviderReadinessSummary({
      type: "pathao",
      credentials: null,
      credentialsReadable: false,
      config: { storeId: "232926" },
      isActive: true,
    })).toMatchObject({
      status: "blocked",
      configured: false,
      tested: false,
      active: false,
      blockers: [{
        code: "unreadable",
        message: expect.stringContaining("cannot be decrypted"),
      }],
      activationBlockers: [{
        source: "credentials",
        key: "credentials",
      }],
    });
  });

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
