import type { GatewayStatus, MethodKey } from "./payment-gateway-utils";

export type PaymentMethodEnvironment = NonNullable<GatewayStatus["environment"]>;

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
  setupLabel: "Complete" | "Required" | "Not required";
  providerLabel: "On" | "Off" | "Always available";
  checkoutLabel: "Visible" | "Hidden" | "Hidden by flow" | "Unavailable";
  environmentLabel: string;
  healthLabel: "Not checked" | "Not applicable";
  effective: boolean;
  canSelect: boolean;
}

export interface SavedCheckoutFlowProjection {
  checkoutMode: string;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

const FALLBACK_BLOCKED_COPY = "This method is unavailable for buyer checkout.";

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
    setupLabel: (isCod ? "Not required" : configured ? "Complete" : "Required") as PaymentMethodOutcome["setupLabel"],
    providerLabel: (isCod ? "Always available" : providerEnabled ? "On" : "Off") as PaymentMethodOutcome["providerLabel"],
    environmentLabel: getEnvironmentLabel(method, environment),
    healthLabel: isCod ? "Not applicable" as const : "Not checked" as const,
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
      label: isCod ? "Available, hidden" : "Configured, hidden",
      description: isCod
        ? "COD is available, but it is not selected for buyer checkout."
        : "Provider setup is complete, but it is not selected for buyer checkout.",
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
    description: "This method is included in the current buyer checkout flow.",
    checkoutLabel: "Visible",
    effective: true,
  };
}

export function getEligibleDefaultPaymentMethods(options: {
  methods: readonly MethodKey[];
  statuses: Partial<Record<MethodKey, GatewayStatus>>;
  selectedMethods: ReadonlySet<MethodKey>;
  flowAllowed: (method: MethodKey) => boolean | undefined;
}): MethodKey[] {
  return options.methods.filter((method) => {
    if (!options.selectedMethods.has(method) || options.flowAllowed(method) !== true) return false;
    return getPaymentMethodOutcome({
      method,
      status: options.statuses[method],
      checkoutSelected: true,
      flowAllowed: true,
    }).canSelect;
  });
}

export function getPaymentMethodFlowEligibility(
  method: MethodKey,
  flow: SavedCheckoutFlowProjection,
): boolean {
  if (flow.partialPaymentEnabled) {
    if (!Number.isFinite(flow.partialPaymentAmount) || flow.partialPaymentAmount <= 0) return false;
    if (flow.checkoutMode === "guest_cod_only") return false;
    return method !== "cod";
  }
  if (flow.checkoutMode === "guest_cod_only") return method === "cod";
  if (flow.checkoutMode === "gateways_only") return method !== "cod";
  return true;
}

export function getPaymentMethodFlowExclusionReason(
  method: MethodKey,
  flow: SavedCheckoutFlowProjection,
): string | null {
  if (getPaymentMethodFlowEligibility(method, flow)) return null;
  if (flow.partialPaymentEnabled && (!Number.isFinite(flow.partialPaymentAmount) || flow.partialPaymentAmount <= 0)) {
    return "The saved online advance amount is invalid. Fix Checkout Flow before offering payment methods.";
  }
  if (flow.partialPaymentEnabled && flow.checkoutMode === "guest_cod_only") {
    return "The saved COD-only flow conflicts with an online advance. Fix Checkout Flow before offering payment methods.";
  }
  if (flow.partialPaymentEnabled && method === "cod") {
    return "COD is hidden while an online advance is required.";
  }
  if (flow.checkoutMode === "guest_cod_only" && method !== "cod") {
    return "COD only hides online gateways from buyers.";
  }
  if (flow.checkoutMode === "gateways_only" && method === "cod") {
    return "Online only hides COD from buyers.";
  }
  return "The saved checkout flow excludes this method.";
}
