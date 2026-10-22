/**
 * The refusals only the manual order form reads: a retryable quote read, the
 * discount limit, checkout rules, item issues and a create-request mismatch.
 * They live apart from the catalog's revision conflicts so the product and
 * customer pages do not carry them.
 */
import { readAdminApiError } from "./admin-api-error";

export type AdminOrderCreateRequestMismatch =
  | {
      state: "failed";
      canRetryWithNewKey: true;
    }
  | {
      state: "processing";
      canRetryWithNewKey: false;
    }
  | {
      state: "committed";
      canRetryWithNewKey: false;
      orderId: string;
    };

export interface ManualOrderDiscountLimitError {
  maximumAmount: number;
  currencyCode: string;
  decimalPlaces: number;
}

/** True only when retrying the same read can plausibly succeed. */
export function isAdminApiRetryableReadError(error: unknown): boolean {
  const parsed = readAdminApiError(error);
  if (!parsed) return true;
  if (parsed.status == null) {
    const permanentCodes = [
      "BAD_REQUEST",
      "conflict",
      "forbidden",
      "not_found",
      "unauthorized",
      "validation_error",
    ];
    return !permanentCodes.includes(parsed.code ?? "")
      && !parsed.code?.endsWith("_CONFLICT");
  }
  return parsed.status === 408
    || parsed.status === 425
    || parsed.status === 429
    || parsed.status >= 500;
}

export function readManualOrderDiscountLimitError(
  error: unknown,
): ManualOrderDiscountLimitError | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 400
    || parsed.code !== "validation_error"
    || !parsed.details
    || typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    reason?: unknown;
    maximumDiscountAmountMinor?: unknown;
    currencyCode?: unknown;
    decimalPlaces?: unknown;
  };
  if (
    details.reason !== "MANUAL_ORDER_DISCOUNT_EXCEEDS_SUBTOTAL"
    || typeof details.maximumDiscountAmountMinor !== "number"
    || !Number.isSafeInteger(details.maximumDiscountAmountMinor)
    || details.maximumDiscountAmountMinor < 0
    || typeof details.currencyCode !== "string"
    || !/^[A-Z]{3}$/.test(details.currencyCode)
    || typeof details.decimalPlaces !== "number"
    || !Number.isInteger(details.decimalPlaces)
    || details.decimalPlaces < 0
    || details.decimalPlaces > 3
  ) {
    return null;
  }

  return {
    maximumAmount:
      details.maximumDiscountAmountMinor / 10 ** details.decimalPlaces,
    currencyCode: details.currencyCode,
    decimalPlaces: details.decimalPlaces,
  };
}

/** An installed app's rule an order breaks (checkout functions, `cart.validate`). */
export interface CheckoutRuleError {
  code: string;
  /** Written by the app; shown as text. */
  message: string;
  /** The order line it is about, or null for the whole order. */
  index: number | null;
}

/** The apps' rule errors of a refused quote or order (`details.reason` = `cart_rules`), or null. */
export function readCheckoutRuleErrors(error: unknown): CheckoutRuleError[] | null {
  const parsed = readAdminApiError(error);
  if (parsed?.status !== 400 || !parsed.details || typeof parsed.details !== "object") return null;
  const details = parsed.details as { reason?: unknown; ruleErrors?: unknown };
  if (details.reason !== "cart_rules" || !Array.isArray(details.ruleErrors)) return null;
  const errors = details.ruleErrors.flatMap((entry: unknown): CheckoutRuleError[] => {
    if (!entry || typeof entry !== "object") return [];
    const { code, message, index } = entry as { code?: unknown; message?: unknown; index?: unknown };
    if (typeof code !== "string" || typeof message !== "string") return [];
    return [{ code, message, index: typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null }];
  });
  return errors.length > 0 ? errors : null;
}

/** One line of a manual order the API refused, by its position in the request, with the API's own words. */
export interface ManualOrderItemIssue {
  index: number;
  code: string;
  message: string;
}

/**
 * The per-line reasons of a refused manual order or quote (`details.itemIssues`):
 * a download on a cash on delivery order, a SKU out of stock, a retired SKU.
 */
export function readManualOrderItemIssues(error: unknown): ManualOrderItemIssue[] | null {
  const parsed = readAdminApiError(error);
  if (parsed?.status !== 400 || !parsed.details || typeof parsed.details !== "object") return null;
  const raw = (parsed.details as { itemIssues?: unknown }).itemIssues;
  if (!Array.isArray(raw)) return null;
  const issues = raw.flatMap((entry: unknown): ManualOrderItemIssue[] => {
    if (!entry || typeof entry !== "object") return [];
    const { index, code, message } = entry as { index?: unknown; code?: unknown; message?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || typeof message !== "string") return [];
    return [{ index, code: typeof code === "string" ? code : "", message }];
  });
  return issues.length > 0 ? issues : null;
}

export function readAdminOrderCreateRequestMismatch(
  error: unknown,
): AdminOrderCreateRequestMismatch | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "admin_order_create_request_mismatch" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    state?: unknown;
    canRetryWithNewKey?: unknown;
    orderId?: unknown;
  };
  if (details.state === "failed" && details.canRetryWithNewKey === true) {
    return { state: "failed", canRetryWithNewKey: true };
  }
  if (details.state === "processing" && details.canRetryWithNewKey === false) {
    return { state: "processing", canRetryWithNewKey: false };
  }
  if (
    details.state === "committed" &&
    details.canRetryWithNewKey === false &&
    typeof details.orderId === "string" &&
    details.orderId.length > 0 &&
    details.orderId.length <= 128
  ) {
    return {
      state: "committed",
      canRetryWithNewKey: false,
      orderId: details.orderId,
    };
  }
  return null;
}
