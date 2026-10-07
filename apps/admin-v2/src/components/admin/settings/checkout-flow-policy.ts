/** Issue keys; the payments catalog words them. */
export type CheckoutFlowIssue =
    | "readinessUnknown"
    | "noMethod"
    | "codOff"
    | "noOnline"
    | "amountInvalid"
    | "advanceRange"
    | "wholeTaka"
    | "codWithAdvance"
    | "advanceNeedsOnline";

/**
 * A provider's charge limits in major units (`GET /admin/settings/payment-methods`
 * gateways' `amountLimits`): an advance it collects must fit them.
 */
export interface AdvanceAmountLimit {
    /** The payment method whose limit it is. */
    method: string;
    currency: string;
    min: number;
    max: number;
}

export interface CheckoutFlowPreviewOptions {
    checkoutMode: string;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    paymentMethodsUnavailable: boolean;
    paymentMethodsLoaded: boolean;
    codEnabled: boolean;
    activeOnlineMethodCount: number;
    /** The limits of the online methods checkout offers (a provider without limits adds none). */
    advanceLimits?: readonly AdvanceAmountLimit[];
    /** The store prices in whole units (a BDT store's default): the advance has no paisa. */
    wholeTaka?: boolean;
}

/** The first offered method's limit the advance falls outside, or null. */
export function violatedAdvanceLimit(amount: unknown, limits: readonly AdvanceAmountLimit[] = []): AdvanceAmountLimit | null {
    const numericAmount = Number(amount);
    return limits.find((limit) => numericAmount < limit.min || numericAmount > limit.max) ?? null;
}

export function getCheckoutAdvancePaymentAmountIssue(
    amount: unknown,
    options: { advanceLimits?: readonly AdvanceAmountLimit[]; wholeTaka?: boolean },
): CheckoutFlowIssue | null {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return "amountInvalid";
    if (options.wholeTaka && !Number.isInteger(numericAmount)) return "wholeTaka";
    return violatedAdvanceLimit(numericAmount, options.advanceLimits) ? "advanceRange" : null;
}

/**
 * Mirrors the server's checkout-flow validation so the dashboard fails
 * closed: an unreadable payment-method state blocks saving outright.
 */
export function getCheckoutFlowPreviewIssues(options: CheckoutFlowPreviewOptions): CheckoutFlowIssue[] {
    if (options.paymentMethodsUnavailable || !options.paymentMethodsLoaded) return ["readinessUnknown"];

    const issues: CheckoutFlowIssue[] = [];
    if (options.checkoutMode === "all" && !options.codEnabled && options.activeOnlineMethodCount === 0) {
        issues.push("noMethod");
    }
    if (options.checkoutMode === "guest_cod_only" && !options.codEnabled) issues.push("codOff");
    if (options.checkoutMode === "gateways_only" && options.activeOnlineMethodCount === 0) issues.push("noOnline");

    if (!options.partialPaymentEnabled) return issues;

    const amountIssue = getCheckoutAdvancePaymentAmountIssue(options.partialPaymentAmount, {
        advanceLimits: options.advanceLimits,
        wholeTaka: options.wholeTaka,
    });
    if (amountIssue) issues.push(amountIssue);
    if (options.checkoutMode === "guest_cod_only") issues.push("codWithAdvance");
    if (options.activeOnlineMethodCount === 0) issues.push("advanceNeedsOnline");
    return issues;
}
