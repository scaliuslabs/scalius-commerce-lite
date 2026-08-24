import type { CartValidationIssue } from "../api/orders";

const ISSUE_CODES = new Set<CartValidationIssue["code"]>([
  "PRODUCT_UNAVAILABLE",
  "VARIANT_REQUIRED",
  "VARIANT_UNAVAILABLE",
  "VARIANT_MISMATCH",
  "QUANTITY_UNAVAILABLE",
  "PRICE_CHANGED",
]);
const ISSUE_ACTIONS = new Set<CartValidationIssue["action"]>([
  "remove",
  "select_variant",
  "reduce_quantity",
  "refresh_item",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function issueDetails(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.error) && isRecord(payload.error.details)) {
    return payload.error.details;
  }
  return isRecord(payload.details) ? payload.details : null;
}

export function parseTaxQuoteCartIssues(payload: unknown): CartValidationIssue[] {
  const rawIssues = issueDetails(payload)?.itemIssues;
  if (!Array.isArray(rawIssues)) return [];

  return rawIssues.slice(0, 99).flatMap((value): CartValidationIssue[] => {
    if (!isRecord(value)) return [];
    const index = value.index;
    const productId = boundedString(value.productId, 180);
    const code = value.code;
    const action = value.action;
    const message = boundedString(value.message, 300);
    const requestedQuantity = value.requestedQuantity;
    if (
      typeof index !== "number"
      || !Number.isSafeInteger(index)
      || index < 0
      || !productId
      || !ISSUE_CODES.has(code as CartValidationIssue["code"])
      || !ISSUE_ACTIONS.has(action as CartValidationIssue["action"])
      || !message
      || typeof requestedQuantity !== "number"
      || !Number.isSafeInteger(requestedQuantity)
      || requestedQuantity < 1
      || requestedQuantity > 99
    ) {
      return [];
    }

    const cartKey = boundedString(value.cartKey, 256);
    const variantId = boundedString(value.variantId, 180);
    const productName = boundedString(value.productName, 200);
    const variantLabel = boundedString(value.variantLabel, 200);
    return [{
      index,
      ...(cartKey ? { cartKey } : {}),
      productId,
      variantId,
      code: code as CartValidationIssue["code"],
      action: action as CartValidationIssue["action"],
      message,
      productName,
      variantLabel,
      requestedQuantity,
      ...(optionalFiniteNumber(value.availableQuantity) !== undefined
        ? { availableQuantity: optionalFiniteNumber(value.availableQuantity) }
        : {}),
      ...(optionalFiniteNumber(value.submittedPrice) !== undefined
        ? { submittedPrice: optionalFiniteNumber(value.submittedPrice) }
        : {}),
      ...(optionalFiniteNumber(value.currentPrice) !== undefined
        ? { currentPrice: optionalFiniteNumber(value.currentPrice) }
        : {}),
    }];
  });
}
