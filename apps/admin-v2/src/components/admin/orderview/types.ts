import type {
  DeliveryProviderRecord,
} from "~/lib/api-query-options/delivery";
import type { OrderOperationalReadState } from "@/lib/order-operational-read-state";
import type { OrderShipmentRecoveryReason } from "@scalius/core/modules/orders/browser";
import type { DeliveryMethodKind, FulfillmentRecordStatus, FulfillmentType } from "@scalius/shared/fulfilment";
import type { CustomizationFieldType } from "@scalius/shared/line-properties";
import type { OrderChannel } from "@scalius/shared/order-channel";
import type { RelatedObjectRecord } from "@scalius/shared/plugins/objects";

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
  relatedObjects?: RelatedObjectRecord[];
  attributes?: Record<string, string>;
  id: string;
  version: number;
  customerName: string;
  /** Null for an order placed without a phone (a digital or service order). */
  customerPhone: string | null;
  customerEmail: string | null;
  /** A separate WhatsApp number; null means the phone. */
  customerWhatsapp?: string | null;
  /** The first street line ("" when nothing ships). */
  shippingAddress: string;
  /** The rest of the shipping snapshot (MARKETS-DESIGN D7); a Bangladesh order adds City/Thana/Area. */
  shippingAddressLine2?: string | null;
  shippingCountryCode?: string | null;
  shippingDependentLocality?: string | null;
  shippingLocality?: string | null;
  shippingAdminArea?: string | null;
  shippingPostalCode?: string | null;
  shippingCompany?: string | null;
  /** The recipient when not the contact (null: `customerName`, `customerPhone`). */
  shippingName?: string | null;
  shippingPhone?: string | null;
  /** Staff saved it although it breaks its country's rules. */
  shippingValidationSkipped?: boolean;
  /** The billing snapshot (migration 0119): the shipping address bills when `billingSameAsShipping`. */
  billingSameAsShipping?: boolean;
  billingName?: string | null;
  billingCompany?: string | null;
  billingAddress?: string | null;
  billingAddressLine2?: string | null;
  billingCountryCode?: string | null;
  billingDependentLocality?: string | null;
  billingLocality?: string | null;
  billingAdminArea?: string | null;
  billingPostalCode?: string | null;
  billingPhone?: string | null;
  billingValidationSkipped?: boolean;
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
  /** Shop-currency amounts of an order paid in a market's own currency (MARKETS-DESIGN D3); null: same-currency. */
  moneyChain?: {
    shopCurrencyCode: string;
    rate: string;
    source: string;
    asOf: string | null;
    lockedUntil: string | null;
    subtotalShopAmount: number;
    shippingShopAmount: number;
    discountShopAmount: number;
    taxShopAmount: number;
    totalShopAmount: number;
  } | null;
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
  /** Apps' advisory risk checks (never acted on automatically); empty when none. */
  appRiskChecks: OrderAppRiskCheck[];
  /** Apps' holds for staff review, open ones first (absent on reads that predate holds). */
  holds?: OrderHold[];
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
  /** Where the order came from (online store, dashboard, AI agent…); set once. */
  channel: OrderChannel;
  /** Where it came in within the channel: a preset (`facebook`, `walk_in`) or the merchant's own slug. */
  channelSource: string | null;
  /** Value of received returns not refunded yet. */
  refundDue: number;
  refundedAmount: number;
  editReadiness: {
    items: OrderEditState;
    details: OrderEditState;
  };
  /**
   * Where the order's stock leaves from: its own location or the store
   * default (`explicit` false). Absent on reads that predate locations.
   */
  fulfillmentLocation?: { id: string; name: string; explicit: boolean } | null;
}

export interface OrderCustomerRecord {
  id: string;
  name: string;
  kind: "account" | "guest" | "merchant";
  /** Null for a record without a phone (keyed by email). */
  phone: string | null;
}

/** A saving on the order: a promotion's, or one an app gave at checkout (`checkout.discounts`). */
export interface OrderDiscount {
  source: "promotion" | "app";
  /** The promotion behind it; null for an app's discount. */
  promotionId: string | null;
  /** The app that gave it; null for a promotion. */
  appId: string | null;
  appName: string | null;
  /** The promotion's title, or the app's title for its discount. */
  name: string;
  code: string | null;
  method: "automatic" | "code";
  kind: "buy_x_get_y" | "product" | "order" | "shipping";
  /** Everything the discount saved, items and delivery. */
  amount: number;
  /** The part off delivery, shown on the delivery line. */
  shippingAmount: number;
}

/** An app's risk assessment made after the order was placed (`order.risk`): advice only, nothing acts on it. */
export interface OrderAppRiskCheck {
  appId: string;
  appName: string;
  level: "low" | "medium" | "high";
  reasons: string[];
  /** When the app checked: an ISO string or unix seconds, like every order timestamp. */
  checkedAt: OrderTimestamp;
}

/**
 * An app's hold (`order.risk` with hold). While open (`releasedAt` null) the
 * order is not shipped, handed over or moved on; cancelling stays possible.
 * Staff release it, and the app never holds that order again.
 */
export interface OrderHold {
  id: string;
  appId: string;
  appName: string;
  /** The app's reasons, one per line. */
  reason: string;
  placedAt: OrderTimestamp;
  releasedAt: OrderTimestamp | null;
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
