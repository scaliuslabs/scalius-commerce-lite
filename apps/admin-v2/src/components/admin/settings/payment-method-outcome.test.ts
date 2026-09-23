import { describe, expect, it } from "vitest";

import {
  getEligibleDefaultPaymentMethods,
  getPaymentMethodFlowEligibility,
  getPaymentMethodFlowExclusionReason,
  getPaymentMethodOutcome,
  type GatewayStatus,
  type MethodKey,
} from "./payment-method-outcome";

const readyStatus: GatewayStatus = {
  configured: true,
  enabled: true,
  providerEnabled: true,
  usable: true,
};

function outcome(options: {
  method: MethodKey;
  status?: GatewayStatus;
  selected?: boolean;
  flowAllowed?: boolean;
  eligibilityIssue?: string | null;
}) {
  return getPaymentMethodOutcome({
    method: options.method,
    status: options.status,
    checkoutSelected: options.selected ?? true,
    flowAllowed: options.flowAllowed ?? true,
    eligibilityIssue: options.eligibilityIssue,
  });
}

describe("payment method merchant outcome matrix", () => {
  it.each([
    { selected: true, flowAllowed: true, state: "visible", effective: true },
    { selected: false, flowAllowed: true, state: "ready_hidden", effective: false },
    { selected: true, flowAllowed: false, state: "hidden_by_flow", effective: false },
  ] as const)("projects COD selected=$selected flowAllowed=$flowAllowed as $state", ({ selected, flowAllowed, state, effective }) => {
    expect(outcome({ method: "cod", selected, flowAllowed })).toMatchObject({ state, effective, canSelect: true });
  });

  it("does not claim buyer visibility when the saved checkout flow is unavailable", () => {
    expect(getPaymentMethodOutcome({
      method: "stripe",
      status: readyStatus,
      checkoutSelected: true,
      flowAllowed: undefined,
    })).toMatchObject({ state: "flow_unknown", effective: false });
  });

  it.each(["stripe", "sslcommerz"] as const)("fails %s closed when provider setup or enablement is incomplete", (method) => {
    expect(outcome({ method, status: { ...readyStatus, enabled: false, providerEnabled: false, usable: false } }))
      .toMatchObject({ state: "provider_off", effective: false, canSelect: false });
    expect(outcome({ method, status: { configured: false, enabled: true, providerEnabled: true, usable: false } }))
      .toMatchObject({ state: "needs_setup", effective: false, canSelect: false });
    expect(outcome({ method, status: undefined })).toMatchObject({ state: "needs_setup", effective: false });
    expect(outcome({ method, status: { ...readyStatus, usable: false } }))
      .toMatchObject({ state: "blocked", effective: false, canSelect: false });
  });

  it("blocks an otherwise-ready gateway when store-level eligibility fails", () => {
    expect(outcome({ method: "sslcommerz", status: readyStatus, eligibilityIssue: "currency" }))
      .toMatchObject({ state: "blocked", canSelect: false, effective: false });
  });

  it.each([
    ["Standard / COD", "cod", "all", false, 0, true],
    ["Standard / Stripe", "stripe", "all", false, 0, true],
    ["COD only / COD", "cod", "guest_cod_only", false, 0, true],
    ["COD only / Stripe", "stripe", "guest_cod_only", false, 0, false],
    ["Online only / COD", "cod", "gateways_only", false, 0, false],
    ["Online only / SSLCommerz", "sslcommerz", "gateways_only", false, 0, true],
    ["Advance / COD", "cod", "all", true, 200, false],
    ["Advance / SSLCommerz", "sslcommerz", "all", true, 200, true],
    ["Invalid zero advance / Stripe", "stripe", "all", true, 0, false],
    ["Conflicting COD-only advance / COD", "cod", "guest_cod_only", true, 200, false],
    ["Conflicting COD-only advance / Stripe", "stripe", "guest_cod_only", true, 200, false],
  ] as const)("projects flow eligibility for %s", (_label, method, checkoutMode, partialPaymentEnabled, partialPaymentAmount, expected) => {
    expect(getPaymentMethodFlowEligibility(method, { checkoutMode, partialPaymentEnabled, partialPaymentAmount })).toBe(expected);
  });

  it("explains invalid and flow-hidden methods", () => {
    expect(getPaymentMethodFlowExclusionReason("stripe", { checkoutMode: "all", partialPaymentEnabled: true, partialPaymentAmount: 0 }))
      .toBe("advanceInvalid");
    expect(getPaymentMethodFlowExclusionReason("sslcommerz", { checkoutMode: "guest_cod_only", partialPaymentEnabled: true, partialPaymentAmount: 200 }))
      .toBe("codOnlyWithAdvance");
    expect(getPaymentMethodFlowExclusionReason("cod", { checkoutMode: "all", partialPaymentEnabled: true, partialPaymentAmount: 200 }))
      .toBe("codHiddenByAdvance");
    expect(getPaymentMethodFlowExclusionReason("cod", { checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0 }))
      .toBeNull();
  });

  it("chooses defaults only from ready, selected methods allowed by the flow", () => {
    const methods: MethodKey[] = ["stripe", "sslcommerz", "cod"];
    const statuses: Partial<Record<MethodKey, GatewayStatus>> = {
      stripe: readyStatus,
      sslcommerz: readyStatus,
      cod: { configured: true, enabled: true, usable: true },
    };
    const input = {
      methods,
      statuses,
      selectedMethods: new Set(methods),
      flowAllowed: (method: MethodKey) => method !== "cod",
      eligibilityIssue: (method: MethodKey) => (method === "sslcommerz" ? "Unsupported currency" : null),
    };

    expect(getEligibleDefaultPaymentMethods(input)).toEqual(["stripe"]);
    expect(getEligibleDefaultPaymentMethods({
      ...input,
      statuses: { ...statuses, stripe: { ...readyStatus, providerEnabled: false, enabled: false, usable: false } },
    })).toEqual([]);
  });
});
