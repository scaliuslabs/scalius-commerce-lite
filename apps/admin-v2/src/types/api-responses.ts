// Admin API response types — thin adapter over @scalius/api-client generated types.
//
// The SDK types from @scalius/api-client/types are generated from the OpenAPI spec.
// However, many SDK response types include `[key: string]: unknown` index signatures
// (from additionalProperties) and `unknown` for timestamp fields, making them too
// loose for direct use. This file provides clean entity-level types that admin
// components consume.
//
// Types that are clean enough are extracted directly from SDK response envelopes.
// Types that need stricter typing (timestamps, no index signatures) are defined
// explicitly with matching shapes.

import type { ReadinessStatus } from "@scalius/shared/readiness";

// ---------------------------------------------------------------------------
// Enums (const objects + derived union types — runtime values, not in SDK)
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
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  excludeFromProductFeed: boolean;
  productCondition: "new" | "refurbished" | "used" | null;
  aggregateRevision: number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
  deletedAt: Date | string | number | null;
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
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  status: "draft" | "published" | "internal";
  revision: number;
  publishReady: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Collection {
  id: string;
  name: string;
  presentation: "grid" | "carousel";
  config: string;
  sortOrder: number;
  isActive: boolean;
  version: number;
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
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
// Product detail types
// ---------------------------------------------------------------------------

export interface ProductVariant {
  id: string;
  productId: string;
  optionCombinationKey: string | null;
  imageId: string | null;
  selectedOptions: SelectedProductOption[];
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
  isDefault?: boolean;
  trackInventory?: boolean;
  isActive?: boolean;
  version: number;
  stockVersion: number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
  deletedAt: Date | string | number | null;
}

export type ProductOptionStandardMapping =
  "size" | "color" | "material" | "pattern" | "none";

export interface SelectedProductOption {
  optionDefinitionId: string;
  optionValueId: string;
  name: string;
  value: string;
  position: number;
  valuePosition: number;
  standardMapping: ProductOptionStandardMapping;
}

export interface ProductOptionDefinition {
  id: string;
  name: string;
  position: number;
  standardMapping: ProductOptionStandardMapping;
  values: Array<{ id: string; value: string; position: number }>;
}

export interface ProductMediaDetail {
  id: string;
  mediaId: string;
  kind: "image" | "video";
  url: string;
  posterMediaId: string | null;
  posterUrl: string | null;
  altText: string;
  contextualAltText?: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isPrimary: boolean;
  sortOrder: number;
  status: "ready" | "trashed";
}

export type ProductSkuImageChoice = Pick<
  ProductMediaDetail,
  "id" | "url" | "altText" | "isPrimary" | "sortOrder" | "status"
>;

export interface ProductDetail extends Product {
  category: { name: string | null };
  variants: ProductVariant[];
  media: ProductMediaDetail[];
  options: ProductOptionDefinition[];
  attributes: Array<{ attributeId: string; value: string }>;
  additionalInfo: Array<{
    id: string;
    title: string;
    content: string;
    sortOrder: number;
  }>;
}

// ---------------------------------------------------------------------------
// Order domain
// ---------------------------------------------------------------------------

export interface AbandonedCheckout {
  id: string;
  checkoutId: string | null;
  customerPhone: string | null;
  checkoutData: string;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}

// ---------------------------------------------------------------------------
// Delivery domain
// ---------------------------------------------------------------------------

/** Setup lifecycle position. The readiness verdict is the shared `status`. */
export type DeliveryProviderLifecycle =
  "draft" | "configured" | "tested" | "active" | "blocked";

/** The shared readiness verdict itself; never a lifecycle position. */
export type DeliveryProviderReadinessStatus = ReadinessStatus;

/** Mirrors `ReadinessIssue` in packages/shared/src/readiness.ts. */
export interface DeliveryProviderReadinessIssue {
  code:
    | "inactive"
    | "unconfigured"
    | "untested"
    | "test_failed"
    | "unreadable"
    | string;
  message: string;
  fix?: string;
}

export interface DeliveryProviderReadiness {
  status: DeliveryProviderReadinessStatus;
  lifecycle: DeliveryProviderLifecycle;
  configured?: boolean;
  tested?: boolean;
  active?: boolean;
  canCreateShipment: boolean;
  issues: DeliveryProviderReadinessIssue[];
  activationBlockers?: Array<{
    source: "credentials" | "config" | string;
    key: string;
    label: string;
    message: string;
  }>;
  lastTestAttemptAt?: string | number | null;
  lastTestSuccessAt?: string | number | null;
  lastTestFailureAt?: string | number | null;
}

export interface DeliveryProviderRecord {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  credentials: string;
  config: string;
  readiness?: DeliveryProviderReadiness | null;
  createdAt?: Date | string | number;
  updatedAt?: Date | string | number;
}

// ---------------------------------------------------------------------------
// Content domain
// ---------------------------------------------------------------------------

export interface PageFeaturedImage {
  id: string;
  url: string;
  filename: string;
  size: number;
  mimeType?: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
  folderId?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}

export interface Page {
  id: string;
  contentType: "page" | "article";
  title: string;
  slug: string;
  content: string;
  excerpt: string | null;
  author: string | null;
  tags: string[];
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  isPublished: boolean;
  hideHeader: boolean;
  hideFooter: boolean;
  hideTitle: boolean;
  featuredImage?: PageFeaturedImage | null;
  publishedAt: Date | null;
  sortOrder: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
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
  deletedAt?: Date | string | number | null;
}

export interface CustomerHistoryRecord {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
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

export interface CustomerHistoryPage {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}

// ---------------------------------------------------------------------------
// Discount domain
// ---------------------------------------------------------------------------

export interface Discount {
  id: string;
  revision: number;
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

export type MetaPixelParityStatus =
  | "not_configured"
  | "invalid_capi_pixel_id"
  | "no_browser_pixel"
  | "unreadable_browser_pixel"
  | "ok"
  | "mismatch"
  | "multiple_browser_pixels"
  | "unavailable";

export type MetaPixelParitySeverity = "neutral" | "success" | "warning";

export interface MetaPixelParityDiagnostics {
  status: MetaPixelParityStatus;
  severity: MetaPixelParitySeverity;
  message: string;
  capiPixelId: string | null;
  activeBrowserPixelIds: string[];
  activeFacebookPixelScriptCount: number;
  parseableFacebookPixelScriptCount: number;
}

// ---------------------------------------------------------------------------
// Settings domain
// ---------------------------------------------------------------------------

export interface MetaConversionsSettingsResponse {
  settings: MetaConversionsSettings | null;
  pixelParity: MetaPixelParityDiagnostics;
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
  revision: number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
  deletedAt: Date | string | number | null;
}

export type AnalyticsScriptReadiness =
  "ready" | "blocked" | "draft" | "ready_to_activate" | "trashed";

export interface AnalyticsScriptSummary extends Omit<
  AnalyticsScript,
  "config"
> {
  identifier: string | null;
  readiness: AnalyticsScriptReadiness;
  configIssue: string | null;
}

export interface AnalyticsScriptsListResponse {
  scripts: AnalyticsScriptSummary[];
  pagination: PaginationResponse;
}

export type AnalyticsProviderType =
  | "google_analytics"
  | "google_tag_manager"
  | "facebook_pixel"
  | "tiktok_pixel"
  | "cloudflare_web_analytics"
  | "custom";

export type AnalyticsProviderBrowserStatus =
  "ready" | "draft" | "blocked" | "not_configured";

export type AnalyticsProviderServerStatus =
  "ready" | "blocked" | "not_configured" | "not_applicable";

export interface AnalyticsProviderBrowserReadiness {
  status: AnalyticsProviderBrowserStatus;
  configured: boolean;
  activeScriptCount: number;
  readyScriptCount: number;
  draftScriptCount: number;
  blockedScriptCount: number;
  message: string;
  issues: string[];
}

export interface AnalyticsProviderServerReadiness {
  status: AnalyticsProviderServerStatus;
  configured: boolean;
  label: string;
  message: string;
}

export interface AnalyticsProviderHealthItem {
  provider: AnalyticsProviderType;
  label: string;
  browser: AnalyticsProviderBrowserReadiness;
  serverSide: AnalyticsProviderServerReadiness;
}

export interface AnalyticsProviderHealthResponse {
  summary: {
    totalProviders: number;
    browserReadyProviders: number;
    draftProviders: number;
    blockedProviders: number;
    notConfiguredProviders: number;
    serverReadyProviders: number;
  };
  providers: AnalyticsProviderHealthItem[];
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

// ---------------------------------------------------------------------------
// Account security
// ---------------------------------------------------------------------------

export interface AccountSecurity {
  twoFactorMethod: string | null;
  isSuperAdmin: boolean;
}
