// src/lib/api/types.ts
//
// Centralized type definitions for the Scalius Commerce storefront.
//
// SDK response types are re-exported with short aliases from @scalius/api-client.
// Domain interfaces (Product, Category, etc.) are kept locally because the SDK
// exports per-endpoint response wrappers, not standalone domain types.

// ---------------------------------------------------------------------------
// SDK Re-exports (response types, aliased for brevity)
// ---------------------------------------------------------------------------

import type {
  PostApiV1OrdersData,
  GetApiV1ProductsResponse as GetProductsResponse,
  GetApiV1ProductsBySlugResponse as GetProductsBySlugResponse,
  GetApiV1CategoriesResponse as GetCategoriesResponse,
  GetApiV1CategoriesBySlugResponse as GetCategoriesBySlugResponse,
  GetApiV1CollectionsResponse as GetCollectionsResponse,
  GetApiV1CollectionsByIdResponse as GetCollectionsByIdResponse,
  GetApiV1SearchResponse as GetSearchResponse,
  GetApiV1HeaderResponse as GetHeaderResponse,
  GetApiV1FooterResponse as GetFooterResponse,
  GetApiV1NavigationResponse as GetNavigationResponse,
  GetApiV1PagesResponse as GetPagesResponse,
  GetApiV1PagesSlugBySlugResponse as GetPagesSlugBySlugResponse,
  GetApiV1SeoResponse as GetSeoResponse,
  GetApiV1HeroSlidersResponse as GetHeroSlidersResponse,
  GetApiV1CheckoutLanguagesActiveResponse as GetCheckoutLanguagesActiveResponse,
  PostApiV1DiscountsValidateResponse as PostDiscountsValidateResponse,
  GetApiV1AnalyticsConfigurationsResponse as GetAnalyticsConfigurationsResponse,
  GetApiV1LocationsCitiesResponse as GetLocationsCitiesResponse,
  GetApiV1LocationsZonesResponse as GetLocationsZonesResponse,
  GetApiV1LocationsAreasResponse as GetLocationsAreasResponse,
  PostApiV1OrdersResponse as PostOrdersResponse,
} from "@scalius/api-client/types";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import type { ProductCondition } from "@scalius/shared/product-condition";

export type {
  GetProductsResponse,
  GetProductsBySlugResponse,
  GetCategoriesResponse,
  GetCategoriesBySlugResponse,
  GetCollectionsResponse,
  GetCollectionsByIdResponse,
  GetSearchResponse,
  GetHeaderResponse,
  GetFooterResponse,
  GetNavigationResponse,
  GetPagesResponse,
  GetPagesSlugBySlugResponse,
  GetSeoResponse,
  GetHeroSlidersResponse,
  GetCheckoutLanguagesActiveResponse,
  PostDiscountsValidateResponse,
  GetAnalyticsConfigurationsResponse,
  GetLocationsCitiesResponse,
  GetLocationsZonesResponse,
  GetLocationsAreasResponse,
  PostOrdersResponse,
};

// Extract the order request body type from the SDK endpoint definition.
export type OrderPostRequest = NonNullable<PostApiV1OrdersData["body"]>;

// ---------------------------------------------------------------------------
// Generic API Responses (storefront-specific wrappers)
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
    details?: Array<{ field?: string; message: string }>;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  priceRange?: BuyerPriceRange;
  facets?: ProductFacet[];
}

export interface BuyerPriceRange {
  min: number;
  max: number;
}

export interface ProductFacetValue {
  value: string;
  count: number;
}

export interface ProductFacet {
  id: string;
  name: string;
  slug: string;
  values: ProductFacetValue[];
}

// ---------------------------------------------------------------------------
// Product & Category Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

export interface ProductRichContent {
  id: string;
  title: string;
  content: string;
}

export type ProductOptionStandardMapping =
  "size" | "color" | "material" | "pattern" | "none";

export interface ProductOptionDefinition {
  id: string;
  name: string;
  position: number;
  standardMapping: ProductOptionStandardMapping;
  values: Array<{ id: string; value: string; position: number }>;
}

export interface SelectedProductOption {
  optionDefinitionId: string;
  optionValueId: string;
  name: string;
  value: string;
  position: number;
  valuePosition: number;
  standardMapping: ProductOptionStandardMapping;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  discountType: "percentage" | "flat" | null;
  discountPercentage: number | null;
  discountAmount: number | null;
  discountedPrice: number;
  priceVaries?: boolean;
  freeDelivery: boolean;
  isActive: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath?: string | null;
  productCondition?: ProductCondition | null;
  options?: ProductOptionDefinition[];
  noIndex?: boolean;
  features?: string[];
  additionalInfo?: ProductRichContent[];
  attributes?: Array<{ name: string; value: string; slug: string }>;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  imageUrl?: string | null;
  imageMediaId?: string | null;
  imageAlt?: string | null;
  category?: CategorySummary;
  hasVariants: boolean;
  availableForSale?: boolean;
  variants?: ProductVariant[];
}

export interface ProductVariant {
  id: string;
  productId: string;
  optionCombinationKey: string | null;
  imageId: string | null;
  imageMediaId?: string | null;
  imageUrl?: string | null;
  selectedOptions: SelectedProductOption[];
  weight: number | null;
  sku: string;
  price: number;
  stock: number;
  reservedStock?: number;
  isDefault?: boolean;
  trackInventory?: boolean;
  lowStockThreshold?: number | null;
  barcode?: string | null;
  barcodeType?: "ean13" | "upc" | "isbn" | "gtin" | "custom" | string | null;
  discountType: "percentage" | "flat" | null;
  discountPercentage: number | null;
  discountAmount: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ProductMedia {
  id: string;
  mediaId: string;
  kind: "image" | "video";
  url: string;
  posterMediaId: string | null;
  posterUrl: string | null;
  altText: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isPrimary: boolean;
  sortOrder: number;
  status: "ready" | "trashed";
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** Available on category detail responses; omitted from list responses. */
  content?: string | null;
  imageUrl: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalPath?: string | null;
  noIndex?: boolean;
  excludeFromSitemap?: boolean;
  createdAt: string | null;
  updatedAt?: string | null;
}

export interface CategorySummary {
  id: string;
  name: string;
  slug: string;
  canonicalPath?: string | null;
}

export interface CategoryProductsResponse extends PaginatedResponse<Product> {
  category: Category | null;
  categoryNotFound?: boolean;
}

// ---------------------------------------------------------------------------
// Collection Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

export interface CollectionConfig {
  maxProducts?: number;
  title?: string;
  subtitle?: string;
}

export interface Collection {
  id: string;
  name: string;
  presentation: "grid" | "carousel";
  config: CollectionConfig;
  sortOrder: number;
  isActive: boolean;
  canonicalPath?: string | null;
  noIndex?: boolean;
  excludeFromSitemap?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CollectionWithProducts extends Collection {
  description: string | null;
  content: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  categories?: CategorySummary[];
  products?: Product[];
  featuredProduct?: Product | null;
  pagination: PaginatedResponse<Product>["pagination"];
  priceRange?: BuyerPriceRange;
  facets?: ProductFacet[];
}

// ---------------------------------------------------------------------------
// Page & Site Settings Types (local domain types — SDK only has response wrappers)
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
  createdAt?: string | number;
  updatedAt?: string | number;
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
  canonicalPath?: string | null;
  noIndex?: boolean;
  excludeFromSitemap?: boolean;
  isPublished: boolean;
  hideHeader: boolean;
  hideFooter: boolean;
  hideTitle: boolean;
  featuredImage?: PageFeaturedImage | null;
  publishedAt: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

// Recursive Navigation Item - supports unlimited nesting depth
export interface NavigationItem {
  id?: string;
  title: string;
  href?: string;
  openInNewTab?: boolean;
  subMenu?: NavigationItem[];
}

// Flat navigation item - for normalized API response
export interface FlatNavigationItem {
  id: string;
  title: string;
  href: string | null;
  openInNewTab?: boolean;
  parentId: string | null;
  childIds: string[];
  depth: number;
  sortOrder: number;
}

// Recursive Footer Menu Link - supports nested subMenu
export interface FooterMenuLink {
  id?: string;
  title: string;
  href?: string;
  openInNewTab?: boolean;
  subMenu?: FooterMenuLink[];
}

// Footer Menu - supports both nested (links) and flat (items/rootIds) structures
export interface FooterMenu {
  id: string;
  title: string;
  // Nested format (legacy/converted)
  links?: FooterMenuLink[];
  // Flat format (new backend response)
  items?: Record<string, FlatNavigationItem>;
  rootIds?: string[];
}

// Social Link - supports custom labels and icons
export interface SocialLink {
  id?: string;
  label: string;
  url: string;
  iconUrl?: string;
  // Legacy fields for backwards compatibility
  platform?: string;
  icon?: string;
}

export interface HeaderData {
  topBar: {
    text: string;
    isEnabled?: boolean;
  };
  logo: { src: string; alt: string; width?: number };
  favicon?: { src: string; alt: string };
  contact: {
    phone: string;
    text: string;
    isEnabled?: boolean;
  };
  social: SocialLink[];
}

export interface FooterData {
  logo: { src: string; alt: string };
  favicon?: { src: string; alt: string };
  tagline: string;
  copyrightText: string;
  description?: string;
  menus: FooterMenu[];
  social: SocialLink[];
}

export interface SeoSettings {
  siteTitle: string | null;
  homepageTitle: string | null;
  homepageMetaDescription: string | null;
  robotsTxt: string | null;
  discovery?: SeoDiscoverySettings;
}

// ---------------------------------------------------------------------------
// Order & Cart Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

export interface OrderItem {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  productName: string | null;
  productImage: string | null;
  variantLabel: string | null;
  unitPriceMinor?: number | null;
  lineSubtotalMinor?: number | null;
  discountAmountMinor?: number | null;
  taxableAmountMinor?: number | null;
  taxAmountMinor?: number;
}

export type OrderReceiptSupportRequestType =
  "cancel_pre_shipment" | "return" | "refund";

export interface OrderReceiptSupportRequest {
  id: string;
  orderId: string;
  customerId: string | null;
  type: OrderReceiptSupportRequestType;
  status: string;
  active: boolean;
  severity: "info" | "success" | "warning" | "danger";
  label: string;
  actionLabel: string;
  reason: string;
  message: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface OrderReceiptSupportRequestAction {
  type: OrderReceiptSupportRequestType;
  label: string;
  description: string;
  eligible: boolean;
  disabledReason: string | null;
}

export interface OrderReceipt {
  id: string;
  customerName: string;
  shippingAddress: string;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number | null;
  currencyCode?: string | null;
  currencyDecimalPlaces?: number | null;
  subtotalAmountMinor?: number | null;
  shippingAmountMinor?: number | null;
  discountAmountMinor?: number | null;
  taxAmountMinor?: number;
  totalAmountMinor?: number | null;
  taxLabel?: string | null;
  pricesIncludeTax?: boolean;
  city: string;
  zone: string;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  status: string;
  paymentMethod: string | null;
  paymentStatus: string;
  paidAmount: number;
  balanceDue: number;
  createdAt: string | null;
  updatedAt: string | null;
  items: OrderItem[];
  supportRequests: OrderReceiptSupportRequest[];
  supportRequestActions: OrderReceiptSupportRequestAction[];
  supportRequestIntro: string;
}

export type CreateOrderPayload = OrderPostRequest;

// ---------------------------------------------------------------------------
// Other Types (local domain types — SDK only has response wrappers)
// ---------------------------------------------------------------------------

export interface LocationData {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface ShippingMethod {
  id: string;
  name: string;
  fee: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Discount {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  minPurchaseAmount?: number | null;
  combineWithProductDiscounts?: boolean;
  combineWithOrderDiscounts?: boolean;
  combineWithShippingDiscounts?: boolean;
}

export interface DiscountValidationResponse {
  valid: boolean;
  error?: string;
  discount?: Discount;
  discountAmount?: number;
  minPurchaseAmount?: number;
  minQuantity?: number;
  requiresCustomerPhone?: boolean;
}

export interface AnalyticsConfig {
  id: string;
  type: string;
  usePartytown: boolean;
  config: string;
  location: string;
}

export interface SearchResults {
  products: Product[];
  categories: Category[];
  pages: Page[];
  success: boolean;
  query: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Checkout Language Types (local domain type — SDK only has response wrappers)
// ---------------------------------------------------------------------------

export interface CheckoutLanguageData {
  id: string;
  name: string;
  code: string;
  languageData: {
    pageTitle: string;
    checkoutSectionTitle: string;
    cartSectionTitle: string;
    customerNameLabel: string;
    customerNamePlaceholder: string;
    customerPhoneLabel: string;
    customerPhonePlaceholder: string;
    customerPhoneHelp: string;
    customerEmailLabel: string;
    customerEmailPlaceholder: string;
    shippingAddressLabel: string;
    shippingAddressPlaceholder: string;
    cityLabel: string;
    zoneLabel: string;
    areaLabel: string;
    shippingMethodLabel: string;
    orderNotesLabel: string;
    orderNotesPlaceholder: string;
    continueShoppingText: string;
    subtotalText: string;
    shippingText: string;
    discountText: string;
    totalText: string;
    discountCodePlaceholder: string;
    applyDiscountText: string;
    removeDiscountText: string;
    placeOrderText: string;
    processingText: string;
    emptyCartText: string;
    termsText: string;
    processingOrderTitle: string;
    processingOrderMessage: string;
    requiredFieldIndicator: string;
  };
  fieldVisibility: {
    showEmailField: boolean;
    showOrderNotesField: boolean;
    showAreaField: boolean;
  };
  isActive: boolean;
  isDefault: boolean;
}
