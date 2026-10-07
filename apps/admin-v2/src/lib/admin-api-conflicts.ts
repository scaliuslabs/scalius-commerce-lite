/**
 * The refusals only some screens read: a product, promotion or category saved
 * over a newer revision, a manual order's discount or request mismatch, an app
 * rule, a taken phone. They live apart from `admin-api-error` (which every
 * screen loads) so those screens carry them and the rest do not.
 */
import { readAdminApiError } from "./admin-api-error";

export interface ProductRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface PromotionRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

export interface CategoryRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

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

export interface ProductMediaSkuReferenceConflict {
  affectedCount: number;
  affectedAssociationIds: string[];
  affectedSkus: Array<{ id: string; sku: string; imageId: string }>;
}

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
      "CONFLICT",
      "FORBIDDEN",
      "NOT_FOUND",
      "UNAUTHORIZED",
      "VALIDATION_ERROR",
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
    || parsed.code !== "VALIDATION_ERROR"
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

export function readAdminOrderCreateRequestMismatch(
  error: unknown,
): AdminOrderCreateRequestMismatch | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "ADMIN_ORDER_CREATE_REQUEST_MISMATCH" ||
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

export function readProductRevisionConflict(
  error: unknown,
): ProductRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "PRODUCT_REVISION_CONFLICT" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  if (
    typeof details.expectedRevision !== "number" ||
    !Number.isInteger(details.expectedRevision) ||
    details.expectedRevision < 1 ||
    !(
      details.currentRevision === null ||
      (typeof details.currentRevision === "number" &&
        Number.isInteger(details.currentRevision) &&
        details.currentRevision >= 1)
    )
  ) {
    return null;
  }

  return {
    expectedRevision: details.expectedRevision,
    currentRevision: details.currentRevision,
  };
}

export function readPromotionRevisionConflict(
  error: unknown,
): PromotionRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "PROMOTION_REVISION_CONFLICT" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  if (
    typeof details.expectedRevision !== "number" ||
    !Number.isInteger(details.expectedRevision) ||
    details.expectedRevision < 1 ||
    !(
      details.currentRevision === null ||
      (typeof details.currentRevision === "number" &&
        Number.isInteger(details.currentRevision) &&
        details.currentRevision >= 1)
    )
  ) {
    return null;
  }

  return {
    expectedRevision: details.expectedRevision,
    currentRevision: details.currentRevision,
  };
}

export function readProductMediaSkuReferenceConflict(
  error: unknown,
): ProductMediaSkuReferenceConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }
  const details = parsed.details as {
    affectedCount?: unknown;
    affectedAssociationIds?: unknown;
    affectedSkus?: unknown;
  };
  if (
    typeof details.affectedCount !== "number" ||
    !Number.isInteger(details.affectedCount) ||
    details.affectedCount < 1 ||
    !Array.isArray(details.affectedAssociationIds) ||
    details.affectedAssociationIds.length > 20 ||
    !details.affectedAssociationIds.every((id) => typeof id === "string" && id.length > 0) ||
    !Array.isArray(details.affectedSkus) ||
    details.affectedSkus.length > 5
  ) {
    return null;
  }
  const affectedSkus = details.affectedSkus.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { id?: unknown; sku?: unknown; imageId?: unknown };
    return typeof candidate.id === "string"
      && typeof candidate.sku === "string"
      && typeof candidate.imageId === "string"
      ? [{ id: candidate.id, sku: candidate.sku, imageId: candidate.imageId }]
      : [];
  });
  if (affectedSkus.length !== details.affectedSkus.length) return null;
  return {
    affectedCount: details.affectedCount,
    affectedAssociationIds: [...details.affectedAssociationIds],
    affectedSkus,
  };
}

export function readCategoryRevisionConflict(
  error: unknown,
): CategoryRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "CATEGORY_REVISION_CONFLICT" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  if (
    typeof details.expectedRevision !== "number" ||
    !Number.isInteger(details.expectedRevision) ||
    details.expectedRevision < 1 ||
    !(
      details.currentRevision === null ||
      (typeof details.currentRevision === "number" &&
        Number.isInteger(details.currentRevision) &&
        details.currentRevision >= 1)
    )
  ) {
    return null;
  }

  return {
    expectedRevision: details.expectedRevision,
    currentRevision: details.currentRevision,
  };
}

export interface CustomerPhoneConflict {
  id: string;
  name: string;
  phone: string;
  kind: "account" | "guest" | "merchant";
}

/** The other active customer that already uses a phone (a 400 VALIDATION_ERROR on customer create/update). */
export function readCustomerPhoneConflict(error: unknown): CustomerPhoneConflict | null {
  const parsed = readAdminApiError(error);
  if (parsed?.status !== 400 || parsed.code !== "VALIDATION_ERROR") return null;
  const customer = (parsed.details as { customer?: Record<string, unknown> } | null | undefined)?.customer;
  if (!customer || typeof customer !== "object") return null;
  const { id, name, phone, kind } = customer;
  if (typeof id !== "string" || typeof name !== "string" || typeof phone !== "string") return null;
  if (kind !== "account" && kind !== "guest" && kind !== "merchant") return null;
  return { id, name, phone, kind };
}
