import type { GatewayStatus, MethodKey } from "./payment-gateway-utils";

export type PaymentMethodEnvironment = "test" | "live" | "mixed" | "unknown" | "not_applicable";

export type PaymentMethodOutcomeState =
  | "visible"
  | "ready_hidden"
  | "hidden_by_flow"
  | "flow_unknown"
  | "provider_off"
  | "needs_setup"
  | "blocked";

export interface PaymentMethodOutcome {
  state: PaymentMethodOutcomeState;
  label: string;
  description: string;
  setupLabel: "Ready" | "Required" | "Not required";
  providerLabel: "On" | "Off" | "Always available";
  checkoutLabel: "Visible" | "Hidden" | "Hidden by flow" | "Unavailable";
  environmentLabel: string;
  healthLabel: "Not checked";
  effective: boolean;
  canSelect: boolean;
}

const FALLBACK_BLOCKED_COPY = "This method is not ready for buyer checkout.";

function getEnvironmentLabel(
  method: MethodKey,
  environment: PaymentMethodEnvironment | undefined,
): string {
  if (method === "cod" || environment === "not_applicable") return "Not applicable";
  if (environment === undefined) return "Open setup";
  if (environment === "test") return "Test mode";
  if (environment === "live") return "Live mode";
  if (environment === "mixed") return "Key mismatch";
  return "Not detected";
}

export function getPaymentMethodOutcome(options: {
  method: MethodKey;
  status: GatewayStatus | undefined;
  checkoutSelected: boolean;
  flowAllowed: boolean | undefined;
  environment?: PaymentMethodEnvironment;
}): PaymentMethodOutcome {
  const { method, status, checkoutSelected, flowAllowed, environment } = options;
  const isCod = method === "cod";
  const configured = isCod || status?.configured === true;
  const providerEnabled = isCod || (status?.providerEnabled ?? status?.enabled) === true;
  const usable = isCod || status?.usable === true;
  const common = {
    setupLabel: (isCod ? "Not required" : configured ? "Ready" : "Required") as PaymentMethodOutcome["setupLabel"],
    providerLabel: (isCod ? "Always available" : providerEnabled ? "On" : "Off") as PaymentMethodOutcome["providerLabel"],
    environmentLabel: getEnvironmentLabel(method, environment),
    healthLabel: "Not checked" as const,
    canSelect: isCod || usable,
  };

  if (!configured) {
    return {
      ...common,
      state: "needs_setup",
      label: "Needs setup",
      description: status?.blockedReason ?? "Complete the required setup before offering this method.",
      checkoutLabel: "Hidden",
      effective: false,
    };
  }

  if (!providerEnabled) {
    return {
      ...common,
      state: "provider_off",
      label: "Provider off",
      description: "Setup is saved, but provider calls are disabled.",
      checkoutLabel: "Hidden",
      effective: false,
    };
  }

  if (!usable) {
    return {
      ...common,
      state: "blocked",
      label: "Blocked",
      description: status?.blockedReason ?? FALLBACK_BLOCKED_COPY,
      checkoutLabel: "Hidden",
      effective: false,
    };
  }

  if (!checkoutSelected) {
    return {
      ...common,
      state: "ready_hidden",
      label: "Ready, hidden",
      description: "The provider is ready, but it is not selected for buyer checkout.",
      checkoutLabel: "Hidden",
      effective: false,
    };
  }

  if (flowAllowed === undefined) {
    return {
      ...common,
      state: "flow_unknown",
      label: "Flow unavailable",
      description: "The saved checkout flow could not be checked.",
      checkoutLabel: "Unavailable",
      effective: false,
    };
  }

  if (!flowAllowed) {
    return {
      ...common,
      state: "hidden_by_flow",
      label: "Hidden by flow",
      description: "The saved checkout flow excludes this method.",
      checkoutLabel: "Hidden by flow",
      effective: false,
    };
  }

  return {
    ...common,
    state: "visible",
    label: "Visible",
    description: "This method is ready and included in the current buyer checkout flow.",
    checkoutLabel: "Visible",
    effective: true,
  };
}
