import { describe, expect, it, vi } from "vitest";

import {
  getOAuthDecisionCompletionUrl,
  getTrustedOAuthCompletionUrl,
  navigateOAuthDecisionCompletion,
} from "./oauth-completion";

describe("OAuth completion navigation", () => {
  const origin = "https://api.scalius.test";

  it("accepts the configured API origin and one opaque request ID", () => {
    expect(
      getTrustedOAuthCompletionUrl(
        "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345",
        origin,
      ),
    ).toBe("https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345");
  });

  it.each([
    "https://attacker.test/oauth/complete/aar_Ab12_cdEF345",
    "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345?redirect=https://attacker.test",
    "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345#token",
    "https://api.scalius.test/oauth/complete/../../oauth/token",
    "https://api.scalius.test/oauth/complete/not-an-agent-request",
  ])("rejects untrusted completion URL %s", (value) => {
    expect(getTrustedOAuthCompletionUrl(value, origin)).toBeNull();
  });

  it("turns an approved response into the exact top-level navigation target", () => {
    expect(
      getOAuthDecisionCompletionUrl(
        {
          status: "approved",
          completionUrl:
            "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345",
        },
        origin,
      ),
    ).toBe("https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345");
  });

  it("accepts a denied response so the server can return access_denied", () => {
    expect(
      getOAuthDecisionCompletionUrl(
        {
          status: "denied",
          completionUrl:
            "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345",
        },
        origin,
      ),
    ).toBe("https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345");
  });

  it("does not navigate without a terminal decision and trusted completion", () => {
    expect(
      getOAuthDecisionCompletionUrl(
        {
          status: "pending",
          completionUrl:
            "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345",
        },
        origin,
      ),
    ).toBeNull();
    expect(
      getOAuthDecisionCompletionUrl({ status: "approved" }, origin),
    ).toBeNull();
  });

  it("performs one navigation for an approved trusted completion", () => {
    const assign = vi.fn();

    expect(
      navigateOAuthDecisionCompletion(
        {
          status: "approved",
          completionUrl:
            "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345",
        },
        origin,
        assign,
      ),
    ).toBe(true);
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith(
      "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345",
    );
  });

  it("does not navigate to an untrusted approval target", () => {
    const assign = vi.fn();

    expect(
      navigateOAuthDecisionCompletion(
        {
          status: "approved",
          completionUrl:
            "https://attacker.test/oauth/complete/aar_Ab12_cdEF345",
        },
        origin,
        assign,
      ),
    ).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("performs one navigation for a denied trusted completion", () => {
    const assign = vi.fn();

    expect(
      navigateOAuthDecisionCompletion(
        {
          status: "denied",
          completionUrl:
            "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345",
        },
        origin,
        assign,
      ),
    ).toBe(true);
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith(
      "https://api.scalius.test/oauth/complete/aar_Ab12_cdEF345",
    );
  });
});
