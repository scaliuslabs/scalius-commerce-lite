export type MethodKey = "stripe" | "sslcommerz" | "cod";

export interface GatewayStatus {
  configured: boolean;
  enabled: boolean;
  usable?: boolean;
  /** Keys still to add before the gateway can be turned on. */
  missingFields?: string[];
  blockedReason?: string;
  providerEnabled?: boolean;
  environment?: "test" | "live" | "mixed" | "unknown" | "not_applicable";
}

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
  /** Buyers see this method at checkout right now. */
  effective: boolean;
  /** The merchant may turn this method on at checkout. */
  canSelect: boolean;
}

export interface SavedCheckoutFlowProjection {
  checkoutMode: string;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

/**
 * What buyers get for one method. Fails closed: missing setup, a disabled
 * provider, a store-level block (e.g. currency) or an unreadable checkout
 * flow never reports the method as visible.
 */
export function getPaymentMethodOutcome(options: {
  method: MethodKey;
  status: GatewayStatus | undefined;
  checkoutSelected: boolean;
  flowAllowed: boolean | undefined;
  eligibilityIssue?: string | null;
}): PaymentMethodOutcome {
  const { method, status, checkoutSelected, flowAllowed, eligibilityIssue } = options;
  const isCod = method === "cod";
  const usable = isCod || status?.usable === true;
  const result = (state: PaymentMethodOutcomeState, canSelect = usable): PaymentMethodOutcome => ({
    state,
    effective: state === "visible",
    canSelect,
  });

  if (!isCod && status?.configured !== true) return result("needs_setup");
  if (!isCod && (status?.providerEnabled ?? status?.enabled) !== true) return result("provider_off");
  if (!usable) return result("blocked");
  if (eligibilityIssue) return result("blocked", false);
  if (!checkoutSelected) return result("ready_hidden");
  if (flowAllowed === undefined) return result("flow_unknown");
  if (!flowAllowed) return result("hidden_by_flow");
  return result("visible");
}

export function getEligibleDefaultPaymentMethods(options: {
  methods: readonly MethodKey[];
  statuses: Partial<Record<MethodKey, GatewayStatus>>;
  selectedMethods: ReadonlySet<MethodKey>;
  flowAllowed: (method: MethodKey) => boolean | undefined;
  eligibilityIssue?: (method: MethodKey) => string | null;
}): MethodKey[] {
  return options.methods.filter((method) => {
    if (!options.selectedMethods.has(method) || options.flowAllowed(method) !== true) return false;
    return getPaymentMethodOutcome({
      method,
      status: options.statuses[method],
      checkoutSelected: true,
      flowAllowed: true,
      eligibilityIssue: options.eligibilityIssue?.(method),
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

export type FlowExclusion = "advanceInvalid" | "codOnlyWithAdvance" | "codHiddenByAdvance" | "codOnly" | "onlineOnly";

export function getPaymentMethodFlowExclusionReason(
  method: MethodKey,
  flow: SavedCheckoutFlowProjection,
): FlowExclusion | null {
  if (getPaymentMethodFlowEligibility(method, flow)) return null;
  if (flow.partialPaymentEnabled && (!Number.isFinite(flow.partialPaymentAmount) || flow.partialPaymentAmount <= 0)) {
    return "advanceInvalid";
  }
  if (flow.partialPaymentEnabled && flow.checkoutMode === "guest_cod_only") return "codOnlyWithAdvance";
  if (flow.partialPaymentEnabled) return "codHiddenByAdvance";
  return flow.checkoutMode === "guest_cod_only" ? "codOnly" : "onlineOnly";
}
