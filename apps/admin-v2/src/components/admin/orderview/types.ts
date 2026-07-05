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

export interface OrderRefundAttempt {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  gateway: string;
  status: string;
  providerStatus: string | null;
  active: boolean;
  severity: "info" | "success" | "warning" | "danger";
  label: string;
  message: string;
  createdAt: OrderTimestamp | null;
  updatedAt: OrderTimestamp | null;
  nextProbeAt: OrderTimestamp | null;
  lastProbeAt: OrderTimestamp | null;
  refundedAt: OrderTimestamp | null;
  failedAt: OrderTimestamp | null;
  reason?: string;
  refundPaymentId?: string;
  sourcePaymentId?: string;
  sourceTransactionId?: string | null;
  refundReference?: string;
  providerRefundId?: string | null;
  providerCorrelationId?: string | null;
  allocationIndex?: number;
  allocationCount?: number;
  attempts?: number;
  lastError?: string | null;
}

export interface ActiveRefundOperation {
  active: true;
  status: string;
  severity: "info" | "success" | "warning" | "danger";
  label: string;
  message: string;
  amount: number;
  currency: string;
  gateway: string;
  attemptCount: number;
  nextProbeAt: OrderTimestamp | null;
  lastProbeAt: OrderTimestamp | null;
  providerStatus: string | null;
  reason?: string | null;
  sourceTransactionId?: string | null;
  providerRefundId?: string | null;
  providerCorrelationId?: string | null;
  refundReference?: string | null;
  lastError?: string | null;
}

export interface ShipmentRecovery {
  state: "none" | "creating" | "needs_attention" | "failed";
  severity: "info" | "warning" | "danger";
  activeLock: boolean;
  label: string;
  message: string | null;
  shipmentId: string | null;
  status: string | null;
  providerType: string | null;
  canRefresh: boolean;
  canRetryCreate: boolean;
  updatedAt: OrderTimestamp | null;
}

export interface PaymentRecovery {
  state: "none" | "awaiting_payment" | "processing" | "needs_attention";
  label: string;
  message: string | null;
  gateway: string | null;
  paymentType: string | null;
  status: string | null;
  attempts: number;
  activeProcessing: boolean;
  staleProcessing: boolean;
  updatedAt: OrderTimestamp | null;
  canIssueRecoveryLink?: boolean;
  recoveryLinkBlockedReason?: string | null;
}

export interface OrderSupportRequest {
  id: string;
  orderId: string;
  customerId: string | null;
  type: "cancel_pre_shipment" | "return" | "refund";
  status: string;
  active: boolean;
  severity: "info" | "success" | "warning" | "danger";
  label: string;
  actionLabel: string;
  reason: string;
  message: string | null;
  submittedAt: OrderTimestamp | null;
  resolvedAt: OrderTimestamp | null;
  createdAt: OrderTimestamp | null;
  updatedAt: OrderTimestamp | null;
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
  refundAttempts?: OrderRefundAttempt[];
  activeRefundOperation?: ActiveRefundOperation | null;
  shipmentRecovery?: ShipmentRecovery;
  paymentRecovery?: PaymentRecovery;
  supportRequests?: OrderSupportRequest[];
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

export {
  ORDER_STATUSES,
  getAvailableOrderStatusTransitions as getAvailableTransitions,
} from "@scalius/shared/order-state";
