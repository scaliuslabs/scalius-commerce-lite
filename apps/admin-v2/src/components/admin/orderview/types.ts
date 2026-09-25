import type {
  DeliveryProviderRecord,
} from "~/lib/api-query-options/delivery";
import type { OrderOperationalReadState } from "@/lib/order-operational-read-state";
import type { OrderShipmentRecoveryReason } from "@scalius/core/modules/orders/browser";
import type { DeliveryMethodKind, FulfillmentRecordStatus, FulfillmentType } from "@scalius/shared/fulfilment";
import type { CustomizationFieldType } from "@scalius/shared/line-properties";

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
  variantLabel: string | null;
  /** How the line reaches the buyer, frozen when the order was placed. */
  fulfillmentType: FulfillmentType;
  /** Units handed over so far (sent, picked up, performed or delivered digitally). */
  fulfilledQuantity: number;
  /** Buyer inputs frozen on the line ("Engraving: Rahim"). */
  properties?: OrderLineProperty[];
  propertiesPriceMinor?: number;
  inventoryTracked?: boolean;
  unitPriceMinor?: number | null;
  lineSubtotalMinor?: number | null;
  discountAmountMinor?: number | null;
  taxableAmountMinor?: number | null;
  taxAmountMinor?: number | null;
  /**
   * Wave B facts about the line, composed by the API (absent until each
   * feature ships). Each card reads and narrows only its own key.
   */
  extras?: OrderLineExtras;
}

export interface OrderLineExtras {
  review?: unknown;
  downloads?: unknown;
  licenceKeys?: unknown;
  giftCards?: unknown;
  warranty?: unknown;
}

export interface OrderLineProperty {
  key: string;
  type: CustomizationFieldType;
  label: string;
  value: string;
  displayValue: string;
  /** Surcharge per unit, major units. */
  price: number;
  priceMinor: number;
}

export interface OrderPickup {
  address: string | null;
  hours: string | null;
  readyAt: string | null;
}

/** One ledger fulfilment: a real hand-over of some units (voided ones stay listed). */
export interface OrderFulfillment {
  id: string;
  kind: FulfillmentType;
  createdAt: string | null;
  lines: Array<{ orderItemId: string; quantity: number }>;
  tracking: {
    shipmentId: string;
    courierName: string | null;
    trackingId: string | null;
    trackingUrl: string | null;
    status: string;
  } | null;
  status: FulfillmentRecordStatus;
  actorType: "admin" | "system";
  /** Cash taken at the counter or the service in the same action, major units. */
  cashCollected: number | null;
  voidedAt: OrderTimestamp | null;
  /** The server allows voiding it now (an own-rider parcel that came back). */
  canVoid?: boolean;
  /** Why it can't be voided: a code the dashboard words (`void.blocked.*`). */
  voidBlockedReason?: "voided" | "courier" | "delivered" | "order_not_confirmed" | null;
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
  /** Stable code the dashboard words in its own language (see `shipmentRecoveryCopy`). */
  reason: OrderShipmentRecoveryReason;
  severity: "info" | "warning" | "danger";
  activeLock: boolean;
  shipmentId: string | null;
  status: string | null;
  providerType: string | null;
  canRefresh: boolean;
  canRetryCreate: boolean;
  canRepair: boolean;
  unknownOutcome?: boolean;
  updatedAt: OrderTimestamp | null;
}

export interface PaymentRecovery {
  state: "none" | "awaiting_payment" | "processing" | "needs_attention";
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
  submittedAt: OrderTimestamp | null;
  resolvedAt: OrderTimestamp | null;
  createdAt: OrderTimestamp | null;
  updatedAt: OrderTimestamp | null;
}

export interface Order {
  id: string;
  version: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  /** A separate WhatsApp number; null means the phone. */
  customerWhatsapp?: string | null;
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
  currencyCode?: string | null;
  currencyDecimalPlaces?: number | null;
  subtotalAmountMinor?: number | null;
  shippingAmountMinor?: number | null;
  shippingMethodId?: string | null;
  shippingMethodName?: string | null;
  shippingMethodDescription?: string | null;
  shippingMethodBaseAmountMinor?: number | null;
  shippingFeeWaived?: boolean | null;
  discountAmountMinor?: number | null;
  taxAmountMinor?: number | null;
  totalAmountMinor?: number | null;
  taxLabel?: string | null;
  pricesIncludeTax?: boolean | null;
  discounts: OrderDiscount[];
  customerId: string | null;
  /** The customer record the order is filed under (a guest record, an account or a merchant-added customer). */
  customerRecord?: OrderCustomerRecord | null;
  cityName?: string;
  zoneName?: string;
  areaName?: string | null;
  shipments?: OrderShipment[];
  /** Some line ships, so the order has a delivery address. */
  requiresShipping?: boolean;
  /** The order's one delivery method; null when nothing physical was bought. */
  shippingMethodKind?: DeliveryMethodKind | null;
  pickup?: OrderPickup | null;
  pickupReadyAt?: OrderTimestamp | null;
  fulfillments?: OrderFulfillment[];
  /** The order's message thread (S4 mounts its card here). */
  conversation?: { id: string; unread: boolean } | null;
  deliveryProviders?: DeliveryProviderRecord[];
  operationalReads?: {
    shipments: OrderOperationalReadState;
    deliveryProviders: OrderOperationalReadState;
  };
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
  orderNumber: number | null;
  archivedAt: OrderTimestamp | null;
  /** Value of received returns not refunded yet. */
  refundDue: number;
  refundedAmount: number;
  editReadiness: {
    items: OrderEditState;
    details: OrderEditState;
  };
}

export interface OrderCustomerRecord {
  id: string;
  name: string;
  kind: "account" | "guest" | "merchant";
  phone: string;
}

export interface OrderDiscount {
  promotionId: string;
  name: string;
  code: string | null;
  method: "automatic" | "code";
  kind: "buy_x_get_y" | "product" | "order" | "shipping";
  /** Everything the discount saved, items and delivery. */
  amount: number;
  /** The part off delivery, shown on the delivery line. */
  shippingAmount: number;
}

export type OrderEditLockReason =
  | "shipped" | "closed" | "paid" | "online_payment" | "discount"
  | "history" | "inventory" | "archived" | "busy" | "unavailable";

export interface OrderEditState {
  allowed: boolean;
  reason: OrderEditLockReason | null;
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
  shipmentAmount?: number | null;
  isFinalShipment?: boolean | null;
  createdAt: OrderTimestamp;
  updatedAt?: OrderTimestamp;
  lastChecked?: OrderTimestamp | null;
}
