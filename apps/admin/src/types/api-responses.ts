// Admin-owned API response types.
// These mirror the database schema shapes but are owned by the admin app,
// decoupling admin components from @scalius/database/schema imports.

// ---------------------------------------------------------------------------
// Enums (const objects + derived union types)
// ---------------------------------------------------------------------------

export const OrderStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  CONFIRMED: "confirmed",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
  RETURNED: "returned",
  PARTIALLY_REFUNDED: "partially_refunded",
  INCOMPLETE: "incomplete",
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const WidgetPlacementRule = {
  BEFORE_COLLECTION: "before_collection",
  AFTER_COLLECTION: "after_collection",
  FIXED_TOP_HOMEPAGE: "fixed_top_homepage",
  FIXED_BOTTOM_HOMEPAGE: "fixed_bottom_homepage",
  STANDALONE: "standalone",
} as const;

export type WidgetPlacementRule =
  (typeof WidgetPlacementRule)[keyof typeof WidgetPlacementRule];

export const DeliveryProvider = {
  PATHAO: "pathao",
  STEADFAST: "steadfast",
} as const;

export type DeliveryProviderType =
  (typeof DeliveryProvider)[keyof typeof DeliveryProvider];

// ---------------------------------------------------------------------------
// Product domain
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  categoryId: string;
  slug: string;
  metaTitle: string | null;
  metaDescription: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  isActive: boolean;
  discountPercentage: number | null;
  discountType: "percentage" | "flat" | null;
  discountAmount: number | null;
  freeDelivery: boolean;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Collection {
  id: string;
  name: string;
  type: "manual" | "dynamic";
  config: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ProductAttribute {
  id: string;
  name: string;
  slug: string;
  filterable: boolean;
  options: string[] | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Order domain
// ---------------------------------------------------------------------------

export interface Order {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number | null;
  status: string;
  notes: string | null;
  paymentMethod: string;
  paymentStatus: string;
  paymentIntentId: string | null;
  paidAmount: number;
  balanceDue: number;
  fulfillmentStatus: string;
  inventoryPool: string;
  inventoryAction: string;
  expectedDelivery: string | null;
  version: number;
  customerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AbandonedCheckout {
  id: string;
  checkoutId: string;
  customerPhone: string | null;
  checkoutData: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Delivery domain
// ---------------------------------------------------------------------------

export interface DeliveryProviderRecord {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  credentials: string;
  config: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryShipment {
  id: string;
  orderId: string;
  providerId: string | null;
  providerType: string;
  externalId: string | null;
  trackingId: string | null;
  trackingUrl: string | null;
  courierName: string | null;
  status: string;
  rawStatus: string | null;
  note: string | null;
  metadata: string | null;
  lastChecked: Date | null;
  shipmentItems: string | null;
  shipmentAmount: number | null;
  isFinalShipment: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Content domain
// ---------------------------------------------------------------------------

export interface Page {
  id: string;
  title: string;
  slug: string;
  content: string;
  metaTitle: string | null;
  metaDescription: string | null;
  isPublished: boolean;
  hideHeader: boolean;
  hideFooter: boolean;
  hideTitle: boolean;
  publishedAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Widget {
  id: string;
  name: string;
  htmlContent: string;
  cssContent: string | null;
  aiContext: string | null;
  isActive: boolean;
  displayTarget: string;
  placementRule: WidgetPlacementRule;
  referenceCollectionId: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Marketing domain
// ---------------------------------------------------------------------------

export interface MetaConversionsSettings {
  id: string;
  singletonKey: string;
  pixelId: string | null;
  accessToken: string | null;
  testEventCode: string | null;
  isEnabled: boolean;
  logRetentionDays: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MetaConversionsLog {
  id: string;
  eventId: string;
  eventName: string;
  status: "success" | "failed";
  requestPayload: string;
  responsePayload: string | null;
  errorMessage: string | null;
  eventTime: Date;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// System domain
// ---------------------------------------------------------------------------

export interface ShippingMethod {
  id: string;
  name: string;
  fee: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CheckoutLanguage {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  isDefault: boolean;
  languageData: string;
  fieldVisibility: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
