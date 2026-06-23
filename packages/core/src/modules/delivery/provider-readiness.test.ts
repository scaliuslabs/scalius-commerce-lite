import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors";
import {
  assertDeliveryProviderReadyForActivation,
  getDeliveryProviderActivationBlockers,
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
