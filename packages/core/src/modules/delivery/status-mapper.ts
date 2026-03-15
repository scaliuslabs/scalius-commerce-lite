import type { DeliveryProviderType } from "@scalius/database/schema";

/**
 * Standardized shipment status codes
 */
export enum ShipmentStatusCode {
  PENDING = "pending",
  PICKUP_ASSIGNED = "pickup_assigned",
  PICKED_UP = "picked_up",
  PICKUP_FAILED = "pickup_failed",
  IN_TRANSIT = "in_transit",
  OUT_FOR_DELIVERY = "out_for_delivery",
  DELIVERED = "delivered",
  PARTIAL_DELIVERED = "partial_delivered",
  DELIVERY_FAILED = "delivery_failed",
  ON_HOLD = "on_hold",
  FAILED = "failed",
  CANCELLED = "cancelled",
  RETURNED = "returned",
  UNKNOWN = "unknown",
}

/**
 * Map provider-specific statuses to our standardized status codes
 */
export function mapProviderStatus(
  providerType: DeliveryProviderType,
  status: string,
): string {
  switch (providerType) {
    case "pathao":
      return mapPathaoStatus(status);
    case "steadfast":
      return mapSteadfastStatus(status);
    default:
      return ShipmentStatusCode.UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// Pathao: handles BOTH webhook event names AND API order_status values.
//
// Webhook events use format: "order.pickup-cancelled"
// API checkShipmentStatus returns: "Pickup Cancel", "Pickup_Cancelled", "Pending", etc.
//
// We normalize both to a single lookup.
// ---------------------------------------------------------------------------
const PATHAO_STATUS_MAP: Record<string, ShipmentStatusCode> = {
  // --- Webhook event format (from Pathao webhook spec) ---
  "order.created": ShipmentStatusCode.PENDING,
  "order.updated": ShipmentStatusCode.PENDING,
  "order.pickup-requested": ShipmentStatusCode.PENDING,
  "order.assigned-for-pickup": ShipmentStatusCode.PICKUP_ASSIGNED,
  "order.picked": ShipmentStatusCode.PICKED_UP,
  "order.pickup-failed": ShipmentStatusCode.PICKUP_FAILED,
  "order.pickup-cancelled": ShipmentStatusCode.CANCELLED,
  "order.at-the-sorting-hub": ShipmentStatusCode.IN_TRANSIT,
  "order.in-transit": ShipmentStatusCode.IN_TRANSIT,
  "order.received-at-last-mile-hub": ShipmentStatusCode.IN_TRANSIT,
  "order.assigned-for-delivery": ShipmentStatusCode.OUT_FOR_DELIVERY,
  "order.delivered": ShipmentStatusCode.DELIVERED,
  "order.partial-delivery": ShipmentStatusCode.PARTIAL_DELIVERED,
  "order.returned": ShipmentStatusCode.RETURNED,
  "order.delivery-failed": ShipmentStatusCode.DELIVERY_FAILED,
  "order.on-hold": ShipmentStatusCode.ON_HOLD,
  "order.paid": ShipmentStatusCode.DELIVERED,
  "order.paid-return": ShipmentStatusCode.RETURNED,
  "order.exchanged": ShipmentStatusCode.DELIVERED,

  // --- API order_status format (from checkShipmentStatus / order info endpoint) ---
  // Pathao returns human-readable strings like "Pickup Cancel", "Pending", etc.
  // We normalize to lowercase with spaces→underscores for matching.
  "pending": ShipmentStatusCode.PENDING,
  "pickup_requested": ShipmentStatusCode.PENDING,
  "assigned_for_pickup": ShipmentStatusCode.PICKUP_ASSIGNED,
  "picked": ShipmentStatusCode.PICKED_UP,
  "pickup": ShipmentStatusCode.PICKED_UP,
  "pickup_failed": ShipmentStatusCode.PICKUP_FAILED,
  "pickup_cancel": ShipmentStatusCode.CANCELLED,
  "pickup_cancelled": ShipmentStatusCode.CANCELLED,
  "at_the_sorting_hub": ShipmentStatusCode.IN_TRANSIT,
  "in_transit": ShipmentStatusCode.IN_TRANSIT,
  "received_at_last_mile_hub": ShipmentStatusCode.IN_TRANSIT,
  "assigned_for_delivery": ShipmentStatusCode.OUT_FOR_DELIVERY,
  "delivered": ShipmentStatusCode.DELIVERED,
  "partial_delivery": ShipmentStatusCode.PARTIAL_DELIVERED,
  "partial_delivered": ShipmentStatusCode.PARTIAL_DELIVERED,
  "return": ShipmentStatusCode.RETURNED,
  "returned": ShipmentStatusCode.RETURNED,
  "delivery_failed": ShipmentStatusCode.DELIVERY_FAILED,
  "on_hold": ShipmentStatusCode.ON_HOLD,
  "payment_invoice": ShipmentStatusCode.DELIVERED,
  "paid_return": ShipmentStatusCode.RETURNED,
  "exchange": ShipmentStatusCode.DELIVERED,
};

function mapPathaoStatus(rawStatus: string): string {
  // First try exact match (handles webhook events like "order.delivered")
  const exact = PATHAO_STATUS_MAP[rawStatus];
  if (exact) return exact;

  // Normalize: "Pickup Cancel" → "pickup_cancel", "Pickup_Cancelled" → "pickup_cancelled"
  const normalized = rawStatus.toLowerCase().replace(/\s+/g, "_");
  const mapped = PATHAO_STATUS_MAP[normalized];
  if (mapped) return mapped;

  console.warn(`[status-mapper] Unmapped Pathao status: "${rawStatus}" (normalized: "${normalized}") - defaulting to ${ShipmentStatusCode.UNKNOWN}`);
  return ShipmentStatusCode.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Steadfast: explicit status-to-status mapping
// The `status` field values come directly from the Steadfast webhook spec.
// ---------------------------------------------------------------------------
const STEADFAST_STATUS_MAP: Record<string, ShipmentStatusCode> = {
  "pending": ShipmentStatusCode.PENDING,
  "in_review": ShipmentStatusCode.PENDING,
  "hold": ShipmentStatusCode.ON_HOLD,
  "delivered": ShipmentStatusCode.DELIVERED,
  "delivered_approval_pending": ShipmentStatusCode.DELIVERED,
  "partial_delivered": ShipmentStatusCode.PARTIAL_DELIVERED,
  "partial_delivered_approval_pending": ShipmentStatusCode.PARTIAL_DELIVERED,
  "cancelled": ShipmentStatusCode.CANCELLED,
  "cancelled_approval_pending": ShipmentStatusCode.CANCELLED,
  "unknown": ShipmentStatusCode.UNKNOWN,
  "unknown_approval_pending": ShipmentStatusCode.UNKNOWN,
};

function mapSteadfastStatus(status: string): string {
  // Steadfast may send mixed-case (e.g. "Delivered"); normalize to lowercase
  const mapped = STEADFAST_STATUS_MAP[status.toLowerCase()];
  if (mapped) return mapped;

  console.warn(`[status-mapper] Unmapped Steadfast status: "${status}" - defaulting to ${ShipmentStatusCode.UNKNOWN}`);
  return ShipmentStatusCode.UNKNOWN;
}

