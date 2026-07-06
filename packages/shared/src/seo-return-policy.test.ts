import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEO_RETURN_POLICY_SETTINGS,
  mergeSeoReturnPolicySettings,
  normalizeSeoReturnPolicySettings,
  parseSeoReturnPolicySettings,
} from "./seo-return-policy";

describe("SEO return policy settings", () => {
  it("defaults to disabled so schema is not emitted from invented policy data", () => {
    expect(normalizeSeoReturnPolicySettings(null)).toEqual(
      DEFAULT_SEO_RETURN_POLICY_SETTINGS,
    );
    expect(parseSeoReturnPolicySettings("not json")).toEqual(
      DEFAULT_SEO_RETURN_POLICY_SETTINGS,
    );
  });

  it("normalizes merchant policy fields defensively", () => {
    expect(
      normalizeSeoReturnPolicySettings({
        enabled: true,
        country: " bd ",
        category: "finite",
        returnWindowDays: "14",
        returnFees: "free",
        returnMethod: "both",
        policyUrl: " https://store.example.com/returns ",
      }),
    ).toEqual({
      enabled: true,
      country: "BD",
      category: "finite",
      returnWindowDays: 14,
      returnFees: "free",
      returnMethod: "both",
      policyUrl: "https://store.example.com/returns",
    });

    expect(
      normalizeSeoReturnPolicySettings({
        policyUrl: " /returns ",
      }).policyUrl,
    ).toBe("/returns");
  });

  it("drops non-finite return windows and rejects unsafe enum/url values", () => {
    expect(
      normalizeSeoReturnPolicySettings({
        enabled: "yes",
        country: "Bangladesh",
        category: "exchange_only",
        returnWindowDays: 999,
        returnFees: "hidden_fee",
        returnMethod: "courier",
        policyUrl: "javascript:alert(1)",
      }),
    ).toEqual(DEFAULT_SEO_RETURN_POLICY_SETTINGS);

    expect(
      normalizeSeoReturnPolicySettings({
        category: "no_returns",
        returnWindowDays: 30,
      }),
    ).toMatchObject({
      category: "no_returns",
      returnWindowDays: null,
    });
  });

  it("does not keep incomplete finite policies enabled", () => {
    expect(
      normalizeSeoReturnPolicySettings({
        enabled: true,
        category: "finite",
        returnWindowDays: null,
      }),
    ).toMatchObject({
      enabled: false,
      category: "finite",
      returnWindowDays: null,
    });
  });

  it("merges partial patches without resetting established policy details", () => {
    expect(
      mergeSeoReturnPolicySettings(
        {
          enabled: true,
          country: "BD",
          category: "finite",
          returnWindowDays: 10,
          returnFees: "customer_responsibility",
          returnMethod: "mail",
          policyUrl: "https://store.example.com/returns",
        },
        {
          returnFees: "free",
          returnMethod: "both",
        },
      ),
    ).toEqual({
      enabled: true,
      country: "BD",
      category: "finite",
      returnWindowDays: 10,
      returnFees: "free",
      returnMethod: "both",
      policyUrl: "https://store.example.com/returns",
    });
  });
});
