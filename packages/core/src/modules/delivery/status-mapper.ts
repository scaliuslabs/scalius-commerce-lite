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
    case "redx":
      return mapRedXStatus(status);
    default:
      return ShipmentStatusCode.UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// Pathao: explicit event-name-to-status mapping
// The `event` field values come directly from the Pathao webhook spec.
// ---------------------------------------------------------------------------
const PATHAO_EVENT_MAP: Record<string, ShipmentStatusCode> = {
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
  "order.paid": ShipmentStatusCode.DELIVERED, // payment settled
  "order.paid-return": ShipmentStatusCode.RETURNED,
  "order.exchanged": ShipmentStatusCode.DELIVERED,
  // Store events are intentionally omitted — handled in the webhook route
};

function mapPathaoStatus(event: string): string {
  const mapped = PATHAO_EVENT_MAP[event];
  if (mapped) return mapped;

  console.warn(`[status-mapper] Unmapped Pathao event: "${event}" - defaulting to ${ShipmentStatusCode.UNKNOWN}`);
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

// ---------------------------------------------------------------------------
// RedX: explicit status-to-status mapping
// The `status` field values come directly from the RedX webhook spec.
// ---------------------------------------------------------------------------
const REDX_STATUS_MAP: Record<string, ShipmentStatusCode> = {
  "pickup-pending": ShipmentStatusCode.PENDING,
  "ready-for-delivery": ShipmentStatusCode.PICKED_UP,
  "delivery-in-progress": ShipmentStatusCode.IN_TRANSIT,
  "delivered": ShipmentStatusCode.DELIVERED,
  "agent-hold": ShipmentStatusCode.ON_HOLD,
  "agent-returning": ShipmentStatusCode.IN_TRANSIT,
  "returned": ShipmentStatusCode.RETURNED,
  "agent-area-change": ShipmentStatusCode.IN_TRANSIT,
  "cancelled": ShipmentStatusCode.CANCELLED,
};

function mapRedXStatus(status: string): string {
  const mapped = REDX_STATUS_MAP[status.toLowerCase()];
  if (mapped) return mapped;

  console.warn(`[status-mapper] Unmapped RedX status: "${status}" - defaulting to ${ShipmentStatusCode.UNKNOWN}`);
  return ShipmentStatusCode.UNKNOWN;
}
