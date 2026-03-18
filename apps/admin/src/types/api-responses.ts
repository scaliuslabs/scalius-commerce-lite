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
  itemCount?: number;
  latestShipment?: unknown;
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
  webhookId: string | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
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

// ---------------------------------------------------------------------------
// API Response Shapes (used by loaders + components)
// ---------------------------------------------------------------------------

export interface PaginationResponse {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface WidgetHistoryEntry {
  id: string;
  widgetId: string;
  htmlContent: string;
  cssContent: string | null;
  reason: string;
  createdAt: number;
}

export interface ProductVariantDetail {
  id: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  compareAtPrice: number | null;
  costPerItem: number | null;
  stock: number;
  reserved: number;
  lowStockThreshold: number | null;
  weight: number | null;
  supplier: string | null;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  stockVersion: number;
  createdAt: string | number;
  updatedAt: string | number;
}

export interface ProductImageDetail {
  id: string;
  productId: string;
  url: string;
  altText: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string | number;
}

export interface OpenRouterMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

// ---------------------------------------------------------------------------
// Product list item (enriched, from GET /products list)
// ---------------------------------------------------------------------------

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  price: number;
  description: string | null;
  isActive: boolean;
  discountPercentage: number | null;
  freeDelivery: boolean;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
  category: { name: string };
  variantCount: number;
  imageCount: number;
  primaryImage: string | null;
  sku?: string;
}

// ---------------------------------------------------------------------------
// Product detail (extended for GET /products/:id)
// ---------------------------------------------------------------------------

export interface ProductVariant {
  id: string;
  productId: string;
  size: string | null;
  color: string | null;
  weight: number | null;
  sku: string | null;
  price: number | null;
  stock: number;
  reservedStock: number;
  barcode: string | null;
  barcodeType: string | null;
  discountType: string | null;
  discountPercentage: number | null;
  discountAmount: number | null;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  stockVersion: number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
  deletedAt: Date | string | number | null;
}

export interface ProductDetail extends Product {
  category: { name: string | null };
  variants: ProductVariant[];
  images: ProductImageDetail[];
  attributes: Array<{ attributeId: string; value: string }>;
  additionalInfo: Array<{ id: string; title: string; content: string; sortOrder: number }>;
}

export interface ProductStats {
  totalProducts: number;
  activeProducts: number;
  productsWithImages: number;
  categoriesCount: number;
  totalCategories?: number;
  categoriesWithImages?: number;
}

// ---------------------------------------------------------------------------
// Order detail (extended for GET /orders/:id)
// ---------------------------------------------------------------------------

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
}

export interface OrderDetail extends Order {
  items: OrderItem[];
  latestShipment: unknown;
  itemCount: number;
}

export interface OrderFormData {
  order: {
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
    createdAt: Date | string | number;
    updatedAt: Date | string | number;
  };
  productsWithVariants: Array<{
    id: string;
    name: string;
    price: number;
    discountPercentage: number | null;
    variants: ProductVariant[];
  }>;
  defaultValues: {
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
    createdAt: Date | string | number;
    updatedAt: Date | string | number;
    items: Array<{
      productId: string;
      variantId: string | null;
      quantity: number;
      price: number;
    }>;
  };
}

export interface EnhancedShipment extends DeliveryShipment {
  providerName: string;
}

// ---------------------------------------------------------------------------
// Customer domain
// ---------------------------------------------------------------------------

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  address: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: Date | string | number | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
  deletedAt: Date | string | number | null;
}

export interface CustomerHistoryRecord {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName: string;
  zoneName: string;
  areaName: string | null;
  changeType: string | null;
  createdAt: Date | string | number;
}

export interface CustomerOrderSummary {
  id: string;
  totalAmount: number;
  status: string;
  createdAt: Date | string | number;
}

export interface CustomerHistoryData {
  customer: Customer;
  history: CustomerHistoryRecord[];
  orders: CustomerOrderSummary[];
}

// ---------------------------------------------------------------------------
// Widget list response (from GET /widgets)
// ---------------------------------------------------------------------------

export interface WidgetListResponse {
  widgets: Widget[];
  availableCollections: Array<{
    id: string;
    name: string;
    sortOrder: number;
    type: "manual" | "dynamic";
  }>;
}

// ---------------------------------------------------------------------------
// Discount domain
// ---------------------------------------------------------------------------

export interface Discount {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  minPurchaseAmount: number | null;
  minQuantity: number | null;
  maxUsesPerOrder: number | null;
  maxUses: number | null;
  limitOnePerCustomer: boolean | null;
  combineWithProductDiscounts: boolean | null;
  combineWithOrderDiscounts: boolean | null;
  combineWithShippingDiscounts: boolean | null;
  customerSegment: string | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  relatedProducts: { buy: string[]; get: string[] };
  relatedCollections: { buy: string[]; get: string[] };
  usageCount?: number;
  totalDiscountAmount?: number;
}

// ---------------------------------------------------------------------------
// Settings domain
// ---------------------------------------------------------------------------

export interface GeneralSettings {
  headerConfig: Record<string, unknown> | null;
  footerConfig: Record<string, unknown> | null;
}

export interface MetaConversionsSettingsResponse {
  settings: MetaConversionsSettings | null;
}

export interface FraudCheckerProvider {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  isActive: boolean;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}

// ---------------------------------------------------------------------------
// Analytics domain
// ---------------------------------------------------------------------------

export interface AnalyticsScript {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  usePartytown: boolean;
  config: string | null;
  location: string;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}

// ---------------------------------------------------------------------------
// Dashboard domain
// ---------------------------------------------------------------------------

export interface DashboardStats {
  totalProducts: number;
  totalCustomers: number;
  totalRevenue: number;
  currentMonth: {
    orders: number;
    revenue: number;
    orderGrowth: number;
    revenueGrowth: number;
    orderStatus: {
      delivered: number;
      processing: number;
      shipping: number;
      cancelled: number;
    };
  };
  lastMonth: {
    orders: number;
    revenue: number;
  };
}

export interface DashboardRecentOrder {
  id: string;
  customerName: string;
  totalAmount: number;
  status: string;
  createdAt: Date | string;
}

export interface DashboardDailyActivity {
  date: string;
  orders: number;
  revenue: number;
  newCustomers: number;
}

// ---------------------------------------------------------------------------
// Collection form options
// ---------------------------------------------------------------------------

export interface CollectionFormOptions {
  categories: Array<{ id: string; name: string }>;
  products: Array<{ id: string; name: string; price: number; categoryId?: string }>;
}
