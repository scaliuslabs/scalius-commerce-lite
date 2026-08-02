import type {
  CheckoutCommitCommand,
  CheckoutCommittedOrderRow,
  CheckoutReservationRequest,
} from "@scalius/database/checkout-commit";

import { ValidationError } from "../../errors";
import type { AtomicCheckoutAttempt } from "./checkout-attempts";
import { hashOrderReceiptToken } from "./order-receipts";
import type { StorefrontOrderCommitPayload } from "./orders.types";

export type CoordinatedCheckoutEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "non_regular_inventory_pool"
        | "non_cod_payment"
        | "legacy_discount"
        | "promotion";
    };

/**
 * Version 1 deliberately starts with the common, contention-heavy COD regular
 * stock path. Unsupported flows retain the existing fully atomic commit until
 * their projector and transition invariants are proven at the same bar.
 */
export function getCoordinatedCheckoutEligibility(
  payload: StorefrontOrderCommitPayload,
): CoordinatedCheckoutEligibility {
  if (payload.orderData.inventoryPool !== "regular") {
    return { eligible: false, reason: "non_regular_inventory_pool" };
  }
  if (payload.orderData.paymentMethod !== "cod") {
    return { eligible: false, reason: "non_cod_payment" };
  }
  if (payload.discountUsage) {
    return { eligible: false, reason: "legacy_discount" };
  }
  if (payload.promotion) {
    return { eligible: false, reason: "promotion" };
  }
  return { eligible: true };
}

function buildOrderRow(payload: StorefrontOrderCommitPayload): CheckoutCommittedOrderRow {
  const order = payload.orderData;
  const accountOwnerCustomerId = payload.existingCustomer?.id ?? null;
  return {
    id: order.id,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerEmail: order.customerEmail,
    shippingAddress: order.shippingAddress,
    city: order.city,
    zone: order.zone,
    area: order.area,
    cityName: order.cityName,
    zoneName: order.zoneName,
    areaName: order.areaName,
    totalAmount: order.totalAmount,
    shippingCharge: order.shippingCharge,
    discountAmount: order.discountAmount,
    currencyCode: order.currencyCode,
    currencyDecimalPlaces: order.currencyDecimalPlaces,
    subtotalAmountMinor: order.subtotalAmountMinor,
    shippingAmountMinor: order.shippingAmountMinor,
    discountAmountMinor: order.discountAmountMinor,
    taxAmountMinor: order.taxAmountMinor,
    totalAmountMinor: order.totalAmountMinor,
    taxLabel: order.taxLabel,
    pricesIncludeTax: order.pricesIncludeTax,
    status: order.status,
    notes: order.notes,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    paidAmount: order.paidAmount,
    balanceDue: order.balanceDue,
    fulfillmentStatus: order.fulfillmentStatus,
    inventoryPool: order.inventoryPool,
    inventoryAction: order.inventoryAction,
    // Authenticated ownership is already authoritative. Guest customer
    // identity/statistics are a deterministic projection of the aggregate.
    customerId: accountOwnerCustomerId,
    accountOwnerCustomerId,
  };
}

function buildReservationRequests(
  payload: StorefrontOrderCommitPayload,
): CheckoutReservationRequest[] {
  if (payload.orderData.inventoryAction !== "reserved") return [];

  const quantities = new Map<string, number>();
  for (const item of payload.items) {
    if (item.inventoryTracked === false) continue;
    quantities.set(item.variantId, (quantities.get(item.variantId) ?? 0) + item.quantity);
  }

  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([variantId, quantity]) => ({
      variantId,
      pool: "regular" as const,
      quantity,
    }));
}

export async function prepareCheckoutCommitCommand<TResponse extends Record<string, unknown>>(
  payload: StorefrontOrderCommitPayload,
  attempt: AtomicCheckoutAttempt,
  response: TResponse,
): Promise<CheckoutCommitCommand<StorefrontOrderCommitPayload, TResponse>> {
  const eligibility = getCoordinatedCheckoutEligibility(payload);
  if (!eligibility.eligible) {
    throw new ValidationError(
      `Checkout is not eligible for aggregate commit version 1 (${eligibility.reason}).`,
    );
  }
  if (
    attempt.orderId !== payload.orderData.id
    || attempt.checkoutToken !== payload.checkoutToken
  ) {
    throw new ValidationError("Checkout attempt identity does not match the prepared order.");
  }
  if (
    "orderId" in response
    && typeof response.orderId === "string"
    && response.orderId !== payload.orderData.id
  ) {
    throw new ValidationError("Checkout response identity does not match the prepared order.");
  }
  if (
    "receiptToken" in response
    && typeof response.receiptToken === "string"
    && response.receiptToken !== payload.checkoutToken
  ) {
    throw new ValidationError("Checkout receipt proof does not match the prepared order.");
  }
  if (
    !Number.isSafeInteger(payload.checkoutAuthorityRevision)
    || (payload.checkoutAuthorityRevision ?? 0) < 1
  ) {
    throw new ValidationError("Checkout authority revision is unavailable. Please retry checkout.");
  }

  const receiptHash = await hashOrderReceiptToken(payload.checkoutToken);
  return {
    requestKey: attempt.requestKey,
    requestHash: attempt.requestHash,
    receiptHash,
    authorityRevision: payload.checkoutAuthorityRevision!,
    order: buildOrderRow(payload),
    response,
    reservations: buildReservationRequests(payload),
    aggregate: {
      schemaVersion: 1,
      checkout: {
        requestKey: attempt.requestKey,
        requestHash: attempt.requestHash,
        receiptHash,
        authorityRevision: payload.checkoutAuthorityRevision!,
        response,
      },
      payload,
      projection: {
        checkoutAttemptId: `coa_${crypto.randomUUID()}`,
        guestCustomerId: payload.existingCustomer
          ? null
          : `cust_${crypto.randomUUID()}`,
        customerHistoryId: payload.existingCustomer
          ? null
          : `hist_${crypto.randomUUID()}`,
        codTrackingId: `cod_${crypto.randomUUID()}`,
        notificationOutboxId:
          payload.checkoutSideEffects?.orderCreatedNotification === false
            ? null
            : `ono_${crypto.randomUUID()}`,
        metaPurchaseOutboxId:
          payload.checkoutSideEffects?.metaPurchase === false
            ? null
            : `mco_${crypto.randomUUID()}`,
      },
    },
  };
}
