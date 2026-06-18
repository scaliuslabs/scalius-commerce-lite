import type { DeliveryProviderRecord } from "@/types/api-responses";

export type OrderTimestamp = Date | string | number;
export type ShipmentMetadata = Record<string, unknown> | string | null;

export interface OrderItem {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  productName: string | null;
  productImage: string | null;
  variantSize: string | null;
  variantColor: string | null;
  fulfillmentStatus?: string | null;
}

export interface Order {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area: string | null;
  notes: string | null;
  discountAmount: number | null;
  shippingCharge: number;
  status: string;
  createdAt: OrderTimestamp;
  updatedAt: OrderTimestamp;
  items: OrderItem[];
  totalAmount: number;
  customerId: string | null;
  cityName?: string;
  zoneName?: string;
  areaName?: string | null;
  shipments?: OrderShipment[];
  deliveryProviders?: DeliveryProviderRecord[];
  // Payment fields
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  paidAmount?: number | null;
  balanceDue?: number | null;
  fulfillmentStatus?: string | null;
  inventoryPool?: string | null;
}

export interface OrderShipment {
  id: string;
  orderId: string;
  providerId: string | null;
  providerType: string | null;
  providerName?: string | null;
  externalId: string | null;
  trackingId: string | null;
  trackingUrl?: string | null;
  courierName?: string | null;
  status: string;
  rawStatus: string | null;
  note?: string | null;
  metadata?: ShipmentMetadata;
  shipmentItems?: string | null;
  shipmentAmount?: number | null;
  isFinalShipment?: boolean | null;
  createdAt: OrderTimestamp;
  updatedAt?: OrderTimestamp;
  lastChecked?: OrderTimestamp | null;
}

// All valid order statuses — matches the state machine in order-state-machine.ts
export const ORDER_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
  "returned",
  "refunded",
  "partially_refunded",
  "incomplete",
] as const;

// State machine transitions — which statuses can transition to which.
// Mirrors ORDER_STATUS_TRANSITIONS in packages/core/src/modules/orders/order-state-machine.ts
export const ORDER_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  incomplete: ["pending", "cancelled"],
  pending: ["processing", "confirmed", "cancelled"],
  processing: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled"],
  shipped: ["delivered", "returned", "cancelled"],
  delivered: ["completed", "returned", "refunded", "partially_refunded"],
  completed: ["returned", "refunded", "partially_refunded"],
  cancelled: ["pending", "confirmed"],
  returned: ["refunded"],
  refunded: [],
  partially_refunded: ["refunded"],
} as const;

/** Get valid next statuses for a given current status */
export function getAvailableTransitions(currentStatus: string): string[] {
  return [...(ORDER_STATUS_TRANSITIONS[currentStatus.toLowerCase()] || [])];
}
