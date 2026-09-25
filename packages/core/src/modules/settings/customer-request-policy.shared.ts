/**
 * Browser-safe customer-request policy contract and projections.
 * Keep persistence and relational-provider imports in customer-request-policy.ts.
 */
export const CUSTOMER_REQUEST_INTRO_MAX_LENGTH = 240;

export const CUSTOMER_REQUEST_TYPES = [
  "cancel_pre_shipment",
  "return",
  "refund",
] as const;

export type CustomerRequestType = typeof CUSTOMER_REQUEST_TYPES[number];
export type CustomerRequestVisibility = "eligible_only" | "show_unavailable";

export interface CustomerRequestPolicy {
  cancellationEnabled: boolean;
  returnEnabled: boolean;
  refundEnabled: boolean;
  visibility: CustomerRequestVisibility;
  introText: string | null;
}

export interface CustomerRequestActionInput {
  type: CustomerRequestType;
  eligible: boolean;
  disabledReason: string | null;
}

export interface CustomerRequestActionView extends CustomerRequestActionInput {
  label: string;
  description: string;
  visible: boolean;
}

export interface CustomerRequestPreviewState {
  id: "pre_shipment" | "shipped_unpaid" | "delivered_paid";
  label: string;
  context: string;
  actions: CustomerRequestActionView[];
}

export const DEFAULT_CUSTOMER_REQUEST_INTRO =
  "Send a request and the store will review it before changing payment, shipment, or inventory.";

export const DEFAULT_CUSTOMER_REQUEST_POLICY: CustomerRequestPolicy = {
  cancellationEnabled: true,
  returnEnabled: true,
  refundEnabled: true,
  visibility: "eligible_only",
  introText: null,
};

export const CUSTOMER_REQUEST_ACTION_COPY: Record<CustomerRequestType, {
  label: string;
  requestLabel: string;
  description: string;
  disabledByMerchantReason: string;
}> = {
  cancel_pre_shipment: {
    label: "Cancellation request",
    requestLabel: "Request cancellation",
    description: "Ask the store to review this order before it ships.",
    disabledByMerchantReason: "This store does not accept cancellation requests online.",
  },
  return: {
    label: "Return request",
    requestLabel: "Request return",
    description: "Ask the store to review a return for this order.",
    disabledByMerchantReason: "This store does not accept return requests online.",
  },
  refund: {
    label: "Refund request",
    requestLabel: "Request refund",
    description: "Ask the store to review a payment refund.",
    disabledByMerchantReason: "This store does not accept refund requests online.",
  },
};

export const CUSTOMER_REQUEST_STATE_REASONS = {
  cancellationUnavailable: "Cancellation requests are available before shipment starts.",
  returnUnavailable: "Return requests are available after the order ships.",
  refundUnavailable: "Refund requests are available for paid orders after fulfillment starts.",
} as const;

/**
 * How the order reaches the buyer, for request wording: shipped to an
 * address, collected at the store, or nothing to hand over (a service).
 * Orders without the Wave A facts shipped.
 */
export type CustomerRequestDeliveryMode = "ship" | "pickup" | "none";

export function customerRequestDeliveryMode(order: {
  shippingMethodKind?: string | null;
  requiresShipping?: boolean | number | null;
}): CustomerRequestDeliveryMode {
  if (order.shippingMethodKind === "pickup") return "pickup";
  return order.requiresShipping === false || order.requiresShipping === 0 ? "none" : "ship";
}

/** Cancellation wording that names the real deadline: shipping, collection or the service. */
const CANCELLATION_COPY: Record<CustomerRequestDeliveryMode, { description: string; unavailable: string }> = {
  ship: {
    description: CUSTOMER_REQUEST_ACTION_COPY.cancel_pre_shipment.description,
    unavailable: CUSTOMER_REQUEST_STATE_REASONS.cancellationUnavailable,
  },
  pickup: {
    description: "Ask the store to review this order before it's collected.",
    unavailable: "Cancellation requests are available until the order is collected.",
  },
  none: {
    description: "Ask the store to review this order before the service is done.",
    unavailable: "Cancellation requests are available until the service is done.",
  },
};

export function cancellationRequestDescription(mode: CustomerRequestDeliveryMode = "ship"): string {
  return CANCELLATION_COPY[mode].description;
}

export function cancellationUnavailableReason(mode: CustomerRequestDeliveryMode = "ship"): string {
  return CANCELLATION_COPY[mode].unavailable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredPolicy(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeIntroText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const withoutControlCharacters = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  const normalized = withoutControlCharacters.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, CUSTOMER_REQUEST_INTRO_MAX_LENGTH) : null;
}

export function normalizeCustomerRequestPolicy(value: unknown): CustomerRequestPolicy {
  const parsed = parseStoredPolicy(value);
  const candidate = isRecord(parsed) ? parsed : {};
  return {
    cancellationEnabled: typeof candidate.cancellationEnabled === "boolean"
      ? candidate.cancellationEnabled
      : DEFAULT_CUSTOMER_REQUEST_POLICY.cancellationEnabled,
    returnEnabled: typeof candidate.returnEnabled === "boolean"
      ? candidate.returnEnabled
      : DEFAULT_CUSTOMER_REQUEST_POLICY.returnEnabled,
    refundEnabled: typeof candidate.refundEnabled === "boolean"
      ? candidate.refundEnabled
      : DEFAULT_CUSTOMER_REQUEST_POLICY.refundEnabled,
    visibility: candidate.visibility === "show_unavailable"
      ? "show_unavailable"
      : DEFAULT_CUSTOMER_REQUEST_POLICY.visibility,
    introText: normalizeIntroText(candidate.introText),
  };
}

export function getCustomerRequestIntro(policy: CustomerRequestPolicy): string {
  return policy.introText ?? DEFAULT_CUSTOMER_REQUEST_INTRO;
}

export function isCustomerRequestTypeEnabled(
  policy: CustomerRequestPolicy,
  type: CustomerRequestType,
): boolean {
  if (type === "cancel_pre_shipment") return policy.cancellationEnabled;
  if (type === "return") return policy.returnEnabled;
  return policy.refundEnabled;
}

export function projectCustomerRequestAction(
  policy: CustomerRequestPolicy,
  action: CustomerRequestActionInput,
  deliveryMode: CustomerRequestDeliveryMode = "ship",
): CustomerRequestActionView {
  const copy = CUSTOMER_REQUEST_ACTION_COPY[action.type];
  const enabled = isCustomerRequestTypeEnabled(policy, action.type);
  const eligible = enabled && action.eligible;
  return {
    ...action,
    label: copy.requestLabel,
    description: action.type === "cancel_pre_shipment"
      ? cancellationRequestDescription(deliveryMode)
      : copy.description,
    eligible,
    disabledReason: enabled ? action.disabledReason : copy.disabledByMerchantReason,
    visible: policy.visibility === "show_unavailable" || eligible,
  };
}

export function projectCustomerRequestActions(
  policy: CustomerRequestPolicy,
  actions: readonly CustomerRequestActionInput[],
  options: { includeHidden?: boolean; deliveryMode?: CustomerRequestDeliveryMode } = {},
): CustomerRequestActionView[] {
  const projected = actions.map((action) => projectCustomerRequestAction(policy, action, options.deliveryMode));
  return options.includeHidden ? projected : projected.filter((action) => action.visible);
}

const PREVIEW_ACTIONS: Record<CustomerRequestPreviewState["id"], CustomerRequestActionInput[]> = {
  pre_shipment: [
    { type: "cancel_pre_shipment", eligible: true, disabledReason: null },
    { type: "return", eligible: false, disabledReason: CUSTOMER_REQUEST_STATE_REASONS.returnUnavailable },
    { type: "refund", eligible: false, disabledReason: CUSTOMER_REQUEST_STATE_REASONS.refundUnavailable },
  ],
  shipped_unpaid: [
    { type: "cancel_pre_shipment", eligible: false, disabledReason: CUSTOMER_REQUEST_STATE_REASONS.cancellationUnavailable },
    { type: "return", eligible: true, disabledReason: null },
    { type: "refund", eligible: false, disabledReason: CUSTOMER_REQUEST_STATE_REASONS.refundUnavailable },
  ],
  delivered_paid: [
    { type: "cancel_pre_shipment", eligible: false, disabledReason: CUSTOMER_REQUEST_STATE_REASONS.cancellationUnavailable },
    { type: "return", eligible: true, disabledReason: null },
    { type: "refund", eligible: true, disabledReason: null },
  ],
};

export function getCustomerRequestPolicyPreview(
  policyInput: unknown,
): CustomerRequestPreviewState[] {
  const policy = normalizeCustomerRequestPolicy(policyInput);
  return [
    {
      id: "pre_shipment",
      label: "Before shipment",
      context: "Pending · unpaid",
      actions: projectCustomerRequestActions(policy, PREVIEW_ACTIONS.pre_shipment),
    },
    {
      id: "shipped_unpaid",
      label: "Shipped, unpaid",
      context: "Shipped · unpaid",
      actions: projectCustomerRequestActions(policy, PREVIEW_ACTIONS.shipped_unpaid),
    },
    {
      id: "delivered_paid",
      label: "Delivered, paid",
      context: "Delivered · paid",
      actions: projectCustomerRequestActions(policy, PREVIEW_ACTIONS.delivered_paid),
    },
  ];
}
