import { describe, expect, it } from "vitest";

import type { GatewayStatus, MethodKey } from "./payment-gateway-utils";
import {
  getEligibleDefaultPaymentMethods,
  getPaymentMethodFlowEligibility,
  getPaymentMethodFlowExclusionReason,
  getPaymentMethodOutcome,
  type PaymentMethodEnvironment,
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
  environment?: PaymentMethodEnvironment;
}) {
  return getPaymentMethodOutcome({
    method: options.method,
    status: options.status,
    checkoutSelected: options.selected ?? true,
    flowAllowed: options.flowAllowed ?? true,
    environment: options.environment,
  });
}

describe("payment method merchant outcome matrix", () => {
  it.each([
    { selected: true, flowAllowed: true, state: "visible", checkout: "Visible", effective: true },
    { selected: false, flowAllowed: true, state: "ready_hidden", checkout: "Hidden", effective: false },
    { selected: true, flowAllowed: false, state: "hidden_by_flow", checkout: "Hidden by flow", effective: false },
  ] as const)(
    "projects COD selected=$selected flowAllowed=$flowAllowed as $state",
    ({ selected, flowAllowed, state, checkout, effective }) => {
      const result = outcome({ method: "cod", selected, flowAllowed });

      expect(result).toMatchObject({
        state,
        checkoutLabel: checkout,
        effective,
        setupLabel: "Not required",
        providerLabel: "Always available",
        environmentLabel: "Not applicable",
      });
    },
  );

  it("does not claim buyer visibility when the saved checkout flow is unavailable", () => {
    expect(getPaymentMethodOutcome({
      method: "stripe",
      status: readyStatus,
      checkoutSelected: true,
      flowAllowed: undefined,
      environment: "test",
    })).toMatchObject({
      state: "flow_unknown",
      label: "Flow unavailable",
      checkoutLabel: "Unavailable",
      effective: false,
    });
  });

  it.each([
    ["Stripe", "stripe"],
    ["SSLCommerz", "sslcommerz"],
    ["Polar", "polar"],
  ] as const)("fails %s closed when provider setup or enablement is incomplete", (_label, method) => {
    const disabled = outcome({
      method,
      status: { ...readyStatus, enabled: false, providerEnabled: false, usable: false },
    });
    const missing = outcome({
      method,
      status: {
        configured: false,
        enabled: true,
        providerEnabled: true,
        usable: false,
        missingFields: ["credential"],
        blockedReason: `${_label} needs a credential before it can be shown at checkout.`,
      },
    });
    const placeholder = outcome({
      method,
      status: {
        configured: false,
        enabled: true,
        providerEnabled: true,
        usable: false,
        blockedReason: `${_label} credential looks like a placeholder.`,
      },
    });

    expect(disabled).toMatchObject({ state: "provider_off", checkoutLabel: "Hidden", effective: false });
    expect(missing).toMatchObject({
      state: "needs_setup",
      checkoutLabel: "Hidden",
      effective: false,
      description: `${_label} needs a credential before it can be shown at checkout.`,
    });
    expect(placeholder).toMatchObject({
      state: "needs_setup",
      checkoutLabel: "Hidden",
      effective: false,
      description: `${_label} credential looks like a placeholder.`,
    });
  });

  it.each([
    ["Stripe test", "stripe", "test", "Test mode"],
    ["Stripe live", "stripe", "live", "Live mode"],
    ["Stripe mismatch", "stripe", "mixed", "Key mismatch"],
    ["SSLCommerz sandbox", "sslcommerz", "test", "Test mode"],
    ["SSLCommerz live", "sslcommerz", "live", "Live mode"],
    ["Polar sandbox", "polar", "test", "Test mode"],
    ["Polar live", "polar", "live", "Live mode"],
  ] as const)("labels the supported environment for %s", (_label, method, environment, expected) => {
    expect(outcome({ method, status: readyStatus, environment }).environmentLabel).toBe(expected);
  });

  it.each([
    { selected: false, flowAllowed: true, state: "ready_hidden", checkout: "Hidden" },
    { selected: true, flowAllowed: false, state: "hidden_by_flow", checkout: "Hidden by flow" },
    { selected: true, flowAllowed: true, state: "visible", checkout: "Visible" },
  ] as const)(
    "separates checkout selection/flow eligibility from provider readiness ($state)",
    ({ selected, flowAllowed, state, checkout }) => {
      expect(outcome({
        method: "stripe",
        status: readyStatus,
        selected,
        flowAllowed,
        environment: "test",
      })).toMatchObject({ state, checkoutLabel: checkout });
    },
  );

  it("does not present unsupported provider health checks as passing", () => {
    expect(outcome({ method: "stripe", status: readyStatus })).toMatchObject({
      healthLabel: "Not checked",
      setupLabel: "Complete",
      effective: true,
    });
  });

  it.each([
    ["Standard / COD", "cod", "all", false, 0, true],
    ["Standard / Stripe", "stripe", "all", false, 0, true],
    ["COD only / COD", "cod", "guest_cod_only", false, 0, true],
    ["COD only / Stripe", "stripe", "guest_cod_only", false, 0, false],
    ["Online only / COD", "cod", "gateways_only", false, 0, false],
    ["Online only / Polar", "polar", "gateways_only", false, 0, true],
    ["Advance / COD", "cod", "all", true, 200, false],
    ["Advance / SSLCommerz", "sslcommerz", "all", true, 200, true],
    ["Invalid zero advance / Stripe", "stripe", "all", true, 0, false],
    ["Conflicting COD-only advance / COD", "cod", "guest_cod_only", true, 200, false],
    ["Conflicting COD-only advance / Stripe", "stripe", "guest_cod_only", true, 200, false],
  ] as const)("projects flow eligibility for %s", (_label, method, checkoutMode, partialPaymentEnabled, partialPaymentAmount, expected) => {
    expect(getPaymentMethodFlowEligibility(method, {
      checkoutMode,
      partialPaymentEnabled,
      partialPaymentAmount,
    })).toBe(expected);
  });

  it("explains invalid and flow-hidden methods without reviving an excluded provider", () => {
    expect(getPaymentMethodFlowExclusionReason("stripe", {
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 0,
    })).toContain("advance amount is invalid");
    expect(getPaymentMethodFlowExclusionReason("polar", {
      checkoutMode: "guest_cod_only",
      partialPaymentEnabled: true,
      partialPaymentAmount: 200,
    })).toContain("conflicts with an online advance");
  });

  it("chooses defaults only from ready, selected methods allowed by the flow", () => {
    const methods: MethodKey[] = ["stripe", "sslcommerz", "polar", "cod"];
    const statuses: Partial<Record<MethodKey, GatewayStatus>> = {
      stripe: { ...readyStatus, providerEnabled: false, enabled: false, usable: false },
      sslcommerz: readyStatus,
      polar: readyStatus,
      cod: { configured: true, enabled: true, usable: true },
    };

    expect(getEligibleDefaultPaymentMethods({
      methods,
      statuses,
      selectedMethods: new Set(methods),
      flowAllowed: (method) => method !== "cod",
    })).toEqual(["sslcommerz", "polar"]);
  });

  it.each([
    ["Stripe missing", "stripe", { configured: false, enabled: true, providerEnabled: true, usable: false }, "needs_setup"],
    ["Stripe provider off", "stripe", { ...readyStatus, enabled: false, providerEnabled: false, usable: false }, "provider_off"],
    ["Stripe blocked", "stripe", { ...readyStatus, usable: false, blockedReason: "Key mismatch" }, "blocked"],
    ["SSLCommerz missing", "sslcommerz", { configured: false, enabled: true, providerEnabled: true, usable: false }, "needs_setup"],
    ["SSLCommerz provider off", "sslcommerz", { ...readyStatus, enabled: false, providerEnabled: false, usable: false }, "provider_off"],
    ["Polar missing", "polar", { configured: false, enabled: true, providerEnabled: true, usable: false }, "needs_setup"],
    ["Polar provider off", "polar", { ...readyStatus, enabled: false, providerEnabled: false, usable: false }, "provider_off"],
  ] as const)("keeps setup/provider truth separate for %s", (_label, method, status, state) => {
    expect(outcome({ method, status })).toMatchObject({ state, effective: false, healthLabel: "Not checked" });
  });
});
